import * as prompts from "@clack/prompts";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";

import {
  assertFirebaseCli,
  createAndroidApp,
  createFirebaseProject,
  createIosApp,
  createWebApp,
  ensureFirebaseLogin,
  ensureDefaultStorageBucket,
  ensureGoogleApiEnabled,
  fetchWebSdkConfig,
  firebaseConsoleStorageUrl,
  getFirebaseAccessToken,
  isValidProjectId,
  listFirebaseProjects,
  listNativeApps,
  listWebApps,
  openInBrowser,
  resolveLinkedFirebaseProjectId,
  suggestProjectId,
  waitForGoogleSignInClientConfig,
  writeNativeGoogleServicesFiles,
  type FirebaseSdkConfig,
} from "../core/firebase-cli.js";
import {
  FIREBASE_ANDROID_APP_ID_KEY,
  FIREBASE_IOS_APP_ID_KEY,
} from "../core/app-distribution.js";
import { applyEnvValues } from "../core/env.js";
import { provisionFirebaseBackend } from "../core/firebase-provision.js";
import {
  CloudBillingError,
  cloudBillingLinkedAccountUrl,
  decideBillingLink,
  getProjectBillingInfo,
  linkProjectBilling,
  listOpenBillingAccounts,
  waitForProjectBilling,
} from "../core/cloud-billing.js";
import { RadianceError, bindLogSession, ui } from "../core/logger.js";
import {
  readProjectConfig,
  requireProject,
  writeProjectConfig,
  type ProjectPlan,
} from "../core/project.js";

export type FirebaseSetupOptions = {
  /** Skip the "want to configure?" confirm — used when init already asked. */
  force?: boolean;
  /** App display name for new projects / web apps. */
  appName?: string;
  /** Skip the free/paid prompt when set (`--plan`). */
  plan?: ProjectPlan;
  /** Pre-select free/paid in the prompt (from init delta). */
  preferredPlan?: ProjectPlan;
  /**
   * Headless / hosted: use this project id. With `createProject`, creates it first.
   * Skips interactive project pickers when set.
   */
  projectId?: string;
  /** When set with `projectId`, run `projects:create` before linking. */
  createProject?: boolean;
  /** Non-interactive: never prompt (requires plan + projectId). */
  yes?: boolean;
};

export const FIREBASE_ENV_KEYS = [
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "EXPO_PUBLIC_FIREBASE_APP_ID",
  "EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID",
] as const;

const EMULATOR_ENV_KEYS = [
  "EXPO_PUBLIC_USE_FIREBASE_EMULATORS",
  "EXPO_PUBLIC_FIREBASE_EMULATOR_HOST",
  "EXPO_PUBLIC_EMULATOR_AUTH",
  "EXPO_PUBLIC_EMULATOR_FIRESTORE",
  "EXPO_PUBLIC_EMULATOR_FUNCTIONS",
  "EXPO_PUBLIC_EMULATOR_STORAGE",
] as const;

/**
 * Interactive Firebase project linking: login → plan → pick/create project → web app →
 * write `.env` + `.firebaserc` (+ eas.json placeholders when present).
 *
 * When a real project is already linked, offers keep-and-retry vs link-a-different-project
 * instead of walking the full create/pick flow again.
 */
