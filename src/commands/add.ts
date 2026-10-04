import * as prompts from "@clack/prompts";
import { execa } from "execa";
import pc from "picocolors";

import { Workspace } from "../core/apply/workspace.js";
import { applyChanges, reportNotes } from "../core/apply/writer.js";
import { ensureTemplateSource } from "../core/cache.js";
import { loadConfig } from "../core/config.js";
import { upsertWorkspaceEnv } from "../core/env.js";
import { maybeRedeployCloudArtifacts } from "../core/firebase-provision.js";
import { deriveVars, stageInstall } from "../core/install.js";
import {
  maybeSweepI18n,
  maybeTranslateLocales,
} from "../core/locale-pipeline.js";
import { RadianceError, bindLogSession, ui } from "../core/logger.js";
import {
  formatInstallHint,
  formatInstallInDirHint,
  resolvePackageManager,
  runScriptInDirCommand,
} from "../core/package-manager.js";
import {
  isFeatureInstalled,
  requireProject,
  writeProjectConfig,
  type ProjectConfig,
} from "../core/project.js";

export type AddOptions = {
  yes?: boolean;
  dryRun?: boolean;
  /** @deprecated Prefer --option pack=… */
  pack?: string;
  option?: string[];
  force?: boolean;
  /**
   * Sweep and translate the project's locales once the modules are in.
   *
   * A module brings its own English strings, so in a multi-locale project
   * every other catalogue is missing them until they are translated — the
   * French app would show the new screens in English.
   */
  translateLocales?: boolean;
  /** Model for the sweep and translation; mirrors `radiance prompt`. */
  provider?: string;
  model?: string;
  /** `--translation-memory <dir>`, for the translation above. */
  translationMemory?: string;
};

export async function addCommand(
  moduleIds: string[],
  options: AddOptions,
): Promise<void> {
  await installModules(moduleIds, options);

  /*
   * Translation runs whatever the install did — including nothing.
   *
   * `installModules` returns early when every requested module is already
   * present, which is common when a caller cannot know the starter's module
   * list in advance (the hosted platform lets the CLI pick the starter). Tying
   * translation to "something was installed" left those projects' catalogues
   * in English without a word.
   */
  if (options.translateLocales && !options.dryRun) {
    const { root, config: project } = await requireProject();
    const locales = project.locales ?? [];
    if (locales.some((code) => code !== "en")) {
      const config = await loadConfig();
      // Sweep first so strings a module hard-codes are in `en.json` before the
      // other catalogues are translated from it.
      await maybeSweepI18n(root, locales, config, options);
      await maybeTranslateLocales(root, locales, config, options);
    }
  }
}

