import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { RadianceError } from "../core/logger.js";
import { buildProjectContracts } from "./contracts.js";
import type { ProjectContext } from "./context.js";
import { harnessDebug, writeHarnessFailure } from "./diagnostics.js";
import { extractJson, type LlmClient } from "./llm.js";
import { PlanSchema, validatePlan, type Plan } from "./plan.js";
import { fastEditPrompt } from "./prompts.js";
import { matchFiles, matchModules } from "./retrieval.js";
import { CONSTITUTION } from "./prompts.js";

/**
 * The fast prompt path: one LLM call that plans and writes in the same turn.
 *
 * The default path makes two sequential calls — plan, then edit — because the
 * plan is what decides *which* files' contents the edit call needs to see. That
 * ordering costs a whole round trip: measured at 19s of a 75s run, with the
 * edit call a further 34s.
 *
 * This removes the round trip by paying for it in input tokens instead: the
 * most relevant files are sent with their full contents up front, and the model
 * chooses among them and writes the result in one response. Input tokens are far
 * cheaper and far faster than the round trip they replace — the model reads a
 * file it turns out not to need much faster than we can ask it twice.
 *
 * What is given up is real: the default path lets the planner reason about the
 * whole change before writing any of it, and re-ranks references with the plan
 * in hand. For a large or vague request that is worth 19s. For "add an About
 * screen" it is not, which is why this is the platform default and the slower
 * path is a toggle rather than the reverse.
 */

/** Files sent with full contents. Input is cheap; a missing file is a wasted run. */
const CANDIDATE_FILES = 12;

/** Above this, a single file is summarised rather than sent whole. */
const MAX_FILE_CHARS = 16_000;

const FastFileSchema = z.object({
  path: z.string(),
  action: z.enum(["create", "modify"]),
  /** One line on what this file does in the change; becomes the plan intent. */
  summary: z.string().nullable().default(null),
  contents: z.string(),
  notes: z.string().nullable().default(null),
});

const FastResponseSchema = z.object({
  summary: z.string(),
  modules: z.array(z.string()).default([]),
  locales: z.array(z.string()).default([]),
  files: z.array(FastFileSchema).default([]),
  deferred: z.array(z.string()).default([]),
  followUpPrompt: z.string().nullable().default(null),
});

export type FastCandidate = { path: string; contents: string };

export type FastWrite = {
  path: string;
  contents: string;
  notes: string | null;
};

export type FastResult = {
  /**
   * A Plan built from what the model actually did.
   *
   * The rest of the command — the run record, the follow-up offer, the module
   * staging — is written against `Plan`, and the fast path has no reason to
   * fork any of that. It produces the same shape from a different number of
   * calls.
   */
  plan: Plan;
  /** Paths whose contents were supplied, reusable as repair references. */
  references: string[];
  /**
   * The files to write, NOT yet written.
   *
   * Staging a catalogue module replaces the workspace, so anything written
   * before that point is discarded. The caller writes these afterwards, at the
   * same place the default path writes its batch edit.
   */
  files: FastWrite[];
  notes: string[];
};

/** Read the candidates the model gets to see in full. */
export async function readCandidates(
  context: ProjectContext,
  paths: string[],
): Promise<FastCandidate[]> {
  const out: FastCandidate[] = [];
  for (const path of paths) {
    const contents = await readFile(join(context.root, path), "utf8").catch(
      () => null,
    );
    if (contents === null) continue;
    out.push({
      path,
      contents:
        contents.length > MAX_FILE_CHARS
          ? `${contents.slice(0, MAX_FILE_CHARS)}\n/* … truncated … */`
          : contents,
    });
  }
  return out;
}

/**
 * Plan and write in one call, staging the result into `workspace`.
 *
 * Returns the equivalent `Plan` so the caller's reporting, run record and
 * follow-up handling are identical to the default path.
 */
export async function fastEdit(
  client: LlmClient,
  context: ProjectContext,
  request: string,
): Promise<FastResult> {
  const installed = new Set(
    context.project.features.map((feature) => feature.id),
  );
  const moduleMatches = matchModules(
    context.source.registry,
    request,
    installed,
  );
  const fileMatches = await matchFiles(
    context.root,
    context.files,
    request,
    CANDIDATE_FILES,
  );
  const candidates = await readCandidates(
    context,
    fileMatches.map((match) => match.path),
  );
  const projectContracts = await buildProjectContracts(
    context.root,
    context.files,
  );

  harnessDebug(`fast edit: ${candidates.length} candidate file(s) in context`);

  const raw = await client.complete(
    [
      { role: "system", content: CONSTITUTION },
      {
        role: "user",
        content: fastEditPrompt(
          context,
          request,
          moduleMatches,
          candidates,
          projectContracts,
        ),
      },
    ],
    { json: true, maxTokens: 32_000 },
  );

  harnessDebug(`fast edit: parsing ${raw.length} chars`);

  let data: unknown;
  try {
    data = extractJson(raw);
  } catch (error) {
    const dump = await writeHarnessFailure(context.root, {
      stage: "edit",
      path: "(fast)",
      provider: client.provider,
      model: client.model,
      request,
      raw,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new RadianceError(
      "The model's response was not valid JSON",
      `Raw response saved to ${dump}. Re-run, or use --effort high.`,
    );
  }

  const parsed = FastResponseSchema.safeParse(data);
  if (!parsed.success) {
    const dump = await writeHarnessFailure(context.root, {
      stage: "edit",
      path: "(fast)",
      provider: client.provider,
      model: client.model,
      request,
      raw,
      error: parsed.error.message,
    });
    throw new RadianceError(
      "The model's response did not match the expected shape",
      `Raw response saved to ${dump}. Re-run, or use --effort high.`,
    );
  }

  const response = parsed.data;

  // Reuse the planner's guards rather than writing a second, weaker set: the
  // same protected paths and file-count ceiling apply however the plan was
  // produced. A file dropped here is a file never written.
  const asPlan = validatePlan(
    PlanSchema.parse({
      summary: response.summary,
      modules: response.modules,
      locales: response.locales,
      files: response.files.map((file) => ({
        path: file.path,
        action: file.action,
        intent: file.summary ?? response.summary,
        typeContracts: null,
      })),
      deferred: response.deferred,
      followUpPrompt: response.followUpPrompt,
    }),
    context,
  );

  const allowed = new Set(asPlan.files.map((file) => file.path));
  const notes: string[] = [];
  const files: FastWrite[] = [];

  for (const file of response.files) {
    if (!allowed.has(file.path)) {
      // validatePlan rejected it (protected path, traversal). Say so rather
      // than dropping it silently — the user asked for something they did not get.
      notes.push(`${file.path}: refused — this file is not editable by a prompt.`);
      continue;
    }
    files.push({ path: file.path, contents: file.contents, notes: file.notes });
    if (file.notes) notes.push(`${file.path}: ${file.notes}`);
  }

  return {
    plan: asPlan,
    references: candidates.map((candidate) => candidate.path),
    files,
    notes,
  };
}
