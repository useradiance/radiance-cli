import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../core/config.js";
import { assertReadyForBuild } from "../core/config-gate.js";
import { bindLogSession, ui } from "../core/logger.js";
import {
  buildNativeArtifacts,
  resolveOutDir,
  type NativePlatform,
} from "../core/mobile-build.js";
import { resolvePackageManager } from "../core/package-manager.js";
import { exportWeb } from "../core/project-build.js";
import { requireProject } from "../core/project.js";

export type BuildOptions = {
  web?: boolean;
  android?: boolean;
  ios?: boolean;
  profile?: string;
  /** Prefer `eas build --local` for native platforms. */
  local?: boolean;
  out?: string;
};

/**
 * Produce local artifacts: web export under `dist/`, native binaries under
 * `.radiance/artifacts/<stamp>/` (or `--out`).
 */
export async function buildCommand(options: BuildOptions): Promise<void> {
  const { root, config: project } = await requireProject();
  bindLogSession(root);

  await assertReadyForBuild(root, project);

  const platforms = resolveBuildPlatforms(options);
  ui.trace(
    `build platforms=${platforms.join(",")} profile=${options.profile ?? "preview"} ` +
      `local=${Boolean(options.local)}`,
  );

  const config = await loadConfig();
  const pm = await resolvePackageManager({
    root,
    project: project.packageManager,
    global: config.packageManager,
  });

  const outDir = resolveOutDir(root, options.out);
  const nativePlatforms = platforms.filter(
    (p): p is NativePlatform => p === "android" || p === "ios",
  );

  if (platforms.includes("web")) {
    await exportWeb(root, pm);
    ui.detail(`Web export → ${join(root, "dist")}`);
  }

  if (nativePlatforms.length > 0) {
    await mkdir(outDir, { recursive: true });
    const artifacts = await buildNativeArtifacts(root, {
      platforms: nativePlatforms,
      profile: options.profile ?? "preview",
      local: options.local,
      outDir,
    });

    ui.heading("Native artifacts");
    for (const artifact of artifacts) {
      ui.detail(`${artifact.platform}: ${artifact.path}`);
    }
  }

  ui.success("Build finished.");
}

/** Default: web + android + ios when no platform flags are set. */
export function resolveBuildPlatforms(
  options: BuildOptions,
): Array<"web" | NativePlatform> {
  const selected: Array<"web" | NativePlatform> = [];
  if (options.web) selected.push("web");
  if (options.android) selected.push("android");
  if (options.ios) selected.push("ios");
  return selected.length > 0 ? selected : ["web", "android", "ios"];
}