export async function setupFirebase(
  root: string,
  options: FirebaseSetupOptions = {},
): Promise<boolean> {
  bindLogSession(root);
  ui.heading("Firebase setup");
  ui.trace(
    `setupFirebase force=${Boolean(options.force)} plan=${options.plan ?? options.preferredPlan ?? "(prompt)"}`,
  );

  const linkedId = await resolveLinkedFirebaseProjectId(root);
  ui.trace(`linked project: ${linkedId ?? "(none)"}`);

  if (!options.force) {
    const proceed = await prompts.confirm({
      message: linkedId
        ? `Firebase is already linked to ${linkedId}. Continue?`
        : "Link a Firebase project and write `.env`?",
      initialValue: true,
    });
    if (prompts.isCancel(proceed) || !proceed) {
      ui.info(
        linkedId
          ? "Skipped. Run `radiance deploy --rules` to retry provisioning, or `radiance setup firebase` to change projects."
          : "Skipped. Run `radiance setup firebase` later, or use the emulators.",
      );
      return false;
    }
  }

  await assertFirebaseCli();

  const spinner = prompts.spinner();
  spinner.start("Checking Firebase login");
  let email: string;
  try {
    email = await ensureFirebaseLogin();
    spinner.stop(`Logged in as ${email}`);
  } catch (error) {
    spinner.stop("Firebase login required");
    throw error;
  }

  const appName = options.appName ?? "radiance-app";
  const projectConfig = await readProjectConfig(root);

  let projectId: string;
  let plan: ProjectPlan;
  let relinked = false;

  if (options.yes) {
    if (!options.plan) {
      throw new RadianceError(
        "Headless Firebase setup requires --plan",
        "Pass `--plan free` or `--plan paid`.",
      );
    }
    if (!options.projectId) {
      throw new RadianceError(
        "Headless Firebase setup requires --project",
        "Pass `--project <id>` (and `--create-project` to create it).",
      );
    }
    plan = options.plan;
    projectId = options.projectId;
    if (options.createProject) {
      ui.detail(`Creating Firebase project ${pc.bold(projectId)}`);
      await createFirebaseProject(projectId, appName);
    }
  } else if (linkedId) {
    const action = await promptLinkedAction(linkedId);
    if (action === "cancel") {
      ui.info("Cancelled.");
      return false;
    }

    if (action === "reuse") {
      projectId = linkedId;
      ui.detail(`Keeping Firebase project ${pc.bold(projectId)}`);
      const resolved = await resolvePlanForReuse(projectConfig.plan, options);
      plan = resolved.plan;
    } else {
      relinked = true;
      plan =
        options.plan ??
        (await promptProjectPlan(options.preferredPlan ?? projectConfig.plan));
      await explainPlan(plan);
      projectId = await resolveProjectId(appName);
    }
  } else {
    plan = options.plan ?? (await promptProjectPlan(options.preferredPlan));
    await explainPlan(plan);
    projectId = await resolveProjectId(appName);
  }

  const sdk = await ensureWebSdk(projectId, appName);
  const nativeAppIds = await ensureNativeApps(
    projectId,
    appName,
    projectConfig.bundleId,
  );

  if (plan === "paid") {
    await guidePaidUpgrade(projectId, { yes: options.yes === true });
  }

  await writeFirebaserc(root, projectId);
  await writeEnvFile(root, sdk, plan, nativeAppIds, {
    yes: options.yes === true,
  });
  await updateEasProjectIds(root, projectId);
  await persistProjectPlan(root, plan);
  await applyStorageRulesPathForPlan(root, plan);

  try {
    const nativeConfigs = await writeNativeGoogleServicesFiles(
      root,
      projectId,
      nativeAppIds,
    );
    if (nativeConfigs.android || nativeConfigs.ios) {
      ui.detail(
        `Wrote ${[
          nativeConfigs.android ? "google-services.json" : null,
          nativeConfigs.ios ? "GoogleService-Info.plist" : null,
        ]
          .filter(Boolean)
          .join(" + ")} for native builds`,
      );
    }
  } catch (error) {
    ui.warn(
      error instanceof Error
        ? `Could not download native Google Services files: ${error.message}`
        : "Could not download native Google Services files.",
    );
    ui.detail(
      "Add google-services.json / GoogleService-Info.plist before `yarn android` / `yarn ios` when using RNFirebase.",
    );
  }

  await runCloudProvision(root, projectId, {
    appName,
    email,
    plan,
    headless: options.yes === true,
  });
  await syncGoogleOAuthClientToEnv(root, projectId);

  ui.blank();
  ui.success(
    linkedId && !relinked
      ? `Using ${pc.bold(projectId)} (${plan} plan)`
      : `Linked ${pc.bold(projectId)} (${plan} plan)`,
  );
  ui.detail(
    "Updated .env, .firebaserc, radiance.json plan, and eas.json project ids",
  );
  if (nativeAppIds.android || nativeAppIds.ios) {
    ui.detail(
      `Native App Distribution ids: Android ${nativeAppIds.android ?? "(none)"}, iOS ${nativeAppIds.ios ?? "(none)"}`,
    );
  }
  if (plan === "free") {
    ui.detail(
      "Storage & Functions: emulators only. `start` boots them automatically with the app.",
    );
    ui.detail("Upgrade later with `radiance setup firebase --plan paid`.");
  } else {
    ui.detail(
      "Deploy Functions with `radiance deploy --functions` when ready.",
    );
  }
  return true;
}

