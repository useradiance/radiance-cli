import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { RadianceError } from "./logger.js";

/** Scaffold placeholders written by the Expo template before Firebase is linked. */
export const FIREBASE_PROJECT_PLACEHOLDERS = new Set([
  "radiance-staging-placeholder",
  "radiance-prod-placeholder",
]);

/** Public OAuth client used by firebase-tools (same values as the npm package). */
const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ??
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET ?? "j9iVZfS8kkCEFUPaAeJV0sAi";

export type FirebaseProject = {
  projectId: string;
  displayName?: string;
  state?: string;
};

export type FirebaseWebApp = {
  appId: string;
  displayName?: string;
  projectId?: string;
};

export type FirebaseNativeApp = {
  appId: string;
  displayName?: string;
  projectId?: string;
  /** Android package name or iOS bundle id when returned by firebase-tools. */
  packageName?: string;
  bundleId?: string;
};

/** JS SDK config fields returned by `firebase apps:sdkconfig WEB`. */
export type FirebaseSdkConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
};

type FirebaseJsonResponse<T> = {
  status: "success" | "error";
  result?: T;
  error?: string;
};

/**
 * firebase-tools sometimes appends update-check banners after `--json` output.
 * Pull out the first top-level JSON object so parsing stays reliable.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new RadianceError(
      "firebase-tools returned no JSON",
      text.trim().slice(0, 200) || undefined,
    );
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i]!;

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new RadianceError("firebase-tools returned truncated JSON");
}

export async function assertFirebaseCli(): Promise<string> {
  try {
    const { stdout } = await execa("firebase", ["--version"], {
      timeout: 15_000,
    });
    return stdout.trim().split("\n")[0] ?? "unknown";
  } catch {
    throw new RadianceError(
      "firebase-tools is not installed",
      "Install it with `npm i -g firebase-tools`, then run `firebase login`.",
    );
  }
}

async function firebaseJson<T>(
  args: string[],
  options: { cwd?: string } = {},
): Promise<T> {
  const result = await execa(
    "firebase",
    [...args, "--json", "--non-interactive"],
    {
      cwd: options.cwd,
      reject: false,
      timeout: 120_000,
      env: { ...process.env, CI: "1" },
    },
  );

  const combined = `${result.stdout}\n${result.stderr}`;
  let parsed: FirebaseJsonResponse<T>;

  try {
    parsed = extractJsonObject(combined) as FirebaseJsonResponse<T>;
  } catch (error) {
    if (result.exitCode !== 0) {
      throw new RadianceError(
        `firebase ${args[0]} failed`,
        combined.trim().split("\n").filter(Boolean).slice(-3).join("\n") ||
          undefined,
      );
    }
    throw error;
  }

  if (parsed.status !== "success") {
    throw new RadianceError(
      `firebase ${args.join(" ")} failed`,
      parsed.error ??
        combined.trim().split("\n").filter(Boolean).slice(-3).join("\n"),
    );
  }

  return parsed.result as T;
}

export async function listLoggedInAccounts(): Promise<{ email: string }[]> {
  const result = await firebaseJson<
    { user: { email?: string }; tokens?: unknown }[]
  >(["login:list"]);

  return (result ?? [])
    .map((entry) => entry.user?.email)
    .filter((email): email is string => Boolean(email))
    .map((email) => ({ email }));
}

export async function ensureFirebaseLogin(): Promise<string> {
  if (
    process.env.RADIANCE_GOOGLE_ACCESS_TOKEN?.trim() ||
    process.env.RADIANCE_GOOGLE_REFRESH_TOKEN?.trim()
  ) {
    return (
      process.env.RADIANCE_GOOGLE_ACCOUNT_EMAIL?.trim() ||
      "radiance-platform@hosted"
    );
  }

  const accounts = await listLoggedInAccounts();
  if (accounts[0]?.email) return accounts[0].email;

  const login = await execa("firebase", ["login"], {
    stdio: "inherit",
    reject: false,
  });

  if (login.exitCode !== 0) {
    throw new RadianceError(
      "Firebase login did not complete",
      "Run `firebase login` yourself, then try again.",
    );
  }

  const after = await listLoggedInAccounts();
  if (!after[0]?.email) {
    throw new RadianceError(
      "Firebase login did not complete",
      "Run `firebase login` and try again.",
    );
  }
  return after[0].email;
}

export async function listFirebaseProjects(): Promise<FirebaseProject[]> {
  const projects = await firebaseJson<FirebaseProject[]>(["projects:list"]);
  return (projects ?? []).filter((project) => project.state !== "DELETED");
}

export async function createFirebaseProject(
  projectId: string,
  displayName: string,
): Promise<FirebaseProject> {
  // Hosted platform injects OAuth via RADIANCE_GOOGLE_* — prefer REST so we do not
  // depend on an interactive `firebase login` configstore.
  if (
    process.env.RADIANCE_GOOGLE_ACCESS_TOKEN?.trim() ||
    process.env.RADIANCE_GOOGLE_REFRESH_TOKEN?.trim()
  ) {
    const accessToken = await getFirebaseAccessToken();
    const createRes = await fetch(
      "https://cloudresourcemanager.googleapis.com/v1/projects",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectId, name: displayName }),
      },
    );
    if (!createRes.ok) {
      throw new RadianceError(
        `Could not create GCP project ${projectId}`,
        await createRes.text(),
      );
    }

    for (let i = 0; i < 12; i++) {
      const probe = await fetch(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (probe.ok) {
        const body = (await probe.json()) as { lifecycleState?: string };
        if (body.lifecycleState === "ACTIVE") break;
      }
      await delay(5_000);
    }

    const addFirebase = await fetch(
      `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}:addFirebase`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    if (!addFirebase.ok && addFirebase.status !== 409) {
      throw new RadianceError(
        `Could not add Firebase to ${projectId}`,
        await addFirebase.text(),
      );
    }

    return { projectId, displayName };
  }

  return firebaseJson<FirebaseProject>([
    "projects:create",
    projectId,
    "--display-name",
    displayName,
  ]);
}

export async function listWebApps(
  projectId: string,
): Promise<FirebaseWebApp[]> {
  const apps = await firebaseJson<FirebaseWebApp[]>([
    "apps:list",
    "WEB",
    "--project",
    projectId,
  ]);
  return apps ?? [];
}

export async function createWebApp(
  projectId: string,
  displayName: string,
): Promise<FirebaseWebApp> {
  return firebaseJson<FirebaseWebApp>([
    "apps:create",
    "WEB",
    displayName,
    "--project",
    projectId,
  ]);
}

export async function listNativeApps(
  projectId: string,
  platform: "ANDROID" | "IOS",
): Promise<FirebaseNativeApp[]> {
  const apps = await firebaseJson<FirebaseNativeApp[]>([
    "apps:list",
    platform,
    "--project",
    projectId,
  ]);
  return apps ?? [];
}

export async function createAndroidApp(
  projectId: string,
  displayName: string,
  packageName: string,
): Promise<FirebaseNativeApp> {
  return firebaseJson<FirebaseNativeApp>([
    "apps:create",
    "ANDROID",
    displayName,
    "--package-name",
    packageName,
    "--project",
    projectId,
  ]);
}

export async function createIosApp(
  projectId: string,
  displayName: string,
  bundleId: string,
): Promise<FirebaseNativeApp> {
  return firebaseJson<FirebaseNativeApp>([
    "apps:create",
    "IOS",
    displayName,
    "--bundle-id",
    bundleId,
    "--project",
    projectId,
  ]);
}

export async function fetchWebSdkConfig(
  projectId: string,
  appId?: string,
): Promise<FirebaseSdkConfig> {
  const args = ["apps:sdkconfig", "WEB"];
  if (appId) args.push(appId);
  args.push("--project", projectId);

  const result = await firebaseJson<{ sdkConfig: FirebaseSdkConfig }>(args);
  const config = result?.sdkConfig;
  if (!config?.apiKey || !config.projectId || !config.appId) {
    throw new RadianceError(
      "Could not read the Firebase web SDK config",
      "Open the Firebase console → Project settings → Your apps and copy the web config into `.env`.",
    );
  }
  return config;
}

/**
 * Writes `google-services.json` / `GoogleService-Info.plist` for RNFirebase / prebuild.
 * No-ops when the corresponding native app id is missing.
 */
