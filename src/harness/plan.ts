import { z } from "zod";

import { RadianceError } from "../core/logger.js";
import {
  harnessDebug,
  withDumpHint,
  writeHarnessFailure,
} from "./diagnostics.js";
import { matchFiles, matchModules } from "./retrieval.js";
import { readSnippets, type ProjectContext } from "./context.js";
import { extractJson, type LlmClient } from "./llm.js";
import { CONSTITUTION, planPrompt } from "./prompts.js";

export const PlannedFileSchema = z.object({
  path: z.string(),
  action: z.enum(["create", "modify"]),
  intent: z.string(),
  typeContracts: z.string().nullable().default(null),
});

export const PlanSchema = z.object({
  summary: z.string(),
  modules: z.array(z.string()).default([]),
  files: z.array(PlannedFileSchema).default([]),
  locales: z.array(z.string()).default([]),
  rules: z.string().nullable().default(null),
  risks: z.array(z.string()).default([]),
  /** Work deliberately left out of this pass (user-visible gaps). */
  deferred: z.array(z.string()).default([]),
  /** Concrete next `radiance prompt` request when deferred work remains. */
  followUpPrompt: z.string().nullable().default(null),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlannedFile = z.infer<typeof PlannedFileSchema>;

const MAX_FILES = 8;

/** Paths the harness refuses to hand to a model, whatever the plan says. */
const PROTECTED = [
  "radiance.json",
  "package.json",
  "yarn.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "app.json",
  ".env",
];

export function validatePlan(plan: Plan, context: ProjectContext): Plan {
  const known = new Set(
    context.source.registry.modules.map((module) => module.id),
  );

  for (const id of plan.modules) {
    if (!known.has(id)) {
      throw new RadianceError(
        `The plan asked for an unknown module "${id}"`,
        "Try rewording the request, or install what you need with `radiance add`.",
      );
    }
  }

  const files = plan.files.filter((file) => {
    const path = file.path.replace(/^\.\//, "");
    if (path.startsWith("..") || path.startsWith("/")) return false;
    if (PROTECTED.includes(path)) return false;
    if (path.includes("node_modules") || path.startsWith(".expo")) return false;
    return true;
  });

  if (files.length > MAX_FILES) {
    throw new RadianceError(
      `The plan touches ${files.length} files, more than the ${MAX_FILES} allowed`,
      "Break the request into smaller steps.",
    );
  }

  return { ...plan, files };
}

export type PlanResult = {
  plan: Plan;
  /** Files shown to the planner, reused as references when editing. */
  references: string[];
};

export async function createPlan(
  client: LlmClient,
  context: ProjectContext,
  request: string,
): Promise<PlanResult> {
  const installed = new Set(
    context.project.features.map((feature) => feature.id),
  );
  const moduleMatches = matchModules(
    context.source.registry,
    request,
    installed,
  );
  const fileMatches = await matchFiles(context.root, context.files, request);
  const references = fileMatches.map((match) => match.path);
  const snippets = await readSnippets(context.root, references.slice(0, 5));

  const raw = await client.complete(
    [
      { role: "system", content: CONSTITUTION },
      {
        role: "user",
        content: planPrompt(context, request, moduleMatches, snippets),
      },
    ],
    { json: true },
  );

  harnessDebug(`plan: parsing ${raw.length} chars`);

  let data: unknown;
  try {
    data = extractJson(raw);
  } catch (error) {
    throw await dumpPlanFailure(context.root, client, request, raw, error);
  }

  const parsed = PlanSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw await dumpPlanFailure(
      context.root,
      client,
      request,
      raw,
      new RadianceError(
        "The model returned a plan Radiance could not read",
        issues,
      ),
    );
  }

  return { plan: validatePlan(parsed.data, context), references };
}

async function dumpPlanFailure(
  root: string,
  client: LlmClient,
  request: string,
  raw: string,
  error: unknown,
): Promise<RadianceError> {
  const radianceError =
    error instanceof RadianceError
      ? error
      : new RadianceError(
          error instanceof Error ? error.message : "Planning failed",
        );

  const dumpPath = await writeHarnessFailure(root, {
    stage: "plan",
    provider: client.provider,
    model: client.model,
    request,
    error: radianceError.message,
    hint: radianceError.hint,
    raw,
  });

  return withDumpHint(radianceError, dumpPath);
}

export function renderPlan(plan: Plan): string {
  const lines = [plan.summary, ""];

  if (plan.modules.length > 0) {
    lines.push("Modules to install:");
    lines.push(...plan.modules.map((id) => `  + ${id}`));
    lines.push("");
  }

  if (plan.files.length > 0) {
    lines.push("Files:");
    lines.push(
      ...plan.files.map(
        (file) =>
          `  ${file.action === "create" ? "+" : "~"} ${file.path} — ${file.intent}`,
      ),
    );
    lines.push("");
  }

  if (plan.rules) {
    lines.push(`Security rules: ${plan.rules}`, "");
  }

  if (plan.risks.length > 0) {
    lines.push("Worth checking:");
    lines.push(...plan.risks.map((risk) => `  - ${risk}`));
  }

  if (plan.deferred.length > 0) {
    if (plan.risks.length > 0) lines.push("");
    lines.push("Left for later:");
    lines.push(...plan.deferred.map((item) => `  - ${item}`));
  }

  const followUp = plan.followUpPrompt?.trim();
  if (followUp) {
    if (plan.deferred.length > 0 || plan.risks.length > 0) lines.push("");
    lines.push("Next prompt:");
    lines.push(`  ${followUp}`);
  }

  return lines.join("\n");
}