async function promptLinkedAction(
  linkedId: string,
): Promise<"reuse" | "relink" | "cancel"> {
  ui.blank();
  ui.info(`This project is already linked to ${pc.bold(linkedId)}.`);
  const choice = await prompts.select({
    message: "What do you want to do?",
    options: [
      {
        value: "reuse",
        label: `Keep ${linkedId}`,
        hint: "Refresh .env and retry cloud provisioning (rules, Auth, …)",
      },
      {
        value: "relink",
        label: "Link a different project",
        hint: "Pick or create another Firebase project",
      },
      { value: "cancel", label: "Cancel" },
    ],
    initialValue: "reuse",
  });
  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
  return choice as "reuse" | "relink" | "cancel";
}

async function resolvePlanForReuse(
  current: ProjectPlan | undefined,
  options: FirebaseSetupOptions,
): Promise<{ plan: ProjectPlan }> {
  if (options.plan) {
    return { plan: options.plan };
  }

  if (!current) {
    const plan = await promptProjectPlan(options.preferredPlan);
    await explainPlan(plan);
    return { plan };
  }

  const choice = await prompts.select({
    message: "Plan",
    options: [
      {
        value: "keep",
        label: `Keep ${current} plan`,
        hint:
          current === "free"
            ? "Auth/Firestore in cloud; Storage & Functions via emulators"
            : "Cloud Storage & Functions enabled",
      },
      {
        value: "switch",
        label: current === "free" ? "Switch to paid" : "Switch to free",
        hint:
          current === "free"
            ? "Requires a billing account"
            : "Storage & Functions move back to emulators",
      },
    ],
    initialValue: "keep",
  });
  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");

  if (choice === "keep") {
    return { plan: current };
  }

  const plan: ProjectPlan = current === "free" ? "paid" : "free";
  await explainPlan(plan);
  return { plan };
}

async function runCloudProvision(
  root: string,
  projectId: string,
  meta: {
    appName: string;
    email: string;
    plan: ProjectPlan;
    /** No one is watching: a warning here would be a silent failure. */
    headless?: boolean;
  },
): Promise<void> {
  ui.blank();
  ui.step(
    meta.plan === "paid"
      ? "Provisioning Firestore, Storage rules, and Auth providers"
      : "Provisioning Firestore and Auth (Storage stays on emulators)",
  );
  try {
    const { targets, pendingApple, skipped } = await provisionFirebaseBackend(
      root,
      projectId,
      {
        appName: meta.appName,
        supportEmail: meta.email,
        plan: meta.plan,
      },
    );
    if (targets.length > 0) {
      ui.success(`Provisioned: ${targets.join(", ")}`);
    } else {
      ui.detail(
        "Nothing to provision yet (add modules, then re-run setup or deploy).",
      );
    }
    if (skipped.length > 0) {
      ui.detail(
        `Skipped cloud deploy for ${skipped.join(", ")} on the free plan — use emulators locally.`,
      );
    }
    if (pendingApple.length > 0) {
      ui.warn(
        "Apple Sign-In cannot be enabled via firebase-tools yet — enable it in the console, or we can wire the Identity Toolkit API later.",
      );
    }
  } catch (error) {
    ui.warn(
      error instanceof Error
        ? `Cloud provisioning incomplete: ${error.message}`
        : "Cloud provisioning incomplete.",
    );
    if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
    ui.detail(
      "Retry with `radiance setup firebase` (keep the project) or `radiance deploy --rules`.",
    );
    // A warning is the right call when someone is watching: the project is
    // linked and they can retry the rest. Nobody is watching a headless run,
    // and there the same warning becomes a silent lie — the caller sees exit
    // code 0 and reports a backend that has no Firestore, no Auth and no
    // rules behind it.
    if (meta.headless) throw error;
  }
}

/** True when the installed auth module selected Google (or firebase.json already has it). */
async function projectEnablesGoogleAuth(root: string): Promise<boolean> {
  try {
    const project = await readProjectConfig(root);
    const auth = project.features.find((feature) => feature.id === "auth");
    const raw = auth?.options?.providers;
    const choices = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? [raw]
        : [];
    if (choices.includes("google")) return true;
  } catch {
    // ignore
  }

  try {
    const firebaseJson = JSON.parse(
      await readFile(join(root, "firebase.json"), "utf8"),
    ) as {
      auth?: { providers?: { googleSignIn?: unknown } };
    };
    return Boolean(firebaseJson.auth?.providers?.googleSignIn);
  } catch {
    return false;
  }
}

