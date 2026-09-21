import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { distributeArtifacts } from "../core/app-distribution.js";
import { loadConfig } from "../core/config.js";
import { assertReadyForDeploy } from "../core/config-gate.js";
import { assertFirebaseCli } from "../core/firebase-cli.js";
import {
  PAID_DEPLOY_TARGETS,
  firebaseDeploy,
} from "../core/firebase-provision.js";
import { RadianceError, bindLogSession, ui } from "../core/logger.js";
import {
  assertEasCli,
  assertEasJson,
  buildNativeArtifacts,
  copyArtifactsToDir,
  defaultProfileForMode,
  findNativeBinaries,
  resolveMobileDeploySelection,
  resolveOutDir,
  type MobileDistributionMode,
  type NativeArtifact,
  type NativePlatform,
} from "../core/mobile-build.js";
import { resolvePackageManager } from "../core/package-manager.js";
import { buildFunctions, exportWeb } from "../core/project-build.js";
import { requireProject, type ProjectPlan } from "../core/project.js";

export type DeployOptions = {
  web?: boolean;
  rules?: boolean;
  functions?: boolean;
  auth?: boolean;
  project?: string;
  android?: boolean;
  ios?: boolean;
  appDistribution?: boolean;
  eas?: boolean;
  local?: boolean;
  submit?: boolean;
  profile?: string;
  groups?: string;
  testers?: string;
  releaseNotes?: string;
  from?: string;
};

/**
 * Deploy Firebase backend/web targets and/or distribute mobile builds.
 *
 * Bare `radiance deploy` (no flags) remains hosting/rules/auth/functions only.
 * Mobile requires `--android`/`--ios` plus exactly one of
 * `--app-distribution` | `--eas` | `--local`.
 */
export async function deployCommand(options: DeployOptions): Promise<void> {
  const { root, config: project } = await requireProject();
  bindLogSession(root);

  const mobile = resolveMobileDeploySelection(options);
  if (mobile.error) {
    throw new RadianceError(mobile.error);
  }

  ui.trace(
    `deploy flags web=${Boolean(options.web)} rules=${Boolean(options.rules)} ` +
      `functions=${Boolean(options.functions)} auth=${Boolean(options.auth)} ` +
      `android=${Boolean(options.android)} ios=${Boolean(options.ios)} ` +
      `mobileMode=${mobile.mode ?? "(none)"}`,
  );

  const config = await loadConfig();
  const pm = await resolvePackageManager({
    root,
    project: project.packageManager,
    global: config.packageManager,
  });

  const plan: ProjectPlan = project.plan ?? "free";
  const installed = new Set(project.features.map((feature) => feature.id));
  const nothingSelected =
    !options.web &&
    !options.rules &&
    !options.functions &&
    !options.auth &&
    mobile.platforms.length === 0;

  const targets: string[] = [];

  if (options.web || nothingSelected) {
    if (!installed.has("hosting")) {
      if (options.web) {
        throw new RadianceError(
          "This project has no hosting module",
          "Install it with `radiance add hosting`.",
        );
      }
    } else {
      await exportWeb(root, pm);
      targets.push("hosting");
    }
  }

  if (options.rules || nothingSelected) {
    if (
      existsSync(join(root, "firestore.rules")) ||
      existsSync(join(root, "firestore.indexes.json"))
    ) {
      targets.push("firestore");
    }
    if (existsSync(join(root, "storage.rules"))) targets.push("storage");
  }

  if (options.auth || nothingSelected) {
    if (await hasAuthProvidersConfig(root)) targets.push("auth");
  }

  if (options.functions || nothingSelected) {
    if (installed.has("functions")) {
      targets.push("functions");
    } else if (options.functions) {
      throw new RadianceError(
        "This project has no functions module",
        "Install it with `radiance add functions`.",
      );
    }
  }

  const blocked = targets.filter((target) => PAID_DEPLOY_TARGETS.has(target));
  if (plan === "free" && blocked.length > 0) {
    if (options.functions && blocked.includes("functions")) {
      throw new RadianceError(
        "This project is on the free plan — cannot deploy Functions to the cloud",
        "Functions use local emulators on the free plan. Upgrade with `radiance setup firebase --plan paid`, then retry.",
      );
    }
    const allowed = targets.filter(
      (target) => !PAID_DEPLOY_TARGETS.has(target),
    );
    ui.warn(
      `Skipping cloud deploy for ${blocked.join(", ")} (free plan — emulators only).`,
    );
    ui.detail(
      "Upgrade with `radiance setup firebase --plan paid` when you need them in production.",
    );
    targets.length = 0;
    targets.push(...allowed);
  }

  const willBuildApp =
    targets.includes("hosting") ||
    (mobile.mode !== undefined && mobile.platforms.length > 0);
  const willDeployFunctions = targets.includes("functions");

  if (willBuildApp || willDeployFunctions) {
    await assertReadyForDeploy(root, project, {
      checkClientEnv: willBuildApp,
      checkFunctions: willDeployFunctions,
      projectId: options.project,
    });
  }

  if (targets.includes("functions")) {
    await buildFunctions(root, pm);
  }

  if (targets.length > 0) {
    await assertFirebaseCli();
    ui.heading(`Deploying ${targets.join(", ")}`);
    await firebaseDeploy(root, targets, { projectId: options.project });
    ui.success("Deployed Firebase targets.");
  }

  if (mobile.mode && mobile.platforms.length > 0) {
    await deployMobile(root, mobile.platforms, mobile.mode, options);
  }

  if (targets.length === 0 && !mobile.mode) {
    ui.info("Nothing to deploy.");
  }
}