export async function writeNativeGoogleServicesFiles(
  root: string,
  projectId: string,
  nativeAppIds: { android?: string; ios?: string },
): Promise<{ android: boolean; ios: boolean }> {
  const written = { android: false, ios: false };

  if (nativeAppIds.android) {
    await execa(
      "firebase",
      [
        "apps:sdkconfig",
        "ANDROID",
        nativeAppIds.android,
        "--project",
        projectId,
        "-o",
        join(root, "google-services.json"),
      ],
      { cwd: root, timeout: 60_000 },
    );
    written.android = true;
  }

  if (nativeAppIds.ios) {
    await execa(
      "firebase",
      [
        "apps:sdkconfig",
        "IOS",
        nativeAppIds.ios,
        "--project",
        projectId,
        "-o",
        join(root, "GoogleService-Info.plist"),
      ],
      { cwd: root, timeout: 60_000 },
    );
    written.ios = true;
  }

  return written;
}

/** Firebase project ids: 6–30 chars, lowercase letter start, letters/digits/hyphens. */
export function suggestProjectId(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  const base = /^[a-z]/.test(slug)
    ? slug
    : `app-${slug}`.replace(/^app-$/, "app");
  const withSuffix = `${base || "radiance"}-${Math.random().toString(36).slice(2, 6)}`;
  return withSuffix.slice(0, 30);
}

