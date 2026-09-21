import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  authChoicesToProviderIds,
  buildAuthProvidersConfig,
  unsupportedAuthProviders,
} from "./firebase-auth.js";
import { assertReadyForDeploy } from "./config-gate.js";
import {
  assertFirebaseCli,
  ensureDefaultFirestoreDatabase,
  resolveLinkedFirebaseProjectId,
} from "./firebase-cli.js";
import { RadianceError, ui } from "./logger.js";
import {
  readProjectConfig,
  type ProjectConfig,
  type ProjectPlan,
} from "./project.js";

/** Default attempts including the first try (4 retries after a failure). */
export const FIREBASE_DEPLOY_MAX_ATTEMPTS = 5;

/**
 * Pause before the first deploy — freshly created projects almost always 403 on Rules/IAM
 * for a few seconds after APIs are enabled.
 */
export const FIREBASE_DEPLOY_INITIAL_DELAY_MS = 5_000;

/** Backoff between attempts — fresh projects often need ~30–60s for IAM/Rules API. */
export const FIREBASE_DEPLOY_BACKOFF_MS = [
  5_000, 10_000, 20_000, 40_000,
] as const;

const RETRYABLE_DEPLOY_PATTERNS: RegExp[] = [
  /http error:\s*403\b/i,
  /http error:\s*429\b/i,
  // Fresh projects: rules compile, then indexes 404 until `(default)` exists / finishes creating.
  /http error:\s*404\b/i,
  /database ['`]?\(default\)['`]? does not exist/i,
  /or database ['`]?\(default\)['`]? does not exist/i,
  /the caller does not have permission/i,
  /permission[_ ]denied/i,
  /caller does not have required permission/i,
  /resource.?exhausted/i,
  /rate.?limit/i,
  /quota.?exceeded/i,
  /has not been used in project/i,
  /api .+ is not enabled/i,
  /is not enabled for (the )?project/i,
  /try again (in a few minutes|later)/i,
  /temporarily unavailable/i,
  /\bunavailable\b/i,
  /backend error/i,
  /service is currently unavailable/i,
  /could not load the default credentials/i,
];

/**
 * Detects transient Firebase/GCP failures that often clear after IAM or API enablement propagates.
 */
export function isRetryableFirebaseDeployFailure(output: string): boolean {
  return RETRYABLE_DEPLOY_PATTERNS.some((pattern) => pattern.test(output));
}

export type FirebaseDeployOptions = {
  projectId?: string;
  /** Total tries including the first (default {@link FIREBASE_DEPLOY_MAX_ATTEMPTS}). */
  maxAttempts?: number;
  /**
   * Wait before attempt 1. Default `0` — only first-time provision should pass
   * {@link FIREBASE_DEPLOY_INITIAL_DELAY_MS}; routine `deploy` / redeploy skip it.
   */
  initialDelayMs?: number;
  /** Delay before each retry; falls back to the last entry when exhausted. */
  backoffMs?: readonly number[];
  /** Test seam — replace the sleep between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — replace the firebase CLI invocation. */
  run?: (
    args: string[],
    options: { cwd: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

async function runFirebaseDeployOnce(
  root: string,
  args: string[],
  run: NonNullable<FirebaseDeployOptions["run"]>,
): Promise<{ exitCode: number; output: string }> {
  const result = await run(args, { cwd: root });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (output) {
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  }
  return { exitCode: result.exitCode, output };
}

async function defaultFirebaseRun(
  args: string[],
  options: { cwd: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa("firebase", args, {
    cwd: options.cwd,
    reject: false,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function firebaseDeploy(
  root: string,
  targets: string[],
  options: FirebaseDeployOptions = {},
): Promise<void> {
  if (targets.length === 0) return;

  const args = ["deploy", "--only", targets.join(",")];
  if (options.projectId) args.push("--project", options.projectId);

  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? FIREBASE_DEPLOY_MAX_ATTEMPTS,
  );
  const initialDelayMs = options.initialDelayMs ?? 0;
  const backoff = options.backoffMs ?? FIREBASE_DEPLOY_BACKOFF_MS;
  const sleep = options.sleep ?? delay;
  const run = options.run ?? defaultFirebaseRun;

  let lastOutput = "";

  if (initialDelayMs > 0) {
    ui.detail(
      `Waiting ${Math.round(initialDelayMs / 1000)}s for Firebase IAM/API propagation before deploy…`,
    );
    ui.trace(`firebase deploy initial delay ${initialDelayMs}ms`);
    await sleep(initialDelayMs);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const waitMs =
        backoff[Math.min(attempt - 2, backoff.length - 1)] ??
        backoff.at(-1) ??
        5_000;
      ui.warn(
        `Firebase deploy hit a transient error — retrying in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt}/${maxAttempts})…`,
      );
      ui.trace(`firebase deploy retry wait ${waitMs}ms`);
      await sleep(waitMs);
      ui.step(`Retrying firebase deploy (${targets.join(", ")})`);
    }

    ui.trace(`firebase ${args.join(" ")} (attempt ${attempt}/${maxAttempts})`);
    const { exitCode, output } = await runFirebaseDeployOnce(root, args, run);
    lastOutput = output;

    if (exitCode === 0) {
      if (attempt > 1) ui.success("Firebase deploy succeeded after retry");
      return;
    }

    const retryable = isRetryableFirebaseDeployFailure(output);
    ui.trace(
      `firebase deploy failed exit=${exitCode} retryable=${retryable} ` +
        `outputChars=${output.length}`,
    );

    if (!retryable || attempt === maxAttempts) {
      throw new RadianceError(
        "firebase deploy failed",
        retryable
          ? `Still failing after ${maxAttempts} attempts (likely IAM propagation). Wait a minute and retry with \`radiance setup firebase\` or \`radiance deploy --rules\`.`
          : "See the output above.",
      );
    }
  }

  throw new RadianceError(
    "firebase deploy failed",
    lastOutput.slice(0, 500) || "See the output above.",
  );
}

async function readFirebaseJson(
  root: string,
): Promise<Record<string, unknown>> {
  const path = join(root, "firebase.json");
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function authProviderIdsFromProject(project: ProjectConfig): string[] {
  const auth = project.features.find((feature) => feature.id === "auth");
  if (!auth) return [];

  const raw = auth.options.providers;
  const choices = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? [raw]
      : [];
  return authChoicesToProviderIds(choices);
}

/**
 * Writes `firebase.json` auth.providers from the installed auth module options,
 * filling Google Sign-In support email from the logged-in Firebase account.
 */
export async function syncAuthConfigFromProject(
  root: string,
  meta: { appName: string; supportEmail: string },
): Promise<string[]> {
  const project = await readProjectConfig(root);
  const providerIds = authProviderIdsFromProject(project);
  if (providerIds.length === 0) return [];

  const authConfig = buildAuthProvidersConfig(providerIds, {
    displayName: meta.appName,
    supportEmail: meta.supportEmail,
  });
  if (!authConfig) return providerIds;

  const firebaseJson = await readFirebaseJson(root);
  const next = {
    ...firebaseJson,
    auth: {
      ...((firebaseJson.auth as Record<string, unknown> | undefined) ?? {}),
      ...authConfig,
    },
  };
  await writeFile(
    join(root, "firebase.json"),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  return providerIds;
}

export type ProvisionOptions = {
  appName: string;
  supportEmail: string;
  /** Defaults to `free` — skips Storage (needs a paid / billed project). */
  plan?: ProjectPlan;
};

/**
 * Targets safe to deploy for a given plan.
 * Free cannot provision Cloud Storage; Functions are never part of initial provision.
 */
export function cloudProvisionTargets(
  root: string,
  plan: ProjectPlan,
  firebaseJson: Record<string, unknown>,
): string[] {
  const targets: string[] = [];
  if (
    existsSync(join(root, "firestore.rules")) ||
    existsSync(join(root, "firestore.indexes.json"))
  ) {
    // Full `firestore` target creates the default DB when missing, then deploys rules/indexes.
    targets.push("firestore");
  }
  if (plan === "paid" && existsSync(join(root, "storage.rules"))) {
    targets.push("storage");
  }

  const authProviders = (
    firebaseJson.auth as { providers?: Record<string, unknown> } | undefined
  )?.providers;
  if (authProviders && Object.keys(authProviders).length > 0)
    targets.push("auth");

  return targets;
}

/** Deploy targets that require a paid (billed) Firebase project. */
export const PAID_DEPLOY_TARGETS = new Set(["storage", "functions"]);

/**
 * Map written project paths to Firebase deploy targets.
 * Used after `radiance prompt` / `add` so cloud rules stay in sync with local files.
 */
export function deployTargetsForChangedPaths(
  paths: string[],
  plan: ProjectPlan,
): { targets: string[]; skipped: string[] } {
  const targets: string[] = [];
  const skipped: string[] = [];

  const touchesFirestore = paths.some(
    (path) =>
      path === "firestore.rules" ||
      path === "firestore.indexes.json" ||
      path.startsWith("firestore."),
  );
  const touchesStorage = paths.some((path) => path === "storage.rules");
  const touchesFunctions = paths.some(
    (path) => path === "functions" || path.startsWith("functions/"),
  );

  if (touchesFirestore) targets.push("firestore");

  if (touchesStorage) {
    if (plan === "paid") targets.push("storage");
    else skipped.push("storage");
  }

  if (touchesFunctions) {
    if (plan === "paid") targets.push("functions");
    else skipped.push("functions");
  }

  return { targets, skipped };
}

export type RedeployCloudArtifactsOptions = {
  plan?: ProjectPlan;
  /** When functions are in the target list, build them before deploy. */
  buildFunctions?: () => Promise<void>;
  /** Skip the IAM settle delay (default for redeploys of an existing project). */
  initialDelayMs?: number;
};

/**
 * Soft-fail redeploy when local Firestore/Storage rules, indexes, or Functions sources changed.
 * No-ops when nothing relevant changed or the project is not linked.
 */
export async function maybeRedeployCloudArtifacts(
  root: string,
  writtenPaths: string[],
  options: RedeployCloudArtifactsOptions = {},
): Promise<{ deployed: string[]; skipped: string[] }> {
  let plan = options.plan;
  if (!plan) {
    try {
      plan = (await readProjectConfig(root)).plan ?? "free";
    } catch {
      plan = "free";
    }
  }

  const selected = deployTargetsForChangedPaths(writtenPaths, plan);
  const skipped = [...selected.skipped];
  let targets = [...selected.targets];

  if (targets.length === 0 && skipped.length === 0) {
    return { deployed: [], skipped: [] };
  }

  for (const target of skipped) {
    ui.detail(
      `Skipped cloud deploy for ${target} (free plan — use emulators locally, or upgrade with \`radiance setup firebase --plan paid\`).`,
    );
  }

  if (targets.length === 0) {
    return { deployed: [], skipped };
  }

  const projectId = await resolveLinkedFirebaseProjectId(root);
  if (!projectId) {
    ui.warn(
      `Backend files changed (${targets.join(", ")}) but no Firebase project is linked — not redeployed.`,
    );
    ui.detail("Run `radiance setup firebase`, then `radiance deploy --rules`.");
    return { deployed: [], skipped: [...skipped, ...targets] };
  }

  try {
    await assertFirebaseCli();
  } catch (error) {
    ui.warn(
      error instanceof Error
        ? error.message
        : "firebase-tools is not available — skip cloud redeploy.",
    );
    ui.detail(
      `Deploy later with \`radiance deploy --${targets.includes("functions") && targets.length === 1 ? "functions" : "rules"}\`.`,
    );
    return { deployed: [], skipped: [...skipped, ...targets] };
  }

  if (targets.includes("functions")) {
    if (!options.buildFunctions) {
      ui.warn(
        "Functions source changed — run `radiance deploy --functions` to publish.",
      );
      skipped.push("functions");
      targets = targets.filter((target) => target !== "functions");
    } else {
      try {
        const project = await readProjectConfig(root);
        await assertReadyForDeploy(root, project, {
          checkClientEnv: false,
          checkFunctions: true,
          projectId,
        });
        await options.buildFunctions();
      } catch (error) {
        ui.warn(
          error instanceof Error
            ? `Functions redeploy skipped: ${error.message}`
            : "Functions redeploy skipped.",
        );
        if (error instanceof RadianceError && error.hint) {
          ui.detail(error.hint);
        }
        ui.detail("Fix config/build, then run `radiance deploy --functions`.");
        skipped.push("functions");
        targets = targets.filter((target) => target !== "functions");
      }
    }
  }

  if (targets.length === 0) {
    return { deployed: [], skipped };
  }

  ui.blank();
  ui.heading(`Redeploying ${targets.join(", ")} (backend files changed)`);

  try {
    await firebaseDeploy(root, targets, {
      projectId,
      // Existing projects do not need the fresh-project IAM settle pause.
      initialDelayMs: options.initialDelayMs ?? 0,
    });
    ui.success(`Redeployed ${targets.join(", ")}`);
    return { deployed: targets, skipped };
  } catch (error) {
    ui.warn(
      error instanceof Error
        ? `Cloud redeploy incomplete: ${error.message}`
        : "Cloud redeploy incomplete.",
    );
    if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
    ui.detail(
      "Retry with `radiance deploy --rules` (add `--functions` if needed).",
    );
    return { deployed: [], skipped: [...skipped, ...targets] };
  }
}

/**
 * Creates the Firestore database (if needed), deploys rules/storage (paid only), and enables
 * Auth providers declared in `firebase.json` — all via firebase-tools, no console clicks.
 *
 * Auth is deployed separately from Firestore so a half-ready DB does not leave sign-in broken.
 */
export async function provisionFirebaseBackend(
  root: string,
  projectId: string,
  meta: ProvisionOptions,
): Promise<{ targets: string[]; pendingApple: string[]; skipped: string[] }> {
  const plan = meta.plan ?? "free";
  const providerIds = await syncAuthConfigFromProject(root, meta);
  const pendingApple = unsupportedAuthProviders(providerIds);

  const firebaseJson = await readFirebaseJson(root);
  const targets = cloudProvisionTargets(root, plan, firebaseJson);
  const skipped: string[] = [];
  if (plan === "free" && existsSync(join(root, "storage.rules"))) {
    skipped.push("storage");
  }

  const wantsFirestore = targets.includes("firestore");
  const wantsAuth = targets.includes("auth");
  const otherTargets = targets.filter(
    (target) => target !== "firestore" && target !== "auth",
  );

  // Only pause for IAM/API settle on a brand-new database — routine deploys skip this.
  let settleMs = 0;

  if (wantsFirestore) {
    ui.detail(
      "Enabling Firestore APIs and ensuring database (default) exists…",
    );
    const dbState = await ensureDefaultFirestoreDatabase(projectId, {
      cwd: root,
    });
    if (dbState === "created") {
      ui.detail(
        "Created Firestore database (default); waiting briefly for it to become ready…",
      );
      await delay(8_000);
      settleMs = FIREBASE_DEPLOY_INITIAL_DELAY_MS;
    }
  }

  // Auth first — email/password must work even if Firestore rules/indexes are still propagating.
  if (wantsAuth) {
    await firebaseDeploy(root, ["auth"], {
      projectId,
      initialDelayMs: settleMs,
    });
    settleMs = 0; // only wait once per provision session
  }

  if (wantsFirestore) {
    await firebaseDeploy(root, ["firestore"], {
      projectId,
      initialDelayMs: settleMs,
    });
    settleMs = 0;
  }

  if (otherTargets.length > 0) {
    await firebaseDeploy(root, otherTargets, {
      projectId,
      initialDelayMs: settleMs,
    });
  }

  return { targets, pendingApple, skipped };
}
