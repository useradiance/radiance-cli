import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseEnvValues } from "./env.js";
import { RadianceError, ui } from "./logger.js";
import type { NativeArtifact, NativePlatform } from "./mobile-build.js";

export const FIREBASE_ANDROID_APP_ID_KEY = "FIREBASE_ANDROID_APP_ID";
export const FIREBASE_IOS_APP_ID_KEY = "FIREBASE_IOS_APP_ID";

export const NATIVE_FIREBASE_APP_ID_KEYS = [
  FIREBASE_ANDROID_APP_ID_KEY,
  FIREBASE_IOS_APP_ID_KEY,
] as const;

export type AppDistributionOptions = {
  projectId?: string;
  groups?: string;
  testers?: string;
  releaseNotes?: string;
};

/** Read native Firebase app ids from `.env` (written by `radiance setup firebase`). */
export async function readNativeFirebaseAppIds(
  root: string,
): Promise<{ android?: string; ios?: string }> {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return {};
  const values = parseEnvValues(await readFile(envPath, "utf8"));
  return {
    android: values[FIREBASE_ANDROID_APP_ID_KEY]?.trim() || undefined,
    ios: values[FIREBASE_IOS_APP_ID_KEY]?.trim() || undefined,
  };
}

export function appIdKeyForPlatform(platform: NativePlatform): string {
  return platform === "android"
    ? FIREBASE_ANDROID_APP_ID_KEY
    : FIREBASE_IOS_APP_ID_KEY;
}

export async function requireNativeAppId(
  root: string,
  platform: NativePlatform,
): Promise<string> {
  const ids = await readNativeFirebaseAppIds(root);
  const appId = platform === "android" ? ids.android : ids.ios;
  if (!appId) {
    throw new RadianceError(
      `Missing ${appIdKeyForPlatform(platform)} in .env`,
      "Run `radiance setup firebase` to create/link Android and iOS Firebase apps.",
    );
  }
  return appId;
}

/** Upload a binary to Firebase App Distribution. */
export async function distributeToAppDistribution(
  root: string,
  artifact: NativeArtifact,
  options: AppDistributionOptions = {},
): Promise<void> {
  const appId = await requireNativeAppId(root, artifact.platform);
  ui.step(`Uploading ${artifact.platform} build to App Distribution`);

  const args = [
    "appdistribution:distribute",
    artifact.path,
    "--app",
    appId,
    "--non-interactive",
  ];
  if (options.projectId) args.push("--project", options.projectId);
  if (options.groups) args.push("--groups", options.groups);
  if (options.testers) args.push("--testers", options.testers);
  if (options.releaseNotes) args.push("--release-notes", options.releaseNotes);

  const result = await execa("firebase", args, {
    cwd: root,
    stdio: "inherit",
    reject: false,
    timeout: 0,
  });

  if (result.exitCode !== 0) {
    throw new RadianceError(
      "Firebase App Distribution upload failed",
      "See the output above. Confirm the app id and that App Distribution is enabled for the project.",
    );
  }
}

export async function distributeArtifacts(
  root: string,
  artifacts: NativeArtifact[],
  platforms: NativePlatform[],
  options: AppDistributionOptions = {},
): Promise<void> {
  const wanted = new Set(platforms);
  const matched = artifacts.filter((artifact) => wanted.has(artifact.platform));

  if (matched.length === 0) {
    throw new RadianceError(
      `No ${platforms.join("/")} binaries found to distribute`,
      "Run `radiance build --android --ios` first, or pass `--from <artifacts-dir>`.",
    );
  }

  for (const artifact of matched) {
    await distributeToAppDistribution(root, artifact, options);
  }
}