export function isValidProjectId(projectId: string): boolean {
  return /^[a-z][a-z0-9-]{4,29}$/.test(projectId) && !projectId.endsWith("-");
}

export function isPlaceholderProjectId(projectId: string): boolean {
  return (
    FIREBASE_PROJECT_PLACEHOLDERS.has(projectId) ||
    projectId.includes("placeholder")
  );
}

/**
 * Read the linked Firebase project id from `.firebaserc` (default alias) or `.env`.
 * Returns null when nothing is linked (missing files or scaffold placeholders).
 */
export async function resolveLinkedFirebaseProjectId(
  root: string,
): Promise<string | null> {
  const rcPath = join(root, ".firebaserc");
  if (existsSync(rcPath)) {
    try {
      const rc = JSON.parse(await readFile(rcPath, "utf8")) as {
        projects?: Record<string, string>;
      };
      const fromRc = rc.projects?.default?.trim();
      if (fromRc && !isPlaceholderProjectId(fromRc)) return fromRc;
    } catch {
      // fall through to .env
    }
  }

  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    const env = await readFile(envPath, "utf8");
    const match = /^EXPO_PUBLIC_FIREBASE_PROJECT_ID=(.*)$/m.exec(env);
    const fromEnv = match?.[1]?.trim();
    if (fromEnv && !isPlaceholderProjectId(fromEnv)) return fromEnv;
  }

  return null;
}

export type FirebaseHostingSite = {
  siteId: string;
  defaultUrl?: string;
  appId?: string;
};

export type FirebaseFunctionEndpoint = {
  id: string;
  region: string;
};

export async function listHostingSites(
  projectId: string,
  options: { cwd?: string } = {},
): Promise<FirebaseHostingSite[]> {
  const result = await firebaseJson<{
    sites?: { name?: string; defaultUrl?: string; appId?: string }[];
  }>(["hosting:sites:list", "--project", projectId], options);

  return (result?.sites ?? [])
    .map((site) => {
      const siteId = site.name?.split("/").pop() ?? "";
      return { siteId, defaultUrl: site.defaultUrl, appId: site.appId };
    })
    .filter((site) => Boolean(site.siteId));
}

export async function deleteHostingSite(
  projectId: string,
  siteId: string,
  options: { cwd?: string } = {},
): Promise<void> {
  const result = await execa(
    "firebase",
    [
      "hosting:sites:delete",
      siteId,
      "--project",
      projectId,
      "--force",
      "--non-interactive",
    ],
    {
      cwd: options.cwd,
      reject: false,
      timeout: 120_000,
      env: { ...process.env, CI: "1" },
    },
  );

  if (result.exitCode !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    throw new RadianceError(
      `firebase hosting:sites:delete ${siteId} failed`,
      combined.split("\n").filter(Boolean).slice(-3).join("\n") || undefined,
    );
  }
}

export async function listFunctions(
  projectId: string,
  options: { cwd?: string } = {},
): Promise<FirebaseFunctionEndpoint[]> {
  const endpoints = await firebaseJson<
    | { id?: string; region?: string }[]
    | { result?: { id?: string; region?: string }[] }
  >(["functions:list", "--project", projectId], options);

  const list = Array.isArray(endpoints) ? endpoints : [];
  return list
    .map((endpoint) => ({
      id: endpoint.id ?? "",
      region: endpoint.region ?? "",
    }))
    .filter((endpoint) => Boolean(endpoint.id));
}

