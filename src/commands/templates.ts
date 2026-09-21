import pc from "picocolors";
import semver from "semver";

import {
  ensureTemplateSource,
  fetchRemoteVersions,
  listCachedVersions,
  pruneReleases,
  readCacheState,
} from "../core/cache.js";
import { loadConfig } from "../core/config.js";
import { ui } from "../core/logger.js";
import { findProjectRoot, readProjectConfig } from "../core/project.js";

export async function templatesListCommand(): Promise<void> {
  const config = await loadConfig();
  const source = await ensureTemplateSource(config);

  ui.heading(
    `Templates ${source.version}${source.local ? pc.dim(" (local checkout)") : ""}`,
  );
  ui.detail(`Expo SDK ${source.registry.expoSdk} · ${source.root}`);

  ui.heading("Starters");
  for (const starter of source.registry.starters) {
    console.log(`  ${pc.bold(starter.id)} ${pc.dim(`v${starter.version}`)}`);
    console.log(`    ${starter.description}`);
    console.log(pc.dim(`    modules: ${starter.modules.join(", ")}`));
  }

  ui.heading("Modules");
  const installed = await installedFeatureIds();
  for (const module of source.registry.modules) {
    const mark = installed.has(module.id) ? pc.green("●") : pc.dim("○");
    console.log(
      `  ${mark} ${pc.bold(module.id)} ${pc.dim(`v${module.version}`)} — ${module.title}`,
    );
    console.log(pc.dim(`    ${module.capabilities.slice(0, 6).join(", ")}`));
  }

  if (installed.size > 0) {
    ui.blank();
    ui.detail(`${pc.green("●")} installed in this project`);
  }
}

export async function templatesOutdatedCommand(): Promise<void> {
  const config = await loadConfig();
  const state = await readCacheState();
  const cached = await listCachedVersions();

  ui.heading("Template cache");
  if (config.templatesPath) {
    ui.detail(`Using a local checkout: ${config.templatesPath}`);
    ui.detail("Version checks do not apply to a working copy.");
    return;
  }

  ui.detail(`active   ${state.activeVersion ?? "none"}`);
  ui.detail(`cached   ${cached.length > 0 ? cached.join(", ") : "none"}`);
  ui.detail(`checked  ${state.lastChecked ?? "never"}`);

  const remote = await fetchRemoteVersions(config.templatesRepo);
  if (remote.length === 0) {
    ui.warn(`Could not reach ${config.templatesRepo}.`);
    return;
  }

  const latest = remote[0]!;
  ui.detail(`latest   ${latest}`);

  const active = state.activeVersion;
  if (!active) {
    ui.info(
      "No cache yet — the next command that needs templates will download one.",
    );
  } else if (semver.eq(active, latest)) {
    ui.success("The cache is up to date.");
  } else if (semver.major(latest) > semver.major(active)) {
    ui.warn(
      `A new major release is available (${active} → ${latest}). Run \`radiance upgrade\`.`,
    );
  } else {
    ui.info(
      `A newer release is available (${active} → ${latest}). Run \`radiance update\`.`,
    );
  }

  await reportProjectDrift();
}

export async function templatesPruneCommand(): Promise<void> {
  const state = await readCacheState();
  const projectVersion = await currentProjectRegistryVersion();

  const keep = [state.activeVersion, projectVersion].filter(
    (value): value is string => Boolean(value),
  );

  const removed = await pruneReleases(keep);

  if (removed.length === 0) {
    ui.info("Nothing to prune.");
    return;
  }

  ui.success(`Removed cached releases: ${removed.join(", ")}`);
  ui.detail(`Kept: ${keep.join(", ") || "none"}`);
}

async function installedFeatureIds(): Promise<Set<string>> {
  const root = findProjectRoot();
  if (!root) return new Set();
  const project = await readProjectConfig(root);
  return new Set(project.features.map((feature) => feature.id));
}

async function currentProjectRegistryVersion(): Promise<string | null> {
  const root = findProjectRoot();
  if (!root) return null;
  return (await readProjectConfig(root)).registryVersion;
}

async function reportProjectDrift(): Promise<void> {
  const root = findProjectRoot();
  if (!root) return;

  const project = await readProjectConfig(root);
  const state = await readCacheState();

  if (state.activeVersion && project.registryVersion !== state.activeVersion) {
    ui.blank();
    ui.info(
      `This project is pinned to templates ${project.registryVersion}; the cache is on ${state.activeVersion}.`,
    );
    ui.detail("Run `radiance update --project` to sync its modules.");
  }
}
