import { execa } from "execa";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { extractJsonObject } from "./firebase-cli.js";
import { RadianceError, ui } from "./logger.js";
import { PROJECT_ARTIFACTS_DIR } from "./paths.js";

export type NativePlatform = "android" | "ios";

export type MobileBuildOptions = {
  platforms: NativePlatform[];
  profile: string;
  /** Run `eas build --local` instead of cloud builders. */
  local?: boolean;
  /** Destination directory for binaries (created if missing). */
  outDir: string;
};

export type NativeArtifact = {
  platform: NativePlatform;
  path: string;
};

const BINARY_EXTENSIONS = new Set([".apk", ".aab", ".ipa"]);

export async function assertEasCli(): Promise<string> {
  try {
    const { stdout } = await execa("eas", ["--version"], { timeout: 15_000 });
    return stdout.trim().split("\n")[0] ?? "unknown";
  } catch {
    throw new RadianceError(
      "eas-cli is not installed",
      "Install it with `npm i -g eas-cli`, then run `eas login`.",
    );
  }
}

export function assertEasJson(root: string): void {
  if (!existsSync(join(root, "eas.json"))) {
    throw new RadianceError(
      "No eas.json in this project",
      "EAS build profiles ship with the Radiance scaffold. Re-init or restore eas.json.",
    );
  }
}

/** Default artifact dir: `.radiance/artifacts/<iso-stamp>/`. */
export function defaultArtifactsDir(
  root: string,
  stamp = new Date().toISOString(),
): string {
  const safe = stamp.replace(/[:.]/g, "-");
  return join(root, PROJECT_ARTIFACTS_DIR, safe);
}

export function resolveOutDir(root: string, out?: string): string {
  if (!out) return defaultArtifactsDir(root);
  return resolve(root, out);
}

/**
 * Run EAS Build for the requested platforms and collect binaries under `outDir`.
 * Cloud builds wait, then download via `eas build:download`. Local builds use `--output`.
 */
export async function buildNativeArtifacts(
  root: string,
  options: MobileBuildOptions,
): Promise<NativeArtifact[]> {
  assertEasJson(root);
  await assertEasCli();
  await mkdir(options.outDir, { recursive: true });

  const artifacts: NativeArtifact[] = [];

  for (const platform of options.platforms) {
    ui.step(
      options.local
        ? `Building ${platform} locally (EAS --local, profile ${options.profile})`
        : `Building ${platform} on EAS (profile ${options.profile})`,
    );

    if (options.local) {
      const outputPath = join(options.outDir, localOutputName(platform));
      const result = await execa(
        "eas",
        [
          "build",
          "--platform",
          platform,
          "--profile",
          options.profile,
          "--local",
          "--output",
          outputPath,
          "--non-interactive",
        ],
        { cwd: root, stdio: "inherit", reject: false },
      );
      if (result.exitCode !== 0) {
        throw new RadianceError(
          `EAS local ${platform} build failed`,
          "See the output above. Ensure Android SDK / Xcode (and Docker on Linux) are available.",
        );
      }
      if (!existsSync(outputPath)) {
        throw new RadianceError(
          `EAS local ${platform} build produced no file at ${outputPath}`,
          "Check the EAS output above.",
        );
      }
      artifacts.push({ platform, path: outputPath });
      continue;
    }

    const buildIds = await runCloudEasBuild(root, platform, options.profile);
    for (const buildId of buildIds) {
      const downloaded = await downloadEasBuild(root, buildId, options.outDir);
      artifacts.push({ platform, path: downloaded });
    }
  }

  return artifacts;
}

async function runCloudEasBuild(
  root: string,
  platform: NativePlatform,
  profile: string,
): Promise<string[]> {
  const result = await execa(
    "eas",
    [
      "build",
      "--platform",
      platform,
      "--profile",
      profile,
      "--non-interactive",
      "--wait",
      "--json",
    ],
    {
      cwd: root,
      reject: false,
      // Cloud builds can take a long time; let EAS own the wait.
      timeout: 0,
    },
  );

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (result.exitCode !== 0) {
    throw new RadianceError(
      `EAS ${platform} build failed`,
      combined.split("\n").filter(Boolean).slice(-5).join("\n") ||
        "See eas-cli output.",
    );
  }

  const ids = parseEasBuildIds(result.stdout);
  if (ids.length === 0) {
    throw new RadianceError(
      `EAS ${platform} build finished but no build id was returned`,
      "Try running `eas build` manually, then use `radiance deploy --from <dir>`.",
    );
  }
  return ids;
}

/** Parse build id(s) from `eas build --json` stdout. */
export function parseEasBuildIds(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const startArr = trimmed.indexOf("[");
    const startObj = trimmed.indexOf("{");
    let parsed: unknown;

    if (startArr !== -1 && (startObj === -1 || startArr < startObj)) {
      parsed = JSON.parse(sliceJsonArray(trimmed, startArr));
    } else if (startObj !== -1) {
      parsed = extractJsonObject(trimmed);
    } else {
      return [];
    }

    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const id = (row as { id?: unknown }).id;
        return typeof id === "string" && id.length > 0 ? id : null;
      })
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