export async function deleteFunctions(
  projectId: string,
  functions: FirebaseFunctionEndpoint[],
  options: { cwd?: string } = {},
): Promise<void> {
  if (functions.length === 0) return;

  // Delete one-by-one with region so multi-region names don't collide.
  for (const fn of functions) {
    const args = [
      "functions:delete",
      fn.id,
      "--project",
      projectId,
      "--force",
      "--non-interactive",
    ];
    if (fn.region) args.push("--region", fn.region);

    const result = await execa("firebase", args, {
      cwd: options.cwd,
      reject: false,
      timeout: 180_000,
      env: { ...process.env, CI: "1" },
    });

    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      throw new RadianceError(
        `firebase functions:delete ${fn.id} failed`,
        combined.split("\n").filter(Boolean).slice(-3).join("\n") || undefined,
      );
    }
  }
}

export async function deleteFirestoreDatabase(
  projectId: string,
  databaseId = "(default)",
  options: { cwd?: string } = {},
): Promise<void> {
  const result = await execa(
    "firebase",
    [
      "firestore:databases:delete",
      databaseId,
      "--project",
      projectId,
      "--force",
      "--non-interactive",
    ],
    {
      cwd: options.cwd,
      reject: false,
      timeout: 180_000,
      env: { ...process.env, CI: "1" },
    },
  );

  if (result.exitCode !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    throw new RadianceError(
      `firebase firestore:databases:delete ${databaseId} failed`,
      combined.split("\n").filter(Boolean).slice(-3).join("\n") || undefined,
    );
  }
}

/**
 * Multi-region US — Firebase console default for new Firestore databases.
 * Prefer this over a single-region id so free-tier projects match common docs / tooling.
 */
export const DEFAULT_FIRESTORE_LOCATION = "nam5";

/** APIs required before creating `(default)` or deploying Firestore rules/indexes. */
export const FIRESTORE_REQUIRED_APIS = [
  "firestore.googleapis.com",
  "firebaserules.googleapis.com",
] as const;

const SERVICE_USAGE_ORIGIN = "https://serviceusage.googleapis.com";

/** Default poll settings while waiting for Service Usage enablement to propagate. */
export const API_ENABLE_POLL_INTERVAL_MS = 5_000;
export const API_ENABLE_MAX_POLLS = 12;

/** Create retries after enable — Firestore can still 403 for a short window. */
export const FIRESTORE_CREATE_BACKOFF_MS = [
  3_000, 6_000, 12_000, 20_000,
] as const;

export type EnsureGoogleApiOptions = {
  getAccessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
};

/**
 * Detects GCP "API has not been used / is disabled" errors from firebase-tools or REST.
 */
export function isApiNotEnabledError(message: string): boolean {
  return (
    /has not been used in project/i.test(message) ||
    /api .+ is not enabled/i.test(message) ||
    /service .+ is not enabled/i.test(message) ||
    (/is disabled/i.test(message) && /api|service/i.test(message))
  );
}

function serviceUsageName(projectId: string, apiName: string): string {
  const hostname = apiName.startsWith("http")
    ? new URL(apiName).hostname
    : apiName;
  return `projects/${projectId}/services/${hostname}`;
}

