import { z } from "zod";

import type { Workspace } from "../core/apply/workspace.js";
import { RadianceError } from "../core/logger.js";
import { harnessDebug, writeHarnessFailure } from "./diagnostics.js";
import { buildProjectContracts } from "./contracts.js";
import { anchorFiles } from "./retrieval.js";
import {
  readSnippets,
  type FileSnippet,
  type ProjectContext,
} from "./context.js";
import { extractJson, type LlmClient } from "./llm.js";
import { CONSTITUTION, batchEditPrompt } from "./prompts.js";
import type { Plan } from "./plan.js";
import { editFile, type EditResult } from "./edit.js";

const BatchFileSchema = z.object({
  path: z.string(),
  contents: z.string(),
  notes: z.string().nullable().default(null),
});

const BatchEditSchema = z.object({
  files: z.array(BatchFileSchema),
});

/** Deduplicates and caps reference snippets across all planned files. */
async function batchReferenceSnippets(
  context: ProjectContext,
  planReferences: string[],
): Promise<FileSnippet[]> {
  const paths = [
    ...new Set([...anchorFiles(context.files), ...planReferences]),
  ].slice(0, 8);
  return readSnippets(context.root, paths);
}

/**
 * Writes all planned files in a single LLM call.
 *
 * Falls back to per-file serial editing if the batch call fails or the response does not
 * cover all planned paths.
 */
export async function batchEditFiles(
  client: LlmClient,
  context: ProjectContext,
  workspace: Workspace,
  request: string,
  plan: Plan,
  planReferences: string[],
): Promise<EditResult[]> {
  const projectContracts = await buildProjectContracts(
    context.root,
    context.files,
  );

  if (plan.files.length === 1) {
    // Single-file plans don't benefit from batching — use the regular path.
    return serialFallback(
      client,
      context,
      workspace,
      request,
      plan,
      planReferences,
      projectContracts,
    );
  }

  const references = await batchReferenceSnippets(context, planReferences);

  const filesWithCurrent = await Promise.all(
    plan.files.map(async (file) => ({
      file,
      current: await workspace.read(file.path),
    })),
  );

  // Validate modify targets exist before calling the LLM.
  for (const { file, current } of filesWithCurrent) {
    if (file.action === "modify" && current === null) {
      throw new RadianceError(
        `The plan wanted to modify ${file.path}, which does not exist`,
        "Re-run the prompt, or create the file first.",
      );
    }
  }

  const prompt = batchEditPrompt(
    context,
    request,
    plan,
    filesWithCurrent,
    references,
    projectContracts,
  );

  harnessDebug(`batch edit: ${plan.files.length} files`);

  let raw: string;
  try {
    raw = await client.complete(
      [
        { role: "system", content: CONSTITUTION },
        { role: "user", content: prompt },
      ],
      { json: true, maxTokens: 32_000 },
    );
  } catch (error) {
    harnessDebug(
      `batch edit failed, falling back to serial: ${error instanceof Error ? error.message : error}`,
    );
    return serialFallback(
      client,
      context,
      workspace,
      request,
      plan,
      planReferences,
      projectContracts,
    );
  }

  harnessDebug(`batch edit: parsing ${raw.length} chars`);

  let data: unknown;
  try {
    data = extractJson(raw);
  } catch {
    harnessDebug("batch edit: JSON parse failed, falling back to serial");
    await writeHarnessFailure(context.root, {
      stage: "edit",
      path: "(batch)",
      provider: client.provider,
      model: client.model,
      request,
      error: "Batch edit returned malformed JSON",
      raw,
    }).catch(() => undefined);
    return serialFallback(
      client,
      context,
      workspace,
      request,
      plan,
      planReferences,
      projectContracts,
    );
  }

  const parsed = BatchEditSchema.safeParse(data);
  if (!parsed.success) {
    harnessDebug("batch edit: schema mismatch, falling back to serial");
    return serialFallback(
      client,
      context,
      workspace,
      request,
      plan,
      planReferences,
      projectContracts,
    );
  }

  const resultMap = new Map(parsed.data.files.map((f) => [f.path, f]));
  const plannedPaths = new Set(plan.files.map((f) => f.path));
  const covered = [...plannedPaths].filter((p) => resultMap.has(p));

  if (covered.length < plan.files.length) {
    harnessDebug(
      `batch edit: only ${covered.length}/${plan.files.length} files returned, falling back to serial`,
    );
    return serialFallback(
      client,
      context,
      workspace,
      request,
      plan,
      planReferences,
      projectContracts,
    );
  }

  const results: EditResult[] = [];

  for (const plannedFile of plan.files) {
    const item = resultMap.get(plannedFile.path)!;
    const contents = normalize(item.contents);

    if (contents.trim().length === 0) {
      harnessDebug(
        `batch edit: empty contents for ${plannedFile.path}, falling back to serial`,
      );
      return serialFallback(
        client,
        context,
        workspace,
        request,
        plan,
        planReferences,
        projectContracts,
      );
    }

    await workspace.write(plannedFile.path, contents, "prompt");
    results.push({ path: plannedFile.path, notes: item.notes });
  }

  return results;
}

/** Reference snippets for a single file edit — used by the serial fallback path. */
async function singleFileReferences(
  context: ProjectContext,
  planReferences: string[],
  exclude: string,
): Promise<FileSnippet[]> {
  const paths = [...new Set([...anchorFiles(context.files), ...planReferences])]
    .filter((p) => p !== exclude)
    .slice(0, 8);
  return readSnippets(context.root, paths);
}

async function serialFallback(
  client: LlmClient,
  context: ProjectContext,
  workspace: Workspace,
  request: string,
  plan: Plan,
  planReferences: string[],
  projectContracts: string | null,
): Promise<EditResult[]> {
  const results: EditResult[] = [];

  for (const file of plan.files) {
    const snippets = await singleFileReferences(
      context,
      planReferences,
      file.path,
    );
    const result = await editFile(
      client,
      context,
      workspace,
      request,
      plan,
      file,
      snippets,
      projectContracts,
    );
    results.push(result);
  }

  return results;
}

function normalize(contents: string): string {
  const fenced = contents.match(/^```[a-z]*\n([\s\S]*?)\n```\s*$/);
  const body = (fenced?.[1] ?? contents).replace(/\r\n/g, "\n").trimEnd();
  return `${body}\n`;
}
