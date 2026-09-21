import { execa } from "execa";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { RadianceError, ui } from "./logger.js";
import {
  installCommand,
  runScriptCommand,
  type PackageManager,
} from "./package-manager.js";

export const COMPILE_PLATFORMS = ["web", "ios", "android"] as const;
export type CompilePlatform = (typeof COMPILE_PLATFORMS)[number];

export const CHECK_TIMEOUT_MS = 5 * 60_000;
export const WEB_TIMEOUT_MS = 10 * 60_000;
export const NATIVE_TIMEOUT_MS = 20 * 60_000;

export function isCompilePlatform(value: string): value is CompilePlatform {
  return (COMPILE_PLATFORMS as readonly string[]).includes(value);
}

/** Parse `--platforms web,ios`. `undefined` / empty means “use defaults”. */
export function parsePlatforms(
  raw: string | undefined,
): CompilePlatform[] | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const parts = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new RadianceError(
      "No platforms given",
      `Use --platforms ${COMPILE_PLATFORMS.join(",")}`,
    );
  }
  const unknown = parts.filter((part) => !isCompilePlatform(part));
  if (unknown.length > 0) {
    throw new RadianceError(
      `Unknown platform: ${unknown.join(", ")}`,
      `Choose from: ${COMPILE_PLATFORMS.join(", ")}.`,
    );
  }
  return [...new Set(parts)] as CompilePlatform[];
}

export function androidSdkRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const home = env.ANDROID_HOME?.trim() || env.ANDROID_SDK_ROOT?.trim();
  return home || undefined;
}

export function defaultCompilePlatforms(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): CompilePlatform[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const list: CompilePlatform[] = ["web"];
  if (platform === "darwin") list.push("ios");
  if (androidSdkRoot(env)) list.push("android");
  return list;
}

/**
 * Resolve the platform list. Explicit `--platforms ios` on Linux (or android
 * without an SDK) fails instead of silently skipping.
 */
export function resolveCompilePlatforms(
  requested: CompilePlatform[] | undefined,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): CompilePlatform[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const list = requested ?? defaultCompilePlatforms({ platform, env });

  if (list.includes("ios") && platform !== "darwin") {
    throw new RadianceError(
      "iOS compile requires macOS",
      "Omit ios from --platforms, or run this command on a Mac with Xcode.",
    );
  }
  if (list.includes("android") && !androidSdkRoot(env)) {
    throw new RadianceError(
      "Android compile requires ANDROID_HOME or ANDROID_SDK_ROOT",
      "Install the Android SDK, or omit android from --platforms.",
    );
  }
  return list;
}

export function findIosWorkspace(root: string): string | null {
  const iosDir = join(root, "ios");
  if (!existsSync(iosDir)) return null;
  const names = readdirSync(iosDir).filter(
    (name) => name.endsWith(".xcworkspace") && name !== "Pods.xcworkspace",
  );
  const name = names[0];
  return name ? join(iosDir, name) : null;
}

export function iosSchemeFromWorkspace(workspacePath: string): string {
  return basename(workspacePath).replace(/\.xcworkspace$/, "");
}

function expoEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: process.env.CI ?? "1",
    EXPO_NO_TELEMETRY: "1",
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
  };
}

async function runStep(
  label: string,
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
): Promise<void> {
  ui.step(label);
  try {
    await execa(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      stdio: "inherit",
      env: expoEnv(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RadianceError(`${label} failed`, detail);
  }
}

async function compileWeb(root: string): Promise<void> {
  await runStep("Web export", "npx", ["expo", "export", "--platform", "web"], {
    cwd: root,
    timeout: WEB_TIMEOUT_MS,
  });
}

async function compileIos(root: string): Promise<void> {
  await runStep(
    "iOS prebuild",
    "npx",
    ["expo", "prebuild", "--platform", "ios"],
    { cwd: root, timeout: NATIVE_TIMEOUT_MS },
  );

  const workspace = findIosWorkspace(root);
  if (!workspace) {
    throw new RadianceError(
      "iOS prebuild did not create an .xcworkspace",
      `Looked in ${join(root, "ios")}.`,
    );
  }
  const scheme = iosSchemeFromWorkspace(workspace);
  await runStep(
    `iOS xcodebuild (${scheme})`,
    "xcodebuild",
    [
      "-workspace",
      workspace,
      "-scheme",
      scheme,
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "-destination",
      "generic/platform=iOS Simulator",
      "build",
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
    ],
    { cwd: root, timeout: NATIVE_TIMEOUT_MS },
  );
}

async function compileAndroid(root: string): Promise<void> {
  await runStep(
    "Android prebuild",
    "npx",
    ["expo", "prebuild", "--platform", "android"],
    { cwd: root, timeout: NATIVE_TIMEOUT_MS },
  );

  const androidDir = join(root, "android");
  const gradlew = join(androidDir, "gradlew");
  if (!existsSync(gradlew)) {
    throw new RadianceError(
      "Android prebuild did not create gradlew",
      `Looked in ${androidDir}.`,
    );
  }
  await runStep("Android assembleDebug", gradlew, [":app:assembleDebug"], {
    cwd: androidDir,
    timeout: NATIVE_TIMEOUT_MS,
  });
}

/**
 * Prebuild copies these into ios/android. `radiance compile` uses `--no-firebase`,
 * so write stubs when the real files are missing.
 */
export function compileBundleId(root: string): string {
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, "radiance.json"), "utf8"),
    ) as { bundleId?: string };
    if (parsed.bundleId?.trim()) return parsed.bundleId.trim();
  } catch {
    // not a Radiance project, or unreadable
  }
  return "com.radiance.compile";
}