async function readServiceUsageError(
  response: Response,
): Promise<string | undefined> {
  const text = (await response.text()).trim();
  if (!text) return undefined;
  try {
    const json = JSON.parse(text) as { error?: { message?: string } };
    return json.error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * Ensures a Google API is enabled on the project via Service Usage (same path firebase-tools uses).
 * Fresh Firebase projects often lack `firestore.googleapis.com` until the first console visit or deploy.
 */
export async function ensureGoogleApiEnabled(
  projectId: string,
  apiName: string,
  options: EnsureGoogleApiOptions = {},
): Promise<"already-enabled" | "enabled"> {
  const hostname = apiName.startsWith("http")
    ? new URL(apiName).hostname
    : apiName;
  const getAccessToken = options.getAccessToken ?? getFirebaseAccessToken;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const pollIntervalMs = options.pollIntervalMs ?? API_ENABLE_POLL_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? API_ENABLE_MAX_POLLS;

  const accessToken = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "x-goog-user-project": projectId,
  };

  const checkEnabled = async (): Promise<boolean> => {
    const response = await fetchImpl(
      `${SERVICE_USAGE_ORIGIN}/v1/${serviceUsageName(projectId, hostname)}`,
      { headers },
    );
    if (!response.ok) {
      // Treat permission / not-found as "not enabled" so we still attempt :enable.
      if (response.status === 403 || response.status === 404) return false;
      const detail = await readServiceUsageError(response);
      throw new RadianceError(
        `Could not check whether ${hostname} is enabled in ${projectId}`,
        detail ?? `HTTP ${response.status}`,
      );
    }
    const json = (await response.json()) as { state?: string };
    return json.state === "ENABLED";
  };

  if (await checkEnabled()) return "already-enabled";

  const enableResponse = await fetchImpl(
    `${SERVICE_USAGE_ORIGIN}/v1/${serviceUsageName(projectId, hostname)}:enable`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );

  if (!enableResponse.ok && enableResponse.status !== 409) {
    const detail = await readServiceUsageError(enableResponse);
    throw new RadianceError(
      `Could not enable ${hostname} in ${projectId}`,
      detail ??
        `Visit https://console.developers.google.com/apis/api/${hostname}/overview?project=${projectId}`,
    );
  }

  for (let poll = 0; poll < maxPolls; poll++) {
    if (await checkEnabled()) return "enabled";
    await sleep(pollIntervalMs);
  }

  throw new RadianceError(
    `Timed out waiting for ${hostname} to enable in ${projectId}`,
    "Wait a minute and retry with `radiance setup firebase` or `radiance deploy --rules`.",
  );
}

/** Enables Firestore + Rules APIs needed for database create and rules deploy. */
export async function ensureFirestoreApisEnabled(
  projectId: string,
  options: EnsureGoogleApiOptions = {},
): Promise<void> {
  for (const api of FIRESTORE_REQUIRED_APIS) {
    await ensureGoogleApiEnabled(projectId, api, options);
  }
}

/**
 * Returns true when the project already has a Cloud Firestore database named `(default)`.
 */
export async function hasDefaultFirestoreDatabase(
  projectId: string,
  options: { cwd?: string } = {},
): Promise<boolean> {
  const result = await execa(
    "firebase",
    ["firestore:databases:list", "--project", projectId, "--non-interactive"],
    {
      cwd: options.cwd,
      reject: false,
      timeout: 60_000,
      env: { ...process.env, CI: "1" },
    },
  );

  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    // Treat list failures as "unknown / missing" so callers can attempt create + deploy.
    return /already exists|\(default\)/i.test(combined);
  }

  if (/no databases found/i.test(combined)) return false;
  // List output is a table or JSON-ish dump; match the default database id.
  return /\(default\)/.test(combined);
}

export type EnsureDefaultFirestoreDatabaseOptions = {
  cwd?: string;
  location?: string;
  /** Test seam — replace sleeps between create retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — skip/replace API enablement. */
  ensureApis?: (projectId: string) => Promise<void>;
  /** Create attempts including the first (default: backoff length + 1). */
  maxCreateAttempts?: number;
  backoffMs?: readonly number[];
};

/**
 * Ensures the project's default Firestore database exists.
 * Fresh projects often lack the Firestore API and/or `(default)` database —
 * creating the DB first avoids `firebase deploy --only firestore` 404ing on indexes.
 */
export async function ensureDefaultFirestoreDatabase(
  projectId: string,
  options: EnsureDefaultFirestoreDatabaseOptions = {},
): Promise<"created" | "exists"> {
  const ensureApis = options.ensureApis ?? ensureFirestoreApisEnabled;
  await ensureApis(projectId);

  if (await hasDefaultFirestoreDatabase(projectId, options)) return "exists";

  const location = options.location ?? DEFAULT_FIRESTORE_LOCATION;
  const sleep = options.sleep ?? delay;
  const backoff = options.backoffMs ?? FIRESTORE_CREATE_BACKOFF_MS;
  const maxAttempts = Math.max(
    1,
    options.maxCreateAttempts ?? backoff.length + 1,
  );

  let lastCombined = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const waitMs =
        backoff[Math.min(attempt - 2, backoff.length - 1)] ??
        backoff.at(-1) ??
        5_000;
      await sleep(waitMs);
      // Re-assert enablement in case the first enable raced project creation.
      if (isApiNotEnabledError(lastCombined)) {
        await ensureApis(projectId);
      }
    }

    const result = await execa(
      "firebase",
      [
        "firestore:databases:create",
        "(default)",
        "--location",
        location,
        "--project",
        projectId,
        "--non-interactive",
      ],
      {
        cwd: options.cwd,
        reject: false,
        timeout: 180_000,
        env: { ...process.env, CI: "1" },
      },
    );

    const combined = `${result.stdout}\n${result.stderr}`.trim();
    lastCombined = combined;

    if (result.exitCode === 0 || /already exists/i.test(combined)) {
      return /already exists/i.test(combined) ? "exists" : "created";
    }

    const retryable =
      isApiNotEnabledError(combined) ||
      /http error:\s*403\b/i.test(combined) ||
      /http error:\s*429\b/i.test(combined) ||
      /try again (in a few minutes|later)/i.test(combined);

    if (!retryable || attempt === maxAttempts) {
      throw new RadianceError(
        `Could not create Firestore database (default) in ${projectId}`,
        combined.split("\n").filter(Boolean).slice(-4).join("\n") ||
          `Try: firebase firestore:databases:create "(default)" --location ${location} --project ${projectId}`,
      );
    }
  }

  throw new RadianceError(
    `Could not create Firestore database (default) in ${projectId}`,
    lastCombined.split("\n").filter(Boolean).slice(-4).join("\n") || undefined,
  );
}

