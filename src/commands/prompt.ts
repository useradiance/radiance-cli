import * as prompts from "@clack/prompts";
import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";

import { Workspace } from "../core/apply/workspace.js";
import { applyChanges, reportNotes } from "../core/apply/writer.js";
import { ensureTemplateSource } from "../core/cache.js";
import {
  loadConfig,
  type GlobalConfig,
  type ProviderId,
} from "../core/config.js";
import { maybeRedeployCloudArtifacts } from "../core/firebase-provision.js";
import { deriveVars, stageInstall } from "../core/install.js";
import { RadianceError, bindLogSession, ui } from "../core/logger.js";
import {
  formatInstallHint,
  resolvePackageManager,
  runScriptInDirCommand,
} from "../core/package-manager.js";
import { RUNS_DIR } from "../core/paths.js";
import {
  requireProject,
  writeProjectConfig,
  type ProjectConfig,
} from "../core/project.js";
import { buildContext, readSnippets } from "../harness/context.js";
import { buildProjectContracts } from "../harness/contracts.js";
import {
  harnessDebug,
  withDumpHint,
  withHarnessLogging,
  writeHarnessFailure,
} from "../harness/diagnostics.js";
import { referenceSnippets, repairFile } from "../harness/edit.js";
import { batchEditFiles } from "../harness/batch-edit.js";
import { fastEdit, type FastWrite } from "../harness/fast-edit.js";
import { createClient, type LlmClient } from "../harness/llm.js";
import { offerFollowUpPrompt } from "../harness/follow-up-offer.js";
import { createPlan, renderPlan, type Plan } from "../harness/plan.js";
import { errorsFor, typecheck } from "../harness/verify.js";

export type PromptOptions = {
  yes?: boolean;
  dryRun?: boolean;
  verify?: boolean;
  provider?: string;
  model?: string;
  planOnly?: boolean;
  /**
   * How much work to spend before writing code.
   *
   * "high" plans in one call and writes in another — more deliberate, and the
   * only path that produces `typeContracts` for the editor. "fast" does both in
   * one call, trading that deliberation for a whole round trip.
   */
  effort?: "fast" | "high";
  /** When true, skip offering/running a residual follow-up (nested chain / callers). */
  skipFollowUp?: boolean;
  /** With `-y`, auto-run the residual follow-up once. */
  followUp?: boolean;
};

export async function promptCommand(
  request: string,
  options: PromptOptions,
): Promise<void> {
  const { root, config: project } = await requireProject();
  bindLogSession(root);
  const config = await loadConfig();
  const source = await ensureTemplateSource(config);

  const client = withHarnessLogging(
    createClient(config, harnessOverrides(project, config, options)),
  );
  const context = await buildContext(root, project, source);

  ui.heading(
    `radiance prompt ${pc.dim(`(${client.provider} ${client.model})`)}`,
  );
  ui.trace(`prompt request: ${request}`);
  harnessDebug(`project root ${root}`);

  try {
    await runPrompt(
      root,
      project,
      config,
      source,
      client,
      context,
      request,
      options,
    );
  } catch (error) {
    throw await enrichPromptFailure(root, client, request, error);
  }
}