async function installModules(
  moduleIds: string[],
  options: AddOptions,
): Promise<void> {
  const { root, config: project } = await requireProject();
  bindLogSession(root);
  const config = await loadConfig();
  const source = await ensureTemplateSource(config);
  ui.trace(
    `add modules=[${moduleIds.join(", ") || "(prompt)"}] force=${Boolean(options.force)}`,
  );

  const ids =
    moduleIds.length > 0
      ? moduleIds
      : await pickModules(source, project.features);
  if (ids.length === 0) return;

  const alreadyInstalled = ids.filter((id) => isFeatureInstalled(project, id));
  if (alreadyInstalled.length > 0 && !options.force) {
    ui.info(
      `Already installed: ${alreadyInstalled.join(", ")}. Use --force to reapply from the catalogue.`,
    );
  }

  const target = options.force
    ? ids
    : ids.filter((id) => !alreadyInstalled.includes(id));
  if (target.length === 0) {
    // Adding demo-data when it is already present still turns seeding on —
    // same outcome as a fresh install / `init --demo`.
    if (
      ids.includes("demo-data") &&
      isFeatureInstalled(project, "demo-data") &&
      !options.dryRun
    ) {
      await enableDemoSeed(root, project);
    }
    return;
  }

  const installed = options.force
    ? project.features
        .filter((feature) => !target.includes(feature.id))
        .map((f) => f.id)
    : project.features.map((feature) => feature.id);

  const optionFlags = [
    ...(options.option ?? []),
    ...(options.pack ? [`pack=${options.pack}`] : []),
  ];

  const vars = deriveVars(project.name, {
    themePack: project.themePack,
    defaultLocale: project.defaultLocale,
    bundleId: project.bundleId,
    scheme: project.scheme,
  });

  const staged = await stageInstall({
    root,
    source,
    vars,
    scaffold: false,
    starterId: null,
    moduleIds: target,
    installed,
    existingFeatures: project.features,
    optionFlags,
    interactiveOptions: !options.yes && optionFlags.length === 0,
  });

  const added = staged.manifests.map((manifest) => manifest.id);
  const implied = added.filter((id) => !target.includes(id));

  ui.heading(`Installing ${added.map((id) => pc.bold(id)).join(", ")}`);
  if (implied.length > 0) {
    ui.detail(`pulled in as dependencies: ${implied.join(", ")}`);
  }

  for (const [id, resolved] of Object.entries(staged.resolvedOptions)) {
    const summary = Object.entries(resolved)
      .map(
        ([key, value]) =>
          `${key}=${Array.isArray(value) ? value.join(",") : value}`,
      )
      .join(" ");
    if (summary) ui.detail(`${id}: ${summary}`);
  }

  const enableDemo = added.includes("demo-data");
  if (enableDemo) {
    await upsertWorkspaceEnv(
      staged.workspace,
      { EXPO_PUBLIC_SEED_DEMO: "true" },
      "demo-data",
    );
  }

  const updatedProject: ProjectConfig = {
    ...project,
    features: staged.features,
    themePack: vars.themePack,
    ...(enableDemo ? { demo: true } : {}),
  };
  await staged.workspace.write(
    "radiance.json",
    `${JSON.stringify(updatedProject, null, 2)}\n`,
    "radiance",
  );

  const changes = staged.workspace.changes();
  const result = await applyChanges(root, changes, {
    confirm: !options.yes,
    dryRun: options.dryRun ?? false,
  });

  reportNotes(staged.workspace.getNotes());

  if (result.cancelled || result.written.length === 0) return;

  await writeProjectConfig(root, updatedProject);

  ui.blank();
  ui.success(`Installed ${added.join(", ")}`);

  if (enableDemo) {
    ui.detail(
      "EXPO_PUBLIC_SEED_DEMO=true (demo seed on first signed-in launch)",
    );
  }

  const notes = staged.manifests.flatMap((manifest) =>
    manifest.notes.map((note) => `${manifest.id}: ${note}`),
  );

  if (notes.length > 0) {
    ui.heading("Worth knowing");
    for (const note of notes) ui.detail(note);
  }

  const dependenciesChanged = result.written.some(
    (change) => change.path === "package.json",
  );
  const functionsPackageChanged = result.written.some(
    (change) => change.path === "functions/package.json",
  );
  if (dependenciesChanged || functionsPackageChanged) {
    const pm = await resolvePackageManager({
      root,
      project: updatedProject.packageManager,
      global: config.packageManager,
    });
    ui.blank();
    if (dependenciesChanged) {
      ui.info(`Run ${pc.bold(formatInstallHint(pm))} to pick up new packages.`);
    }
    if (functionsPackageChanged) {
      ui.info(
        `Run ${pc.bold(formatInstallInDirHint(pm, "functions"))} for Cloud Functions dependencies.`,
      );
    }
  }

  if (!options.dryRun) {
    await maybeRedeployCloudArtifacts(
      root,
      result.written.map((change) => change.path),
      {
        plan: updatedProject.plan ?? project.plan ?? "free",
        buildFunctions: async () => {
          const pm = await resolvePackageManager({
            root,
            project: updatedProject.packageManager,
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
      },
    );
  }
}

/** Match `init --demo`: flip the client gate and record demo on the project. */
async function enableDemoSeed(
  root: string,
  project: ProjectConfig,
): Promise<void> {
  const workspace = new Workspace(root);
  await upsertWorkspaceEnv(
    workspace,
    { EXPO_PUBLIC_SEED_DEMO: "true" },
    "demo-data",
  );
  const changes = workspace.changes();
  await applyChanges(root, changes, { confirm: false, dryRun: false });
  if (!project.demo) {
    await writeProjectConfig(root, { ...project, demo: true });
  }
  ui.success("Enabled demo seed (EXPO_PUBLIC_SEED_DEMO=true)");
  ui.detail("Restart the Expo dev server, then sign in once to seed.");
}

async function pickModules(
  source: Awaited<ReturnType<typeof ensureTemplateSource>>,
  features: { id: string }[],
): Promise<string[]> {
  const installed = new Set(features.map((feature) => feature.id));
  const available = source.registry.modules.filter(
    (module) => !installed.has(module.id),
  );

  if (available.length === 0) {
    ui.info("Every module in the catalogue is already installed.");
    return [];
  }

  const choice = await prompts.multiselect({
    message: "Which modules do you want to add?",
    options: available.map((module) => ({
      value: module.id,
      label: module.title,
      hint: module.description,
    })),
    required: false,
  });

  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
  return choice as string[];
}
