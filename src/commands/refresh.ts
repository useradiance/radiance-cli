import pc from "picocolors";
import semver from "semver";

import { applyChanges, reportNotes } from "../core/apply/writer.js";
import { ensureTemplateSource, readCacheState } from "../core/cache.js";
import { loadConfig } from "../core/config.js";
import { deriveVars, stageInstall } from "../core/install.js";
import { bindLogSession, ui } from "../core/logger.js";
import {
  findProjectRoot,
  readProjectConfig,
  writeProjectConfig,
} from "../core/project.js";

export type RefreshMode = "update" | "upgrade";

export type RefreshOptions = {
  /** Also sync the modules installed in the current project. */
  project?: boolean;
  yes?: boolean;
  dryRun?: boolean;
};

/**
 * `update` refreshes the cache within the current major; `upgrade` allows a major bump.
 *
 * Refreshing the cache never touches a project. Syncing a project is a separate, explicit
 * step (`--project`) and every file goes through the same diff confirmation as `add`.
 */
export async function refreshCommand(
  mode: RefreshMode,
  options: RefreshOptions,
): Promise<void> {
  const config = await loadConfig();
  const before = (await readCacheState()).activeVersion;
  const projectRoot = findProjectRoot();
  if (projectRoot) bindLogSession(projectRoot);
  ui.trace(`refresh mode=${mode} project=${Boolean(options.project)}`);

  if (config.templatesPath) {
    ui.info(
      `Using a local checkout (${config.templatesPath}) — nothing to download.`,
    );
  }

  const source = await ensureTemplateSource(config, {
    refresh: true,
    allowMajor: mode === "upgrade",
  });

  if (!config.templatesPath) {
    if (before && semver.valid(before) && semver.valid(source.version)) {
      if (semver.eq(before, source.version)) {
        ui.success(`Templates are already at ${source.version}.`);
      } else {
        ui.success(`Templates ${before} → ${pc.bold(source.version)}`);
        if (semver.major(source.version) > semver.major(before)) {
          ui.warn(
            "This is a major release — review the changelog before syncing a project.",
          );
        }
      }
    } else {
      ui.success(`Templates cached at ${source.version}.`);
    }
  }

  if (!options.project) {
    const root = findProjectRoot();
    if (root) {
      const project = await readProjectConfig(root);
      if (project.registryVersion !== source.registry.version) {
        ui.blank();
        ui.info(
          `This project still uses ${project.registryVersion}. Run \`radiance ${mode} --project\` to sync it.`,
        );
      }
    }
    return;
  }

  const root = findProjectRoot();
  if (!root) {
    ui.warn("Not inside a Radiance project — skipped the project sync.");
    return;
  }

  const project = await readProjectConfig(root);
  const featureIds = project.features.map((feature) => feature.id);

  if (featureIds.length === 0) {
    ui.info("No modules installed in this project.");
    return;
  }

  if (
    mode === "update" &&
    semver.valid(project.registryVersion) &&
    semver.valid(source.registry.version)
  ) {
    if (
      semver.major(source.registry.version) >
      semver.major(project.registryVersion)
    ) {
      ui.warn(
        `Templates ${source.registry.version} is a major release ahead of this project (${project.registryVersion}).`,
      );
      ui.detail("Run `radiance upgrade --project` to accept a breaking sync.");
      return;
    }
  }

  ui.heading(
    `Syncing ${featureIds.length} modules to ${source.registry.version}`,
  );

  const vars = deriveVars(project.name, {
    themePack: project.themePack,
    defaultLocale: project.defaultLocale,
    bundleId: project.bundleId,
    scheme: project.scheme,
  });

  // Re-apply every installed module from the new catalogue. Files the user edited are
  // reported as conflicts and left alone.
  const staged = await stageInstall({
    root,
    source,
    vars,
    scaffold: false,
    starterId: null,
    moduleIds: featureIds,
    installed: [],
    existingFeatures: project.features,
  });

  const updatedProject = {
    ...project,
    registryVersion: source.registry.version,
    scaffold: {
      id: source.registry.scaffold.id,
      version: source.registry.scaffold.version,
    },
    features: staged.features,
  };

  await staged.workspace.write(
    "radiance.json",
    `${JSON.stringify(updatedProject, null, 2)}\n`,
    "radiance",
  );

  const changes = staged.workspace.changes();
  if (changes.length === 0) {
    ui.success("Project modules are already current.");
    return;
  }

  const result = await applyChanges(root, changes, {
    confirm: !options.yes,
    dryRun: options.dryRun ?? false,
  });

  reportNotes(staged.workspace.getNotes());

  if (result.cancelled || result.written.length === 0) return;

  await writeProjectConfig(root, updatedProject);
  ui.success(`Project synced to templates ${source.registry.version}.`);

  if (result.skipped.length > 0) {
    ui.detail(`${result.skipped.length} file(s) left untouched.`);
  }
}