async function runPrompt(
  root: string,
  project: ProjectConfig,
  config: GlobalConfig,
  source: Awaited<ReturnType<typeof ensureTemplateSource>>,
  client: LlmClient,
  context: Awaited<ReturnType<typeof buildContext>>,
  request: string,
  options: PromptOptions,
): Promise<void> {
  const fast = options.effort === "fast";

  // The fast path writes the files as part of the same call that plans them, so
  // there is nothing to confirm in between and `--plan-only` has no plan to
  // stop at. Fall back rather than silently ignoring the flag.
  const planOnlyNeedsHighEffort = fast && options.planOnly;
  if (planOnlyNeedsHighEffort) {
    ui.info("--plan-only needs a separate planning pass; using --effort high.");
  }

  let workspace = new Workspace(root);
  let updatedProject: ProjectConfig = project;
  const editNotes: string[] = [];

  let plan: Plan;
  let references: string[];
  /** Set on the fast path: files to write once modules have been staged. */
  let fastWrites: FastWrite[] | null = null;

  if (fast && !planOnlyNeedsHighEffort) {
    const spinner = prompts.spinner();
    spinner.start("Planning and writing");
    let result;
    try {
      result = await fastEdit(client, context, request);
    } catch (error) {
      spinner.stop(
        error instanceof Error ? `Failed: ${error.message}` : "Failed",
      );
      throw error;
    }
    const created = result.plan.files.filter((f) => f.action === "create").length;
    const modified = result.plan.files.length - created;
    const parts: string[] = [];
    if (created > 0) parts.push(`${created} created`);
    if (modified > 0) parts.push(`${modified} updated`);
    spinner.stop(
      result.plan.files.length === 0
        ? "Nothing to change"
        : `${result.plan.files.length} file(s): ${parts.join(", ")}`,
    );
    plan = result.plan;
    references = result.references;
    editNotes.push(...result.notes);
    fastWrites = result.files;
  } else {
    const spinner = prompts.spinner();
    spinner.start("Checking the catalogue and planning");

    let planned;
    try {
      planned = await createPlan(client, context, request);
    } catch (error) {
      spinner.stop(
        error instanceof Error
          ? `Planning failed: ${error.message}`
          : "Planning failed",
      );
      throw error;
    }
    spinner.stop("Plan ready");
    plan = planned.plan;
    references = planned.references;
  }

  ui.blank();
  console.log(renderPlan(plan));

  if (options.planOnly) return;

  if (plan.modules.length === 0 && plan.files.length === 0) {
    ui.blank();
    ui.info("Nothing to change.");
    return;
  }

  if (!options.yes) {
    const proceed = await prompts.confirm({
      message: "Go ahead with this plan?",
    });
    if (prompts.isCancel(proceed) || !proceed) {
      ui.info("Cancelled.");
      return;
    }
  }

  // Modules are staged into the same workspace the edits use, so generated code can read the
  // files a module just installed and the user sees one combined diff.
  if (plan.modules.length > 0) {
    const staged = await stageInstall({
      root,
      source,
      vars: deriveVars(project.name, {
        themePack: project.themePack,
        defaultLocale: project.defaultLocale,
        bundleId: project.bundleId,
        scheme: project.scheme,
      }),
      scaffold: false,
      starterId: null,
      moduleIds: plan.modules,
      installed: project.features.map((feature) => feature.id),
      existingFeatures: project.features,
    });

    workspace = staged.workspace;
    updatedProject = { ...project, features: staged.features };
    await workspace.write(
      "radiance.json",
      `${JSON.stringify(updatedProject, null, 2)}\n`,
      "radiance",
    );

    ui.success(
      `Reusing catalogue modules: ${staged.manifests.map((m) => m.id).join(", ")}`,
    );
  }

  if (fastWrites) {
    // Written here, after any module staging, because staging swaps the
    // workspace out from under anything written earlier.
    for (const file of fastWrites) {
      await workspace.write(file.path, file.contents, "prompt");
    }
  } else if (plan.files.length > 0) {
    const batchSpinner = prompts.spinner();
    batchSpinner.start(
      plan.files.length === 1
        ? `Writing ${plan.files[0]!.path}`
        : `Writing ${plan.files.length} files`,
    );

    try {
      const results = await batchEditFiles(
        client,
        context,
        workspace,
        request,
        plan,
        references,
      );
      for (const result of results) {
        if (result.notes) editNotes.push(`${result.path}: ${result.notes}`);
      }
      const created = results.filter(
        (r) => plan.files.find((f) => f.path === r.path)?.action === "create",
      ).length;
      const modified = results.length - created;
      const parts: string[] = [];
      if (created > 0) parts.push(`${created} created`);
      if (modified > 0) parts.push(`${modified} updated`);
      batchSpinner.stop(`${results.length} file(s): ${parts.join(", ")}`);
    } catch (error) {
      batchSpinner.stop(
        error instanceof Error
          ? `Failed writing files: ${error.message}`
          : "Failed writing files",
      );
      throw error;
    }
  }

  const changes = workspace.changes();
  const result = await applyChanges(root, changes, {
    confirm: !options.yes,
    dryRun: options.dryRun ?? false,
  });

  reportNotes(workspace.getNotes());

  if (result.cancelled || result.written.length === 0) {
    await saveRun(root, request, plan, "cancelled");
    return;
  }

  if (plan.modules.length > 0) {
    await writeProjectConfig(root, updatedProject);
    const pm = await resolvePackageManager({
      root,
      project: updatedProject.packageManager,
      global: config.packageManager,
    });
    ui.info(
      `Run ${pc.bold(formatInstallHint(pm))} to pick up new packages before starting the app.`,
    );
  }

  if (editNotes.length > 0) {
    ui.heading("Notes from the model");
    for (const note of editNotes) ui.detail(note);
  }

  ui.heading("Verify");
  const verified = await verifyAndRepair(
    client,
    context,
    root,
    config,
    options,
    references,
  );
  const { written: verifyWritten, ...verification } = verified;
  await saveRun(
    root,
    request,
    plan,
    verification.state === "passed" ? "verified" : "applied",
    verification,
  );

  if (!options.dryRun) {
    const writtenPaths = [
      ...result.written.map((change) => change.path),
      ...verifyWritten,
    ];
    await maybeRedeployCloudArtifacts(root, writtenPaths, {
      plan: updatedProject.plan ?? project.plan ?? "free",
      buildFunctions: async () => {
        const pm = await resolvePackageManager({
          root,
          project: updatedProject.packageManager ?? project.packageManager,
          global: config.packageManager,
        });
        ui.step("Building Cloud Functions");
        const { command, args } = runScriptInDirCommand(
          pm,
          "functions",
          "build",
        );
        const build = await execa(command, args, {
          cwd: root,
          stdio: "inherit",
          reject: false,
        });
        if (build.exitCode !== 0) {
          throw new RadianceError(
            "The functions build failed",
            "See the output above.",
          );
        }
      },
    });
  }

  if (config.gitAutoCommit) {
    await commit(root, request);
  }

  await maybeOfferPlanFollowUp(plan, options);
}