/**
 * After Google Sign-In is enabled, copy the auto-created web OAuth client id into `.env`
 * so Expo AuthSession / the Continue with Google button can enable itself.
 */
export async function syncGoogleOAuthClientToEnv(
  root: string,
  projectId: string,
): Promise<boolean> {
  if (!(await projectEnablesGoogleAuth(root))) return false;

  ui.step("Fetching Google Sign-In OAuth client id");
  try {
    const config = await waitForGoogleSignInClientConfig(projectId);
    if (!config?.clientId) {
      ui.warn(
        "Google Sign-In is enabled but the OAuth web client id is not available yet.",
      );
      ui.detail(
        "Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID from Firebase console → Authentication → Google, then restart the app.",
      );
      return false;
    }

    const envPath = join(root, ".env");
    const existing = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
    await writeFile(
      envPath,
      applyEnvValues(existing, {
        EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: config.clientId,
      }),
      "utf8",
    );
    ui.success("Wrote EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID to .env");
    ui.detail("Restart the Expo dev server so the new client id is picked up.");
    return true;
  } catch (error) {
    ui.warn(
      error instanceof Error
        ? `Could not sync Google OAuth client id: ${error.message}`
        : "Could not sync Google OAuth client id.",
    );
    if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
    return false;
  }
}

/** `radiance setup firebase` — run from inside a project. */
export async function setupFirebaseCommand(
  options: {
    plan?: string;
    project?: string;
    appName?: string;
    createProject?: boolean;
    yes?: boolean;
  } = {},
): Promise<void> {
  const { root, config } = await requireProject();
  bindLogSession(root);
  ui.trace(
    `setup firebase plan=${options.plan ?? "(prompt)"} project=${options.project ?? "(prompt)"} yes=${Boolean(options.yes)}`,
  );
  const plan = parsePlanFlag(options.plan);
  await setupFirebase(root, {
    force: true,
    // The hosted platform passes this. Its scaffold directories are named
    // after an internal app id, which becomes `radiance.json`'s name — neither
    // meaningful to the user nor valid as a GCP display name.
    appName: options.appName?.trim() || config.name,
    plan,
    projectId: options.project,
    createProject: options.createProject === true,
    yes: options.yes === true,
  });
}

export function parsePlanFlag(
  value: string | undefined,
): ProjectPlan | undefined {
  if (value === undefined) return undefined;
  if (value === "free" || value === "spark") return "free";
  if (value === "paid" || value === "blaze") return "paid";
  throw new RadianceError(`Unknown plan "${value}"`, "Use `free` or `paid`.");
}

async function promptProjectPlan(
  preferred?: ProjectPlan,
): Promise<ProjectPlan> {
  const choice = await prompts.select({
    message: "Plan for this app",
    options: [
      {
        value: "free",
        label: "Free",
        hint: "No credit card — Auth/Firestore in cloud; Storage & Functions via emulators",
      },
      {
        value: "paid",
        label: "Paid",
        hint: "Billing account required — cloud Storage & Functions (usually $0 within quotas)",
      },
    ],
    initialValue: preferred ?? "free",
  });
  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
  return choice as ProjectPlan;
}

async function explainPlan(plan: ProjectPlan): Promise<void> {
  ui.blank();
  if (plan === "free") {
    ui.info("Free plan: no credit card required.");
    ui.detail("Cloud: Authentication, Firestore, Hosting.");
    ui.detail(
      "Local emulators only: file storage and backend functions (`start` boots them).",
    );
  } else {
    ui.info(
      "Paid plan: link a cloud billing account (usage often stays within free quotas).",
    );
    ui.detail("Unlocks cloud file storage and backend functions.");
    ui.detail(
      "If you already have a Cloud Billing account, Radiance links it here. Otherwise you add a card once in Google Cloud.",
    );
  }
}

