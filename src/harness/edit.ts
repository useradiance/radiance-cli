import { z } from "zod";

import type { Workspace } from "../core/apply/workspace.js";
import { RadianceError } from "../core/logger.js";
import {
  harnessDebug,
  withDumpHint,
  writeHarnessFailure,
} from "./diagnostics.js";
import { buildProjectContracts } from "./contracts.js";
import { anchorFiles, type FileMatch } from "./retrieval.js";
import {
  readSnippets,
  type FileSnippet,
  type ProjectContext,
} from "./context.js";
import { extractJson, type LlmClient } from "./llm.js";
import { CONSTITUTION, editPrompt, repairPrompt } from "./prompts.js";
import type { Plan, PlannedFile } from "./plan.js";

const EditSchema = z.object({
  contents: z.string(),
  notes: z.string().nullable().default(null),
});

export type EditResult = {
  path: string;
  notes: string | null;
};

/** Reference files given to every edit: the project's own conventions, plus what the planner read. */
export async function referenceSnippets(
  context: ProjectContext,
  planReferences: string[],
  exclude: string[],
): Promise<FileSnippet[]> {
  const paths = [...new Set([...anchorFiles(context.files), ...planReferences])]
    .filter((path) => !exclude.includes(path))
    .slice(0, 8);

  return readSnippets(context.root, paths);
}

/**
 * Writes one planned file into the staging workspace.
 *
 * The model is asked for the whole file rather than a patch: full contents are verifiable
 * (they either parse and typecheck or they do not), and the workspace still produces a
 * line-level diff for the user to approve.
 */
export async function editFile(
  client: LlmClient,
  context: ProjectContext,
  workspace: Workspace,
  request: string,
  plan: Plan,
  file: PlannedFile,
  references: FileSnippet[],
  projectContracts: string | null = null,
): Promise<EditResult> {
  const current = await workspace.read(file.path);

  if (file.action === "modify" && current === null) {
    throw new RadianceError(
      `The plan wanted to modify ${file.path}, which does not exist`,
      "Re-run the prompt, or create the file first.",
    );
  }

  const contracts =
    projectContracts ??
    (await buildProjectContracts(context.root, context.files));

  const raw = await client.complete(
    [
      { role: "system", content: CONSTITUTION },
      {
        role: "user",
        content: editPrompt(
          context,
          request,
          plan,
          file,
          current,
          references,
          contracts,
        ),
      },
    ],
    { json: true, maxTokens: 16_000 },
  );

  harnessDebug(`edit ${file.path}: parsing ${raw.length} chars`);

  let data: unknown;
  try {
    data = extractJson(raw);
  } catch (error) {
    throw await dumpEditFailure(
      context.root,
      client,
      request,
      file.path,
      raw,
      error,
    );
  }

  const parsed = EditSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw await dumpEditFailure(
      context.root,
      client,
      request,
      file.path,
      raw,
      new RadianceError(
        `The model returned an unusable edit for ${file.path}`,
        issues,
      ),
    );
  }

  const contents = normalize(parsed.data.contents);
  if (contents.trim().length === 0) {
    throw new RadianceError(`The model returned an empty ${file.path}`);
  }

  await workspace.write(file.path, contents, "prompt");
  return { path: file.path, notes: parsed.data.notes };
}

async function dumpEditFailure(
  root: string,
  client: LlmClient,
  request: string,
  path: string,
  raw: string,
  error: unknown,
): Promise<RadianceError> {
  const radianceError =
    error instanceof RadianceError
      ? error
      : new RadianceError(
          error instanceof Error ? error.message : `Edit failed for ${path}`,
        );

  const dumpPath = await writeHarnessFailure(root, {
    stage: "edit",
    path,
    provider: client.provider,
    model: client.model,
    request,
    error: radianceError.message,
    hint: radianceError.hint,
    raw,
  });

  return withDumpHint(radianceError, dumpPath);
}

export async function repairFile(
  client: LlmClient,
  workspace: Workspace,
  path: string,
  errors: string,
  references: FileSnippet[],
  projectContracts: string | null = null,
): Promise<boolean> {
  const contents = await workspace.read(path);
  if (contents === null) return false;

  const raw = await client.complete(
    [
      { role: "system", content: CONSTITUTION },
      {
        role: "user",
        content: repairPrompt(
          { path, contents },
          errors,
          references,
          projectContracts,
        ),
      },
    ],
    { json: true, maxTokens: 16_000 },
  );

  harnessDebug(`repair ${path}: parsing ${raw.length} chars`);

  let data: unknown;
  try {
    data = extractJson(raw);
  } catch (error) {
    const message =
      error instanceof RadianceError ? error.message : "malformed repair JSON";
    harnessDebug(`repair ${path} skipped: ${message}`);
    await writeHarnessFailure(workspace.root, {
      stage: "repair",
      path,
      provider: client.provider,
      model: client.model,
      error: message,
      hint: error instanceof RadianceError ? error.hint : undefined,
      raw,
    }).catch(() => undefined);
    return false;
  }

  const parsed = EditSchema.safeParse(data);
  if (!parsed.success) {
    harnessDebug(`repair ${path} skipped: schema mismatch`);
    return false;
  }

  const next = normalize(parsed.data.contents);
  if (next.trim().length === 0 || next === contents) return false;

  await workspace.write(path, next, "prompt:repair");
  return true;
}

/** Strips stray code fences and guarantees a trailing newline. */
function normalize(contents: string): string {
  const fenced = contents.match(/^```[a-z]*\n([\s\S]*?)\n```\s*$/);
  const body = (fenced?.[1] ?? contents).replace(/\r\n/g, "\n").trimEnd();
  return `${body}\n`;
}

export function highestScoring(matches: FileMatch[], limit: number): string[] {
  return matches.slice(0, limit).map((match) => match.path);
}
