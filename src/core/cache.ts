import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { z } from "zod";

import type { GlobalConfig } from "./config.js";
import { RadianceError, ui } from "./logger.js";
import {
  cacheStateFile,
  releaseDir,
  releasesDir,
  templatesCacheDir,
} from "./paths.js";
import { readRegistry, type TemplateSource } from "./registry.js";

const CacheStateSchema = z.object({
  activeVersion: z.string().nullable().default(null),
  lastChecked: z.string().nullable().default(null),
  sourceRepo: z.string().nullable().default(null),
});

export type CacheState = z.infer<typeof CacheStateSchema>;

export async function readCacheState(): Promise<CacheState> {
  try {
    return CacheStateSchema.parse(
      JSON.parse(await readFile(cacheStateFile(), "utf8")),
    );
  } catch {
    return { activeVersion: null, lastChecked: null, sourceRepo: null };
  }
}

export async function writeCacheState(state: CacheState): Promise<void> {
  await mkdir(templatesCacheDir(), { recursive: true });
  await writeFile(
    cacheStateFile(),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

export async function listCachedVersions(): Promise<string[]> {
  try {
    const entries = await readdir(releasesDir(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => (semver.gt(a, b) ? -1 : 1));
  } catch {
    return [];
  }
}

/** Release tags published on the templates repository, newest first. */
export async function fetchRemoteVersions(repo: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      "git",
      ["ls-remote", "--tags", "--refs", repo],
      {
        timeout: 20_000,
      },
    );

    return stdout
      .split("\n")
      .map((line) => line.split("refs/tags/")[1]?.trim())
      .filter((tag): tag is string => Boolean(tag))
      .map((tag) => tag.replace(/^v/, ""))
      .filter((version) => semver.valid(version) !== null)
      .sort((a, b) => (semver.gt(a, b) ? -1 : 1));
  } catch {
    return [];
  }
}

export async function downloadRelease(
  repo: string,
  version: string,
): Promise<string> {
  const target = releaseDir(version);
  if (existsSync(target)) return target;

  await mkdir(releasesDir(), { recursive: true });
  ui.step(`Downloading templates ${version}…`);
  ui.trace(`git clone --depth 1 --branch v${version} ${repo}`);

  try {
    // Each release is a fresh shallow clone: cached versions stay immutable, so a project
    // pinned to 1.1.0 keeps building the same way after 1.2.0 lands.
    await execa(
      "git",
      ["clone", "--depth", "1", "--branch", `v${version}`, repo, target],
      {
        timeout: 120_000,
      },
    );
    await rm(join(target, ".git"), { recursive: true, force: true });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw new RadianceError(
      `Could not download templates ${version} from ${repo}`,
      error instanceof Error ? error.message : undefined,
    );
  }

  return target;
}

async function sourceFromDirectory(
  root: string,
  version: string,
  local: boolean,
): Promise<TemplateSource> {
  const registry = await readRegistry(root);
  return { root, version: local ? registry.version : version, registry, local };
}

export type EnsureOptions = {
  /** Fetch a specific release instead of the active one. */
  version?: string;
  /** Check the remote for a newer release even when a cache already exists. */
  refresh?: boolean;
  /** Allow major upgrades when refreshing. */
  allowMajor?: boolean;
};

/**
 * Resolves the template catalogue to use.
 *
 * A local checkout (config `templatesPath` / `RADIANCE_TEMPLATES_PATH`) always wins — that is
 * how the catalogue itself is developed. Otherwise the immutable release cache is used, and
 * the network is touched only when the cache is missing or a refresh was requested.
 */
export async function ensureTemplateSource(
  config: GlobalConfig,
  options: EnsureOptions = {},
): Promise<TemplateSource> {
  if (config.templatesPath) {
    if (!existsSync(join(config.templatesPath, "registry.json"))) {
      throw new RadianceError(
        `No registry.json in ${config.templatesPath}`,
        "templatesPath must point at a radiance-templates checkout.",
      );
    }
    return sourceFromDirectory(config.templatesPath, "local", true);
  }

  const state = await readCacheState();
  const cached = await listCachedVersions();

  if (options.version) {
    const root = await downloadRelease(config.templatesRepo, options.version);
    return sourceFromDirectory(root, options.version, false);
  }

  const pinned =
    config.templatesChannel !== "latest" ? config.templatesChannel : null;
  if (pinned) {
    const root = existsSync(releaseDir(pinned))
      ? releaseDir(pinned)
      : await downloadRelease(config.templatesRepo, pinned);
    return sourceFromDirectory(root, pinned, false);
  }

  const active = state.activeVersion;
  const hasActive = active !== null && existsSync(releaseDir(active));

  if (hasActive && !options.refresh) {
    return sourceFromDirectory(releaseDir(active), active, false);
  }

  const remote = await fetchRemoteVersions(config.templatesRepo);
  const candidate = pickTarget(remote, active, options.allowMajor ?? false);

  if (!candidate) {
    if (hasActive) {
      ui.warn(
        "Could not reach the templates repository — using the cached release.",
      );
      return sourceFromDirectory(releaseDir(active), active, false);
    }
    if (cached[0]) {
      return sourceFromDirectory(releaseDir(cached[0]), cached[0], false);
    }
    throw new RadianceError(
      "No templates available",
      `Could not reach ${config.templatesRepo} and nothing is cached. Point at a local checkout with \`radiance config set templatesPath <dir>\`.`,
    );
  }

  const root = await downloadRelease(config.templatesRepo, candidate);
  await writeCacheState({
    activeVersion: candidate,
    lastChecked: new Date().toISOString(),
    sourceRepo: config.templatesRepo,
  });

  return sourceFromDirectory(root, candidate, false);
}

/** Newest release we are allowed to move to: same major unless a major bump was requested. */
export function pickTarget(
  remote: string[],
  current: string | null,
  allowMajor: boolean,
): string | undefined {
  if (remote.length === 0) return undefined;
  if (!current || allowMajor) return remote[0];

  return (
    remote.find((version) => semver.major(version) === semver.major(current)) ??
    current
  );
}

export async function pruneReleases(keep: string[]): Promise<string[]> {
  const versions = await listCachedVersions();
  const removed: string[] = [];

  for (const version of versions) {
    if (keep.includes(version)) continue;
    await rm(releaseDir(version), { recursive: true, force: true });
    removed.push(version);
  }

  return removed;
}