async function guidePaidUpgrade(
  projectId: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const client = {
    getAccessToken: getFirebaseAccessToken,
    quotaProject: projectId,
  };
  const billingUrl = cloudBillingLinkedAccountUrl(projectId);
  const storageUrl = firebaseConsoleStorageUrl(projectId);

  ui.blank();
  ui.step("Enable billing for this project");

  try {
    await ensureGoogleApiEnabled(projectId, "cloudbilling.googleapis.com");
  } catch {
    ui.trace("Could not enable Cloud Billing API automatically; continuing.");
  }

  let billed = false;
  try {
    const info = await getProjectBillingInfo(projectId, client);
    const accounts = await listOpenBillingAccounts(client);
    const decision = decideBillingLink({
      billingEnabled: info.billingEnabled,
      accounts,
      yes: options.yes === true,
    });

    if (decision.action === "skip") {
      ui.detail("Billing is already linked (Blaze).");
      billed = true;
    } else if (decision.action === "link") {
      ui.detail("Linking your Cloud Billing account (this enables Blaze).");
      const linked = await linkProjectBilling(
        projectId,
        decision.accountName,
        client,
      );
      billed = linked.billingEnabled;
    } else if (decision.action === "pick") {
      if (options.yes) {
        throw new RadianceError(
          "Multiple Cloud Billing accounts — cannot choose in headless mode",
          `Re-run without -y and pick an account, or link one at ${billingUrl}`,
        );
      }
      const choice = await prompts.select({
        message: "Cloud Billing account",
        options: decision.accounts.map((account) => ({
          value: account.name,
          label: account.displayName,
          hint: account.name.replace(/^billingAccounts\//, ""),
        })),
      });
      if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
      const linked = await linkProjectBilling(
        projectId,
        String(choice),
        client,
      );
      billed = linked.billingEnabled;
    } else if (options.yes) {
      throw new RadianceError(
        "No Cloud Billing account on this Google user",
        `Create and link one at ${billingUrl}, then re-run \`radiance setup firebase --plan paid\`.`,
      );
    } else {
      ui.detail(
        "Add a payment method with Google (once). Usage often stays $0 inside Blaze quotas.",
      );
      ui.detail(`   ${billingUrl}`);
      try {
        await openInBrowser(billingUrl);
      } catch {
        ui.detail("Could not open the browser — paste the URL above.");
      }
      const spinner = prompts.spinner();
      spinner.start("Waiting for Cloud Billing on this project");
      try {
        await waitForProjectBilling(projectId, {
          ...client,
          timeoutMs: 5 * 60_000,
          intervalMs: 5_000,
        });
        spinner.stop("Billing linked");
        billed = true;
      } catch (error) {
        spinner.stop("Billing not detected yet");
        const hint =
          error instanceof CloudBillingError
            ? error.detail
            : error instanceof Error
              ? error.message
              : undefined;
        throw new RadianceError(
          "Billing is required for the paid plan",
          hint ?? `Finish linking at ${billingUrl}, then re-run.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof RadianceError) throw error;
    if (error instanceof CloudBillingError) {
      throw new RadianceError(error.message, error.detail);
    }
    throw error;
  }

  if (!billed) {
    const again = await getProjectBillingInfo(projectId, client);
    if (!again.billingEnabled) {
      throw new RadianceError(
        "Billing is required for the paid plan",
        `Finish linking at ${billingUrl}, then re-run.`,
      );
    }
  }

  ui.blank();
  ui.step("Provisioning the default Storage bucket");
  const spinner = prompts.spinner();
  spinner.start("Creating default Storage bucket");
  try {
    const bucket = await ensureDefaultStorageBucket(projectId);
    spinner.stop(
      bucket.bucket
        ? `Storage bucket ready (${bucket.bucket})`
        : "Storage bucket ready",
    );
  } catch (error) {
    spinner.stop("Could not create Storage bucket automatically");
    ui.warn(
      error instanceof Error
        ? error.message
        : "Storage bucket creation failed.",
    );
    if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
    ui.detail(
      "Falling back to the console — open Storage and accept the defaults.",
    );
    ui.detail(`   ${storageUrl}`);
    try {
      await openInBrowser(storageUrl);
    } catch {
      ui.detail("Could not open the browser — paste the URL above.");
    }

    if (options.yes) {
      throw new RadianceError(
        "Default Storage bucket required",
        "Create it in the console, then re-run `radiance setup firebase --plan paid`.",
      );
    }

    const bucketReady = await prompts.confirm({
      message: "Is the default Storage bucket created?",
      initialValue: false,
    });
    if (prompts.isCancel(bucketReady)) throw new RadianceError("Cancelled.");
    if (!bucketReady) {
      throw new RadianceError(
        "Default Storage bucket required",
        "Create it in the console, then re-run `radiance setup firebase --plan paid`.",
      );
    }
  }
}

async function persistProjectPlan(
  root: string,
  plan: ProjectPlan,
): Promise<void> {
  const config = await readProjectConfig(root);
  if (config.plan === plan) return;
  await writeProjectConfig(root, { ...config, plan });
}

async function resolveProjectId(appName: string): Promise<string> {
  const choice = await prompts.select({
    message: "Firebase project",
    options: [
      { value: "existing", label: "Use an existing project" },
      { value: "create", label: "Create a new project" },
    ],
  });

  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");

  if (choice === "existing") {
    return pickExistingProject();
  }

  return createNewProject(appName);
}

async function pickExistingProject(): Promise<string> {
  const spinner = prompts.spinner();
  spinner.start("Loading Firebase projects");

  let projects;
  try {
    projects = await listFirebaseProjects();
    spinner.stop(
      `Found ${projects.length} project${projects.length === 1 ? "" : "s"}`,
    );
  } catch (error) {
    spinner.stop("Could not list projects");
    throw error;
  }

  if (projects.length === 0) {
    ui.warn("No Firebase projects on this account — creating a new one.");
    return createNewProject("radiance-app");
  }

  const selected = await prompts.select({
    message: "Which project?",
    options: projects.map((project) => ({
      value: project.projectId,
      label: project.displayName
        ? `${project.displayName} (${project.projectId})`
        : project.projectId,
    })),
  });

  if (prompts.isCancel(selected)) throw new RadianceError("Cancelled.");
  return selected as string;
}

async function createNewProject(appName: string): Promise<string> {
  const suggested = suggestProjectId(appName);

  const projectId = await prompts.text({
    message: "New Firebase project id",
    placeholder: suggested,
    initialValue: suggested,
    validate: (value) => {
      if (!value || !isValidProjectId(value)) {
        return "Use 6–30 chars: start with a letter, then lowercase letters, digits, or hyphens";
      }
    },
  });

  if (prompts.isCancel(projectId)) throw new RadianceError("Cancelled.");

  const displayName = await prompts.text({
    message: "Display name",
    initialValue: appName,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  if (prompts.isCancel(displayName)) throw new RadianceError("Cancelled.");

  const spinner = prompts.spinner();
  spinner.start(`Creating Firebase project ${projectId}`);

  try {
    await createFirebaseProject(projectId, displayName.trim());
    spinner.stop(`Created ${projectId}`);
  } catch (error) {
    spinner.stop("Project creation failed");
    throw error;
  }

  return projectId;
}

async function ensureWebSdk(
  projectId: string,
  displayName: string,
): Promise<FirebaseSdkConfig> {
  const spinner = prompts.spinner();
  spinner.start("Checking for a web app");

  let apps;
  try {
    apps = await listWebApps(projectId);
  } catch (error) {
    spinner.stop("Could not list web apps");
    throw error;
  }

  let appId = apps[0]?.appId;

  if (!appId) {
    spinner.message(`Creating web app "${displayName}"`);
    try {
      const created = await createWebApp(projectId, displayName);
      appId = created.appId;
      spinner.stop(`Created web app ${appId}`);
    } catch (error) {
      spinner.stop("Could not create a web app");
      throw error;
    }
  } else {
    const label = apps[0]?.displayName
      ? `${apps[0].displayName} (${appId})`
      : appId;
    if (apps.length === 1) {
      spinner.stop(`Using web app ${label}`);
    } else {
      spinner.stop(`Found ${apps.length} web apps`);
      const selected = await prompts.select({
        message: "Which web app?",
        options: apps.map((app) => ({
          value: app.appId,
          label: app.displayName
            ? `${app.displayName} (${app.appId})`
            : app.appId,
        })),
      });
      if (prompts.isCancel(selected)) throw new RadianceError("Cancelled.");
      appId = selected as string;
    }
  }

  spinner.start("Fetching web SDK config");
  try {
    const config = await fetchWebSdkConfig(projectId, appId);
    spinner.stop("Got web SDK config");
    return config;
  } catch (error) {
    spinner.stop("Could not fetch SDK config");
    throw error;
  }
}

export function applySdkConfigToEnv(
  example: string,
  sdk: FirebaseSdkConfig,
): string {
  const values: Record<(typeof FIREBASE_ENV_KEYS)[number], string> = {
    EXPO_PUBLIC_FIREBASE_API_KEY: sdk.apiKey,
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: sdk.authDomain,
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: sdk.projectId,
    EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: sdk.storageBucket,
    EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: sdk.messagingSenderId,
    EXPO_PUBLIC_FIREBASE_APP_ID: sdk.appId,
    EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID: sdk.measurementId ?? "",
  };

  return applyEnvValues(example, values);
}

export function applyNativeAppIdsToEnv(
  content: string,
  ids: { android?: string; ios?: string },
): string {
  const values: Record<string, string> = {};
  if (ids.android) values[FIREBASE_ANDROID_APP_ID_KEY] = ids.android;
  if (ids.ios) values[FIREBASE_IOS_APP_ID_KEY] = ids.ios;
  return Object.keys(values).length > 0
    ? applyEnvValues(content, values)
    : content;
}

/**
 * Pick a Storage rules file that exists on disk.
 * Free plan prefers `storage.emulator.rules` (storage module) because cloud Auth
 * tokens often leave `request.auth` null in the Storage emulator. Projects that
 * never installed storage still have scaffold `storage.rules` — never point
 * firebase.json at a missing file.
 */
export function storageRulesFileForPlan(
  plan: ProjectPlan,
  available: { emulatorRules: boolean; cloudRules: boolean },
): string | null {
  if (plan === "free" && available.emulatorRules) {
    return "storage.emulator.rules";
  }
  if (available.cloudRules) return "storage.rules";
  if (available.emulatorRules) return "storage.emulator.rules";
  return null;
}

/**
 * Free plan: Storage emulator + cloud Auth — use storage.emulator.rules when present.
 * Paid plan: deploy-ready owner-scoped storage.rules.
 * No-ops the storage.rules path when neither file exists (e.g. no storage module).
 */
export async function applyStorageRulesPathForPlan(
  root: string,
  plan: ProjectPlan,
): Promise<void> {
  const path = join(root, "firebase.json");
  if (!existsSync(path)) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return;
  }
  const rulesFile = storageRulesFileForPlan(plan, {
    emulatorRules: existsSync(join(root, "storage.emulator.rules")),
    cloudRules: existsSync(join(root, "storage.rules")),
  });
  const existing =
    parsed.storage && typeof parsed.storage === "object"
      ? (parsed.storage as Record<string, unknown>)
      : {};
  if (!rulesFile) {
    if ("storage" in parsed) delete parsed.storage;
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return;
  }
  parsed.storage = { ...existing, rules: rulesFile };
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/**
 * Free: Auth/Firestore hit the cloud; Storage & Functions use emulators.
 * Paid: emulators off by default (cloud for everything).
 */
export function applyPlanEmulatorEnv(
  content: string,
  plan: ProjectPlan,
): string {
  const values: Record<(typeof EMULATOR_ENV_KEYS)[number], string> =
    plan === "free"
      ? {
          EXPO_PUBLIC_USE_FIREBASE_EMULATORS: "true",
          EXPO_PUBLIC_FIREBASE_EMULATOR_HOST: "localhost",
          EXPO_PUBLIC_EMULATOR_AUTH: "false",
          EXPO_PUBLIC_EMULATOR_FIRESTORE: "false",
          EXPO_PUBLIC_EMULATOR_FUNCTIONS: "true",
          EXPO_PUBLIC_EMULATOR_STORAGE: "true",
        }
      : {
          EXPO_PUBLIC_USE_FIREBASE_EMULATORS: "false",
          EXPO_PUBLIC_FIREBASE_EMULATOR_HOST: "localhost",
          EXPO_PUBLIC_EMULATOR_AUTH: "true",
          EXPO_PUBLIC_EMULATOR_FIRESTORE: "true",
          EXPO_PUBLIC_EMULATOR_FUNCTIONS: "true",
          EXPO_PUBLIC_EMULATOR_STORAGE: "true",
        };

  return applyEnvValues(content, values);
}

async function writeEnvFile(
  root: string,
  sdk: FirebaseSdkConfig,
  plan: ProjectPlan,
  nativeAppIds: { android?: string; ios?: string } = {},
  options: { yes?: boolean } = {},
): Promise<void> {
  const examplePath = join(root, ".env.example");
  const envPath = join(root, ".env");

  const base = existsSync(examplePath)
    ? await readFile(examplePath, "utf8")
    : FIREBASE_ENV_KEYS.map((key) => `${key}=`).join("\n") + "\n";

  const withSdk = applyNativeAppIdsToEnv(
    applyPlanEmulatorEnv(applySdkConfigToEnv(base, sdk), plan),
    nativeAppIds,
  );

  if (existsSync(envPath)) {
    if (!options.yes) {
      const overwrite = await prompts.confirm({
        message: ".env already exists — overwrite Firebase keys?",
        initialValue: true,
      });
      if (prompts.isCancel(overwrite) || !overwrite) {
        ui.warn("Left existing .env untouched.");
        return;
      }
    }
    const existing = await readFile(envPath, "utf8");
    await writeFile(
      envPath,
      applyNativeAppIdsToEnv(
        applyPlanEmulatorEnv(applySdkConfigToEnv(existing, sdk), plan),
        nativeAppIds,
      ),
      "utf8",
    );
    return;
  }

  await writeFile(envPath, withSdk, "utf8");
}

/**
 * Ensure Android + iOS Firebase apps exist for App Distribution (production bundle id).
 */
export async function ensureNativeApps(
  projectId: string,
  displayName: string,
  bundleId: string,
): Promise<{ android?: string; ios?: string }> {
  const spinner = prompts.spinner();
  const result: { android?: string; ios?: string } = {};

  spinner.start("Checking Android Firebase app");
  try {
    const androidApps = await listNativeApps(projectId, "ANDROID");
    const matched =
      androidApps.find((app) => app.packageName === bundleId) ?? androidApps[0];
    if (matched?.appId) {
      result.android = matched.appId;
      spinner.stop(
        androidApps.length === 1 || matched.packageName === bundleId
          ? `Using Android app ${matched.appId}`
          : `Using Android app ${matched.appId} (first of ${androidApps.length})`,
      );
    } else {
      spinner.message(`Creating Android app for ${bundleId}`);
      const created = await createAndroidApp(projectId, displayName, bundleId);
      result.android = created.appId;
      spinner.stop(`Created Android app ${created.appId}`);
    }
  } catch (error) {
    spinner.stop("Could not ensure Android app");
    ui.warn(
      error instanceof Error
        ? `Android Firebase app skipped: ${error.message}`
        : "Android Firebase app skipped.",
    );
  }

  spinner.start("Checking iOS Firebase app");
  try {
    const iosApps = await listNativeApps(projectId, "IOS");
    const matched =
      iosApps.find((app) => app.bundleId === bundleId) ?? iosApps[0];
    if (matched?.appId) {
      result.ios = matched.appId;
      spinner.stop(
        iosApps.length === 1 || matched.bundleId === bundleId
          ? `Using iOS app ${matched.appId}`
          : `Using iOS app ${matched.appId} (first of ${iosApps.length})`,
      );
    } else {
      spinner.message(`Creating iOS app for ${bundleId}`);
      const created = await createIosApp(projectId, displayName, bundleId);
      result.ios = created.appId;
      spinner.stop(`Created iOS app ${created.appId}`);
    }
  } catch (error) {
    spinner.stop("Could not ensure iOS app");
    ui.warn(
      error instanceof Error
        ? `iOS Firebase app skipped: ${error.message}`
        : "iOS Firebase app skipped.",
    );
  }

  return result;
}

async function writeFirebaserc(root: string, projectId: string): Promise<void> {
  const path = join(root, ".firebaserc");
  const body = {
    projects: {
      default: projectId,
      staging: projectId,
      prod: projectId,
    },
  };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

async function updateEasProjectIds(
  root: string,
  projectId: string,
): Promise<void> {
  const path = join(root, "eas.json");
  if (!existsSync(path)) return;

  const raw = await readFile(path, "utf8");
  const updated = raw
    .replaceAll("radiance-staging-placeholder", projectId)
    .replaceAll("radiance-prod-placeholder", projectId);
  if (updated !== raw) {
    await writeFile(path, updated, "utf8");
  }
}