export async function hasGcloudCli(): Promise<boolean> {
  try {
    await execa("gcloud", ["--version"], { timeout: 15_000, reject: true });
    return true;
  } catch {
    return false;
  }
}

export function firebaseConsoleSettingsUrl(projectId: string): string {
  return `https://console.firebase.google.com/project/${projectId}/settings/general`;
}

export {
  cloudBillingCreateUrl,
  cloudBillingLinkedAccountUrl,
  firebaseBlazePurchaseUrl as firebaseConsoleBlazeUrl,
} from "./cloud-billing.js";

/** Storage landing — create the default bucket after Blaze is enabled. */
export function firebaseConsoleStorageUrl(projectId: string): string {
  return `https://console.firebase.google.com/project/${projectId}/storage`;
}

/**
 * Location used when Radiance provisions the default Storage bucket.
 * us-central1 is in the Always Free tier for `*.firebasestorage.app` buckets.
 */
export const DEFAULT_STORAGE_LOCATION = "us-central1";

export type DefaultStorageBucket = {
  name: string;
  location?: string;
  bucket?: string;
};

/**
 * GET the project's default Firebase Storage bucket, or `null` if it does not exist yet.
 */
export async function getDefaultStorageBucket(
  projectId: string,
): Promise<DefaultStorageBucket | null> {
  const accessToken = await getFirebaseAccessToken();
  const response = await fetch(
    `https://firebasestorage.googleapis.com/v1alpha/projects/${encodeURIComponent(projectId)}/defaultBucket`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (response.status === 404) return null;
  if (response.status === 403) {
    // Missing permission or bucket — treat as absent so create can clarify.
    return null;
  }
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const json = (await response.json()) as { error?: { message?: string } };
      detail = json.error?.message;
    } catch {
      detail = undefined;
    }
    throw new RadianceError(
      `Could not read default Storage bucket for ${projectId}`,
      detail ?? `HTTP ${response.status}`,
    );
  }

  const json = (await response.json()) as {
    name?: string;
    location?: string;
    bucket?: { name?: string };
  };

  return {
    name: json.name ?? `projects/${projectId}/defaultBucket`,
    location: json.location,
    bucket: json.bucket?.name,
  };
}

/**
 * Create (or re-link) the default Cloud Storage bucket via the Firebase Storage API.
 * Requires the project to already be on Blaze.
 */
export async function ensureDefaultStorageBucket(
  projectId: string,
  options: { location?: string } = {},
): Promise<DefaultStorageBucket> {
  const existing = await getDefaultStorageBucket(projectId);
  if (existing?.bucket) return existing;

  const accessToken = await getFirebaseAccessToken();
  const location = options.location ?? DEFAULT_STORAGE_LOCATION;
  const response = await fetch(
    `https://firebasestorage.googleapis.com/v1alpha/projects/${encodeURIComponent(projectId)}/defaultBucket`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ location }),
    },
  );

  if (!response.ok) {
    let detail: string | undefined;
    try {
      const json = (await response.json()) as { error?: { message?: string } };
      detail = json.error?.message;
    } catch {
      detail = (await response.text()).trim().slice(0, 300) || undefined;
    }

    if (response.status === 403 || response.status === 401) {
      throw new RadianceError(
        `Could not create the default Storage bucket for ${projectId}`,
        detail ??
          "Confirm the project is on the paid (Blaze) plan and your account can manage Storage, then retry.",
      );
    }

    if (response.status === 409) {
      const again = await getDefaultStorageBucket(projectId);
      if (again?.bucket) return again;
    }

    throw new RadianceError(
      `Could not create the default Storage bucket for ${projectId}`,
      detail ?? `HTTP ${response.status}`,
    );
  }

  const json = (await response.json()) as {
    name?: string;
    location?: string;
    bucket?: { name?: string };
  };

  return {
    name: json.name ?? `projects/${projectId}/defaultBucket`,
    location: json.location ?? location,
    bucket: json.bucket?.name ?? `${projectId}.firebasestorage.app`,
  };
}