async function maybeOfferPlanFollowUp(
  plan: Plan,
  options: PromptOptions,
): Promise<void> {
  if (options.dryRun || options.planOnly) return;
  const followUp = plan.followUpPrompt?.trim();
  if (!followUp) return;

  // `-y` prints only unless `--follow-up`. Nested follow-ups always print-only.
  await offerFollowUpPrompt(followUp, {
    yes: options.yes === true || options.skipFollowUp === true,
    chain: options.followUp === true && options.skipFollowUp !== true,
    heading: "Remaining work from your request",
    confirmMessage:
      "Apply the remaining work now with another `radiance prompt`?",
    run: async (next) => {
      await promptCommand(next, { yes: true, skipFollowUp: true });
    },
  });
}

/** Persist a failure record when plan/edit did not already dump one (e.g. API errors). */
async function enrichPromptFailure(
  root: string,
  client: LlmClient,
  request: string,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof Error)) return error;

  const existingHint = error instanceof RadianceError ? error.hint : undefined;
  if (existingHint?.includes("Diagnostics saved to ")) return error;

  try {
    const dumpPath = await writeHarnessFailure(root, {
      stage: "prompt",
      provider: client.provider,
      model: client.model,
      request,
      error: error.message,
      hint: existingHint,
    });

    if (error instanceof RadianceError) {
      return withDumpHint(error, dumpPath);
    }

    return new RadianceError(error.message, `Diagnostics saved to ${dumpPath}`);
  } catch {
    return error;
  }
}