export function ensureCompileGoogleServices(root: string): void {
  const bundleId = compileBundleId(root);
  const plistPath = join(root, "GoogleService-Info.plist");
  const jsonPath = join(root, "google-services.json");
  if (!existsSync(plistPath)) {
    writeFileSync(plistPath, stubGoogleServicePlist(bundleId));
    ui.detail("Wrote compile stub GoogleService-Info.plist");
  }
  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, stubGoogleServicesJson(bundleId));
    ui.detail("Wrote compile stub google-services.json");
  }
}

function stubGoogleServicePlist(bundleId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CLIENT_ID</key>
  <string>stub.apps.googleusercontent.com</string>
  <key>REVERSED_CLIENT_ID</key>
  <string>com.googleusercontent.apps.stub</string>
  <key>API_KEY</key>
  <string>stub</string>
  <key>GCM_SENDER_ID</key>
  <string>1</string>
  <key>PLIST_VERSION</key>
  <string>1</string>
  <key>BUNDLE_ID</key>
  <string>${bundleId}</string>
  <key>PROJECT_ID</key>
  <string>radiance-compile-stub</string>
  <key>STORAGE_BUCKET</key>
  <string>radiance-compile-stub.appspot.com</string>
  <key>IS_ADS_ENABLED</key>
  <false></false>
  <key>IS_ANALYTICS_ENABLED</key>
  <false></false>
  <key>IS_APPINVITE_ENABLED</key>
  <false></false>
  <key>IS_GCM_ENABLED</key>
  <true></true>
  <key>IS_SIGNIN_ENABLED</key>
  <true></true>
  <key>GOOGLE_APP_ID</key>
  <string>1:1:ios:compile</string>
</dict>
</plist>
`;
}

function stubGoogleServicesJson(bundleId: string): string {
  return `${JSON.stringify(
    {
      project_info: {
        project_number: "1",
        project_id: "radiance-compile-stub",
        storage_bucket: "radiance-compile-stub.appspot.com",
      },
      client: [
        {
          client_info: {
            mobilesdk_app_id: "1:1:android:compile",
            android_client_info: { package_name: bundleId },
          },
          oauth_client: [],
          api_key: [{ current_key: "stub" }],
          services: { appinvite_service: { other_platform_oauth_client: [] } },
        },
      ],
      configuration_version: "1",
    },
    null,
    2,
  )}\n`;
}

export async function compileApp(
  root: string,
  options: {
    platforms: CompilePlatform[];
    packageManager: PackageManager;
  },
): Promise<void> {
  const install = installCommand(options.packageManager);
  await runStep("Install dependencies", install.command, install.args, {
    cwd: root,
    timeout: NATIVE_TIMEOUT_MS,
  });

  await runStep("expo install --check", "npx", ["expo", "install", "--check"], {
    cwd: root,
    timeout: CHECK_TIMEOUT_MS,
  });

  const typecheck = runScriptCommand(options.packageManager, "typecheck");
  await runStep("Typecheck", typecheck.command, typecheck.args, {
    cwd: root,
    timeout: CHECK_TIMEOUT_MS,
  });

  if (
    options.platforms.includes("ios") ||
    options.platforms.includes("android")
  ) {
    ensureCompileGoogleServices(root);
  }

  for (const platform of options.platforms) {
    if (platform === "web") await compileWeb(root);
    else if (platform === "ios") await compileIos(root);
    else await compileAndroid(root);
  }
}