/** True when the project is missing from the account or marked DELETED. */
export async function firebaseProjectExists(
  projectId: string,
): Promise<boolean> {
  const projects = await firebaseJson<FirebaseProject[]>(["projects:list"]);
  const match = (projects ?? []).find(
    (project) => project.projectId === projectId,
  );
  return Boolean(match && match.state !== "DELETED");
}

export async function openInBrowser(url: string): Promise<void> {
  const os = platform();
  const result =
    os === "darwin"
      ? await execa("open", [url], { reject: false })
      : os === "win32"
        ? await execa("cmd", ["/c", "start", "", url], { reject: false })
        : await execa("xdg-open", [url], { reject: false });

  if (result.exitCode !== 0) {
    throw new RadianceError(
      "Could not open a browser",
      `Open this URL manually: ${url}`,
    );
  }
}

export function firebaseToolsConfigPath(): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? homedir(),
      "configstore",
      "firebase-tools.json",
    );
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "configstore", "firebase-tools.json");
}

type FirebaseCliTokens = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
};

async function readFirebaseCliTokens(): Promise<FirebaseCliTokens | null> {
  const path = firebaseToolsConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      tokens?: FirebaseCliTokens;
    };
    return raw.tokens ?? null;
  } catch {
    return null;
  }
}

/**
 * Access token for Firebase/GCP Management APIs.
 *
 * Resolution order (hosted platform first, then local CLI login):
 * 1. `RADIANCE_GOOGLE_ACCESS_TOKEN` — short-lived bearer from the platform worker
 * 2. `RADIANCE_GOOGLE_REFRESH_TOKEN` (+ optional `RADIANCE_GOOGLE_OAUTH_CLIENT_ID` /
 *    `RADIANCE_GOOGLE_OAUTH_CLIENT_SECRET`) — platform-stored user OAuth
 * 3. `firebase login` tokens in the firebase-tools configstore
 */
export async function getFirebaseAccessToken(): Promise<string> {
  const injected = process.env.RADIANCE_GOOGLE_ACCESS_TOKEN?.trim();
  if (injected) return injected;

  const hostedRefresh = process.env.RADIANCE_GOOGLE_REFRESH_TOKEN?.trim();
  if (hostedRefresh) {
    return refreshGoogleAccessToken(hostedRefresh, {
      clientId:
        process.env.RADIANCE_GOOGLE_OAUTH_CLIENT_ID?.trim() ||
        FIREBASE_CLI_CLIENT_ID,
      clientSecret:
        process.env.RADIANCE_GOOGLE_OAUTH_CLIENT_SECRET?.trim() ||
        FIREBASE_CLI_CLIENT_SECRET,
      hint: "Platform OAuth refresh failed — reconnect Google Cloud in Radiance settings.",
    });
  }

  const tokens = await readFirebaseCliTokens();
  if (!tokens?.refresh_token && !tokens?.access_token) {
    throw new RadianceError(
      "Not logged in to Firebase CLI",
      "Run `firebase login`, then try again.",
    );
  }

  const skewMs = 60_000;
  if (
    tokens.access_token &&
    tokens.expires_at &&
    tokens.expires_at > Date.now() + skewMs
  ) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new RadianceError(
      "Firebase CLI access token expired",
      "Run `firebase login` again, then retry.",
    );
  }

  return refreshGoogleAccessToken(tokens.refresh_token, {
    clientId: FIREBASE_CLI_CLIENT_ID,
    clientSecret: FIREBASE_CLI_CLIENT_SECRET,
    hint: "Run `firebase login` again, then retry.",
  });
}

async function refreshGoogleAccessToken(
  refreshToken: string,
  options: { clientId: string; clientSecret: string; hint: string },
): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new RadianceError(
      "Could not refresh Google credentials",
      options.hint,
    );
  }

  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new RadianceError(
      "Could not refresh Google credentials",
      options.hint,
    );
  }

  return json.access_token;
}

export type GoogleSignInClientConfig = {
  clientId: string;
  clientSecret?: string;
  enabled: boolean;
};

/**
 * Reads the Google provider config Firebase creates when Google Sign-In is enabled
 * (`firebase deploy --only auth` / Identity Toolkit `defaultSupportedIdpConfigs/google.com`).
 * Returns null when Google is not configured yet.
 */