function harnessOverrides(
  project: ProjectConfig,
  config: GlobalConfig,
  options: PromptOptions,
): Partial<GlobalConfig> {
  const provider = (options.provider ??
    project.harness.provider ??
    config.provider) as ProviderId;
  const model = options.model ?? project.harness.model;

  return { provider, ...(model ? { model } : {}) };
}

/** Compiles the project and lets the model fix its own mistakes a bounded number of times. */
async function verifyAndRepair(
  client: LlmClient,
  context: Awaited<ReturnType<typeof buildContext>>,
  root: string,
  config: GlobalConfig,
  options: PromptOptions,
  references: string[],
): Promise<VerifyOutcome & { written: string[] }> {
  if (options.verify === false || !config.verify)
    return {
      state: "skipped",
      reason: "Verification is turned off.",
      written: [],
    };

  const maxRounds = config.maxFixIterations;
  const projectContracts = await buildProjectContracts(
    context.root,
    context.files,
  );
  const written: string[] = [];

  for (let attempt = 0; attempt <= maxRounds; attempt += 1) {
    const spinner = prompts.spinner();
    spinner.start(
      attempt === 0
        ? "Typechecking"
        : `Typechecking again (after repair round ${attempt}/${maxRounds})`,
    );

    const check = await typecheck(root);

    if (check.skipped) {
      spinner.stop("Typecheck skipped");
      ui.detail(check.reason ?? "");
      return { state: "skipped", reason: check.reason, written };
    }

    if (check.ok) {
      spinner.stop(
        attempt === 0
          ? "Typecheck passed"
          : `Typecheck passed after ${attempt} repair round(s)`,
      );
      return { state: "passed", written };
    }

    if (attempt === maxRounds) {
      spinner.stop(
        `Typecheck still failing after ${maxRounds} repair round(s)`,
      );
      printTypecheckSummary(check, { limit: 20 });
      ui.warn(
        "Fix the remaining errors by hand, or run another prompt describing them.",
      );
      return {
        state: "failed",
        failingFiles: check.failingFiles,
        errorCount: countErrors(check.output),
        errors: firstErrorLines(check.output, 10),
        written,
      };
    }

    const targets = check.failingFiles.slice(0, 4);
    spinner.stop(
      `Typecheck failed in ${check.failingFiles.length} file(s) — repair round ${attempt + 1}/${maxRounds}`,
    );
    printTypecheckSummary(check, { limit: 12, highlight: targets });

    ui.step(
      `Asking ${client.provider}/${client.model} to repair ${targets.length} file(s)` +
        (check.failingFiles.length > targets.length
          ? ` (of ${check.failingFiles.length})`
          : ""),
    );

    const repairWorkspace = new Workspace(root);

    const repairResults = await Promise.all(
      targets.map(async (path) => {
        const snippets = await referenceSnippets(context, references, [path]);
        const errors = errorsFor(check.output, path);
        const ok = await repairFile(
          client,
          repairWorkspace,
          path,
          errors,
          snippets,
          projectContracts,
        );
        return { path, ok };
      }),
    );

    let repaired = 0;
    for (const { path, ok } of repairResults) {
      if (ok) {
        repaired += 1;
        ui.detail(`Repaired ${path}`);
      } else {
        ui.detail(
          `Could not repair ${path} — leaving it for the next round or manual fix.`,
        );
      }
    }

    if (repaired === 0) {
      ui.warn("The model could not repair any of the failing files.");
      printTypecheckSummary(check, { limit: 20 });
      return { ...failureFrom(check), written };
    }

    ui.detail(
      `Prepared ${repaired} repair(s); re-typecheck runs after you apply them.`,
    );

    const repairs = repairWorkspace.changes();
    const applied = await applyChanges(root, repairs, {
      confirm: !options.yes,
      dryRun: false,
    });

    if (applied.cancelled || applied.written.length === 0) {
      ui.warn("Repairs were not applied — stopping verification.");
      return { ...failureFrom(check), written };
    }

    written.push(...applied.written.map((change) => change.path));
  }

  // Unreachable: the loop returns on every path. Reported as skipped rather
  // than passed, so an unforeseen exit can never be mistaken for a clean build.
  return { state: "skipped", reason: "Verification ended early.", written };
}