function sliceJsonArray(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("truncated JSON array");
}

async function downloadEasBuild(
  root: string,
  buildId: string,
  outDir: string,
): Promise<string> {
  ui.detail(`Downloading EAS build ${buildId}`);
  const result = await execa(
    "eas",
    ["build:download", "--build-id", buildId, "--json", "--non-interactive"],
    { cwd: root, reject: false, timeout: 0 },
  );

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (result.exitCode !== 0) {
    throw new RadianceError(
      `Failed to download EAS build ${buildId}`,
      combined.split("\n").filter(Boolean).slice(-5).join("\n") || undefined,
    );
  }

  let downloadedPath: string | undefined;
  try {
    const parsed = extractJsonObject(result.stdout) as { path?: string };
    downloadedPath = parsed.path;
  } catch {
    // fall through
  }

  if (!downloadedPath || !existsSync(downloadedPath)) {
    throw new RadianceError(
      `EAS download for ${buildId} did not report a file path`,
      combined.slice(0, 400) || undefined,
    );
  }

  const dest = join(outDir, basename(downloadedPath));
  if (resolve(downloadedPath) !== resolve(dest)) {
    await copyFile(downloadedPath, dest);
  }
  return dest;
}

function localOutputName(platform: NativePlatform): string {
  return platform === "android" ? "app-release.apk" : "app-release.ipa";
}

/** Find APK/AAB/IPA files under a directory (non-recursive first, then one level). */
export async function findNativeBinaries(
  dir: string,
): Promise<NativeArtifact[]> {
  if (!existsSync(dir)) {
    throw new RadianceError(`Artifact directory does not exist: ${dir}`);
  }

  const files = await listBinaryFiles(dir);
  const artifacts: NativeArtifact[] = [];

  for (const file of files) {
    const platform = platformFromPath(file);
    if (platform) artifacts.push({ platform, path: file });
  }

  return artifacts;
}

async function listBinaryFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];

  for (const name of entries) {
    const full = join(dir, name);
    const info = await stat(full);
    if (info.isFile() && BINARY_EXTENSIONS.has(extname(name).toLowerCase())) {
      files.push(full);
      continue;
    }
    if (info.isDirectory()) {
      const nested = await readdir(full);
      for (const child of nested) {
        const childPath = join(full, child);
        const childStat = await stat(childPath);
        if (
          childStat.isFile() &&
          BINARY_EXTENSIONS.has(extname(child).toLowerCase())
        ) {
          files.push(childPath);
        }
      }
    }
  }

  return files;
}

export function platformFromPath(filePath: string): NativePlatform | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".apk" || ext === ".aab") return "android";
  if (ext === ".ipa") return "ios";
  return null;
}

export async function copyArtifactsToDir(
  artifacts: NativeArtifact[],
  outDir: string,
): Promise<NativeArtifact[]> {
  await mkdir(outDir, { recursive: true });
  const copied: NativeArtifact[] = [];
  for (const artifact of artifacts) {
    const dest = join(outDir, basename(artifact.path));
    if (resolve(artifact.path) !== resolve(dest)) {
      await copyFile(artifact.path, dest);
    }
    copied.push({ platform: artifact.platform, path: dest });
  }
  return copied;
}

export type MobileDistributionMode = "app-distribution" | "eas" | "local";

export type MobileDeploySelection = {
  platforms: NativePlatform[];
  mode: MobileDistributionMode | null;
  error?: string;
};

/**
 * Validate mobile deploy flags.
 * When any native platform is requested, exactly one distribution mode is required.
 */
export function resolveMobileDeploySelection(options: {
  android?: boolean;
  ios?: boolean;
  appDistribution?: boolean;
  eas?: boolean;
  local?: boolean;
}): MobileDeploySelection {
  const platforms: NativePlatform[] = [];
  if (options.android) platforms.push("android");
  if (options.ios) platforms.push("ios");

  const modes: MobileDistributionMode[] = [];
  if (options.appDistribution) modes.push("app-distribution");
  if (options.eas) modes.push("eas");
  if (options.local) modes.push("local");

  if (platforms.length === 0) {
    if (modes.length > 0) {
      return {
        platforms: [],
        mode: null,
        error: "Mobile distribution flags require `--android` and/or `--ios`.",
      };
    }
    return { platforms: [], mode: null };
  }

  if (modes.length === 0) {
    return {
      platforms,
      mode: null,
      error:
        "Choose one distribution target: `--app-distribution`, `--eas`, or `--local`.",
    };
  }

  if (modes.length > 1) {
    return {
      platforms,
      mode: null,
      error:
        "Use only one of `--app-distribution`, `--eas`, or `--local` for mobile deploy.",
    };
  }

  return { platforms, mode: modes[0]! };
}

export function defaultProfileForMode(
  mode: MobileDistributionMode,
  submit: boolean,
  explicit?: string,
): string {
  if (explicit) return explicit;
  if (mode === "eas" && submit) return "production";
  return "preview";
}