export async function fetchGoogleSignInClientConfig(
  projectId: string,
): Promise<GoogleSignInClientConfig | null> {
  const accessToken = await getFirebaseAccessToken();
  const uri =
    `https://identitytoolkit.googleapis.com/v2/projects/` +
    `${encodeURIComponent(projectId)}/defaultSupportedIdpConfigs/google.com`;

  const response = await fetch(uri, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new RadianceError(
      "Could not read Google Sign-In OAuth client from Identity Toolkit",
      body.slice(0, 300) || `HTTP ${response.status}`,
    );
  }

  const json = (await response.json()) as {
    clientId?: string;
    clientSecret?: string;
    enabled?: boolean;
  };

  if (!json.clientId?.trim()) return null;

  return {
    clientId: json.clientId.trim(),
    ...(json.clientSecret ? { clientSecret: json.clientSecret } : {}),
    enabled: json.enabled !== false,
  };
}

/**
 * Polls briefly after auth provision — OAuth clients can lag a few seconds behind enablement.
 */
export async function waitForGoogleSignInClientConfig(
  projectId: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<GoogleSignInClientConfig | null> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 2_000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const config = await fetchGoogleSignInClientConfig(projectId);
    if (config?.clientId) return config;
    if (attempt < attempts) await delay(delayMs);
  }

  return null;
}

/**
 * Delete a GCP project via Cloud Resource Manager using the Firebase CLI login token.
 * firebase-tools has no `projects:delete`; this is the CLI-equivalent path.
 */
export async function deleteGcpProjectViaApi(projectId: string): Promise<void> {
  const accessToken = await getFirebaseAccessToken();
  const response = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (response.ok || response.status === 204) return;

  let detail: string | undefined;
  try {
    const json = (await response.json()) as { error?: { message?: string } };
    detail = json.error?.message;
  } catch {
    detail = (await response.text()).trim().slice(0, 300) || undefined;
  }

  if (response.status === 403 || response.status === 401) {
    throw new RadianceError(
      `Not allowed to delete GCP project ${projectId}`,
      detail ??
        "Your account needs `resourcemanager.projects.delete` (typically Owner) on this project.",
    );
  }

  if (response.status === 404) {
    throw new RadianceError(
      `GCP project ${projectId} was not found`,
      "It may already be deleted.",
    );
  }

  throw new RadianceError(
    `Failed to delete GCP project ${projectId}`,
    detail ?? `Cloud Resource Manager returned HTTP ${response.status}`,
  );
}

/**
 * Delete a GCP/Firebase project from the CLI.
 * Uses Cloud Resource Manager with Firebase login tokens (primary), then `gcloud` if present.
 * Console fallback only when both automated paths fail and `onManualDelete` is provided.
 */
export async function deleteFirebaseProject(
  projectId: string,
  options: {
    onManualDelete?: (consoleUrl: string) => Promise<boolean>;
  } = {},
): Promise<"api" | "gcloud" | "console"> {
  try {
    await deleteGcpProjectViaApi(projectId);
    return "api";
  } catch (apiError) {
    if (await hasGcloudCli()) {
      const result = await execa(
        "gcloud",
        ["projects", "delete", projectId, "--quiet"],
        {
          reject: false,
          timeout: 180_000,
        },
      );
      if (result.exitCode === 0) return "gcloud";

      const combined = `${result.stdout}\n${result.stderr}`.trim();
      throw new RadianceError(
        `Could not delete GCP project ${projectId}`,
        [
          apiError instanceof Error ? apiError.message : String(apiError),
          combined.split("\n").filter(Boolean).slice(-3).join("\n"),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    if (!options.onManualDelete) throw apiError;

    const url = firebaseConsoleSettingsUrl(projectId);
    const confirmed = await options.onManualDelete(url);
    if (!confirmed) {
      throw new RadianceError("Firebase project delete cancelled");
    }

    if (await firebaseProjectExists(projectId)) {
      throw new RadianceError(
        `Firebase project ${projectId} still exists`,
        [
          apiError instanceof Error ? apiError.message : String(apiError),
          "Finish deleting it in the Firebase console (Project settings → Delete project), then try again.",
        ].join("\n"),
      );
    }

    return "console";
  }
}

export function assertSafeToDeleteDirectory(root: string): void {
  const normalized = resolve(root);
  const home = resolve(homedir());
  if (normalized === "/" || normalized === home) {
    throw new RadianceError(
      "Refusing to delete this directory",
      "Project root resolves to your home directory or filesystem root.",
    );
  }
}