/** Turn a failing typecheck into the verdict the run record carries. */
function failureFrom(
  check: Awaited<ReturnType<typeof typecheck>>,
): Extract<VerifyOutcome, { state: "failed" }> {
  return {
    state: "failed",
    failingFiles: check.failingFiles,
    errorCount: countErrors(check.output),
    errors: firstErrorLines(check.output, 10),
  };
}

function printTypecheckSummary(
  check: Awaited<ReturnType<typeof typecheck>>,
  options: { limit: number; highlight?: string[] } = { limit: 12 },
): void {
  ui.blank();
  if (check.failingFiles.length > 0) {
    ui.detail("Failing files:");
    for (const path of check.failingFiles.slice(0, 8)) {
      const mark = options.highlight?.includes(path) ? "→" : "-";
      ui.detail(`  ${mark} ${path}`);
    }
    if (check.failingFiles.length > 8) {
      ui.detail(`  … and ${check.failingFiles.length - 8} more`);
    }
  }

  const lines = check.output
    .split("\n")
    .filter(Boolean)
    .slice(0, options.limit);
  if (lines.length > 0) {
    ui.detail("Errors:");
    console.log(pc.dim(lines.map((line) => `  ${line}`).join("\n")));
  }
  ui.blank();
}

/**
 * What verification actually established.
 *
 * Three states, not a boolean. "The typechecker failed" and "the typechecker
 * never ran" are opposite pieces of information, and collapsing them into
 * `ok: false` is what let a run with broken code be reported as a success —
 * the caller could not tell whether anything had been checked at all.
 */
export type VerifyOutcome =
  | { state: "passed" }
  | { state: "skipped"; reason?: string }
  | {
      state: "failed";
      failingFiles: string[];
      errorCount: number;
      /** A few real compiler lines, for whoever has to act on this. */
      errors: string[];
    };

/** `path(1,2): error TS1234: ...` occurrences. */
function countErrors(output: string): number {
  return output
    .split("\n")
    .filter((line) => /^(.+?)\((\d+),(\d+)\): error /.test(line)).length;
}

function firstErrorLines(output: string, limit: number): string[] {
  return output
    .split("\n")
    .filter((line) => /^(.+?)\((\d+),(\d+)\): error /.test(line))
    .slice(0, limit)
    .map((line) => line.trim());
}

async function saveRun(
  root: string,
  request: string,
  plan: Plan,
  outcome: "applied" | "verified" | "cancelled",
  verification?: VerifyOutcome,
): Promise<void> {
  const dir = join(root, RUNS_DIR);
  await mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // `outcome` is kept as it was so existing readers still work; `verification`
  // is the field that says whether the result actually compiles.
  const record = {
    request,
    plan,
    outcome,
    verification,
    at: new Date().toISOString(),
  };

  await writeFile(
    join(dir, `${stamp}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

async function commit(root: string, request: string): Promise<void> {
  try {
    await execa("git", ["add", "-A"], { cwd: root });
    await execa(
      "git",
      ["commit", "--quiet", "-m", `radiance: ${request.slice(0, 72)}`],
      { cwd: root },
    );
    ui.success("Committed the change.");
  } catch {
    ui.warn(
      "Could not commit — do it yourself when you are happy with the result.",
    );
  }
}

export async function explainCommand(): Promise<void> {
  const { root } = await requireProject();
  const snippets = await readSnippets(root, ["RADIANCE.md"]);

  if (snippets.length === 0) {
    throw new RadianceError("No RADIANCE.md in this project");
  }

  console.log(snippets[0]!.contents);
}