async function deployMobile(
  root: string,
  platforms: NativePlatform[],
  mode: MobileDistributionMode,
  options: DeployOptions,
): Promise<void> {
  const profile = defaultProfileForMode(
    mode,
    Boolean(options.submit),
    options.profile,
  );

  if (mode === "eas") {
    assertEasJson(root);
    await assertEasCli();
    ui.heading(`EAS build (${platforms.join(", ")}, profile ${profile})`);
    const outDir = resolveOutDir(root);
    await buildNativeArtifacts(root, {
      platforms,
      profile,
      local: false,
      outDir,
    });

    if (options.submit) {
      for (const platform of platforms) {
        ui.step(`Submitting ${platform} to the store (EAS)`);
        const result = await execa(
          "eas",
          [
            "submit",
            "--platform",
            platform,
            "--profile",
            profile,
            "--latest",
            "--non-interactive",
          ],
          { cwd: root, stdio: "inherit", reject: false, timeout: 0 },
        );
        if (result.exitCode !== 0) {
          throw new RadianceError(
            `EAS submit for ${platform} failed`,
            "Configure store credentials with EAS, then retry. See https://docs.expo.dev/submit/introduction/",
          );
        }
      }
    }

    ui.success(`EAS ${options.submit ? "build + submit" : "build"} finished.`);
    ui.detail(`Artifacts under ${outDir}`);
    return;
  }

  // app-distribution | local — need binaries on disk (cloud EAS by default; reuse --from)
  let artifacts: NativeArtifact[];
  const outDir = resolveOutDir(root);

  if (options.from) {
    artifacts = await findNativeBinaries(resolveOutDir(root, options.from));
  } else {
    artifacts = await buildNativeArtifacts(root, {
      platforms,
      profile,
      local: false,
      outDir,
    });
  }

  const filtered = artifacts.filter((artifact) =>
    platforms.includes(artifact.platform),
  );
  if (filtered.length === 0) {
    throw new RadianceError(
      `No ${platforms.join("/")} binaries available`,
      "Run `radiance build --android --ios` or pass `--from <dir>`.",
    );
  }

  if (mode === "local") {
    const stored = options.from
      ? await copyArtifactsToDir(filtered, outDir)
      : filtered;
    ui.heading("Local mobile artifacts");
    for (const artifact of stored) {
      ui.detail(`${artifact.platform}: ${artifact.path}`);
    }
    ui.success("Stored mobile artifacts locally.");
    return;
  }

  await assertFirebaseCli();
  await distributeArtifacts(root, filtered, platforms, {
    projectId: options.project,
    groups: options.groups,
    testers: options.testers,
    releaseNotes: options.releaseNotes,
  });
  ui.success("Distributed to Firebase App Distribution.");
}

async function hasAuthProvidersConfig(root: string): Promise<boolean> {
  const path = join(root, "firebase.json");
  if (!existsSync(path)) return false;
  try {
    const json = JSON.parse(await readFile(path, "utf8")) as {
      auth?: { providers?: Record<string, unknown> };
    };
    return Boolean(
      json.auth?.providers && Object.keys(json.auth.providers).length > 0,
    );
  } catch {
    return false;
  }
}
