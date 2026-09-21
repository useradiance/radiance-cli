import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR = "radiance";

/** XDG-style locations, with the macOS caches directory when it applies. */
export function configDir(): string {
  if (process.env.RADIANCE_CONFIG_DIR) return process.env.RADIANCE_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, APP_DIR);
}

export function configFile(): string {
  return join(configDir(), "config.json");
}

export function cacheDir(): string {
  if (process.env.RADIANCE_CACHE_DIR) return process.env.RADIANCE_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME)
    return join(process.env.XDG_CACHE_HOME, APP_DIR);
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Caches", APP_DIR);
  return join(homedir(), ".cache", APP_DIR);
}

export function templatesCacheDir(): string {
  return join(cacheDir(), "templates");
}

export function releasesDir(): string {
  return join(templatesCacheDir(), "releases");
}

export function releaseDir(version: string): string {
  return join(releasesDir(), version);
}

export function cacheStateFile(): string {
  return join(templatesCacheDir(), "cache.json");
}

export const PROJECT_CONFIG_FILE = "radiance.json";
export const CONSTITUTION_FILE = "RADIANCE.md";
export const RUNS_DIR = join(".radiance", "runs");
export const PROJECT_LOGS_DIR = join(".radiance", "logs");
export const PROJECT_ARTIFACTS_DIR = join(".radiance", "artifacts");

/** Global CLI logs when no project root is available yet (e.g. early `init`). */
export function globalLogsDir(): string {
  return join(cacheDir(), "logs");
}

export function projectLogsDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_LOGS_DIR);
}
