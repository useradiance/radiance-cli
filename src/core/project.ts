import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { z } from "zod";

import { RadianceError } from "./logger.js";
import { PackageManagerSchema } from "./package-manager.js";
import { PROJECT_CONFIG_FILE } from "./paths.js";

export const InstalledFeatureSchema = z.object({
  id: z.string(),
  version: z.string(),
  /** Resolved module options from install time (e.g. auth providers). */
  options: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .default({}),
});

export const ProjectConfigSchema = z.object({
  name: z.string(),
  /** Starter this project was created from, or null for a bare scaffold. */
  template: z.string().nullable().default(null),
  templateVersion: z.string().nullable().default(null),
  registryVersion: z.string(),
  scaffold: z.object({ id: z.string(), version: z.string() }),
  themePack: z.string().default("neutral"),
  defaultLocale: z.string().default("en"),
  /** All shipped locale codes (includes defaultLocale). */
  locales: z.array(z.string()).default(["en"]),
  bundleId: z.string(),
  scheme: z.string(),
  /** Package manager used to install and run this project. */
  packageManager: PackageManagerSchema.optional(),
  /**
   * Cloud posture for this app.
   * `free` — Auth/Firestore/Hosting in cloud; Storage + Functions via emulators only.
   * `paid` — full cloud deploy including Storage and Functions (billing account required).
   */
  plan: z.enum(["free", "paid"]).optional(),
  /** Optional demo seed was requested at init (`--demo`). */
  demo: z.boolean().optional(),
  features: z.array(InstalledFeatureSchema).default([]),
  harness: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      gitAutoCommit: z.boolean().optional(),
      verify: z.boolean().optional(),
    })
    .default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectPlan = NonNullable<ProjectConfig["plan"]>;

/** Walks up from `from` looking for radiance.json, the way git finds its root. */
export function findProjectRoot(from: string = process.cwd()): string | null {
  let current = from;

  for (;;) {
    if (existsSync(join(current, PROJECT_CONFIG_FILE))) return current;
    const parent = dirname(current);
    if (parent === current || parent === parse(current).root) return null;
    current = parent;
  }
}

export async function readProjectConfig(root: string): Promise<ProjectConfig> {
  const path = join(root, PROJECT_CONFIG_FILE);
  try {
    return ProjectConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new RadianceError(
      `Could not read ${PROJECT_CONFIG_FILE} in ${root}`,
      error instanceof Error ? error.message : undefined,
    );
  }
}

export async function writeProjectConfig(
  root: string,
  config: ProjectConfig,
): Promise<void> {
  await writeFile(
    join(root, PROJECT_CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

export async function requireProject(
  from?: string,
): Promise<{ root: string; config: ProjectConfig }> {
  const start = from === undefined ? process.cwd() : resolve(from);
  if (from !== undefined && !existsSync(start)) {
    throw new RadianceError(`Path does not exist: ${start}`);
  }

  const root = findProjectRoot(start);
  if (!root) {
    throw new RadianceError(
      from === undefined
        ? "Not inside a Radiance project"
        : `Not a Radiance project: ${start}`,
      `No ${PROJECT_CONFIG_FILE} found ${
        from === undefined
          ? "here or in any parent directory"
          : "in that path or any parent directory"
      }. Create one with \`radiance init <name>\`.`,
    );
  }
  return { root, config: await readProjectConfig(root) };
}

export function isFeatureInstalled(config: ProjectConfig, id: string): boolean {
  return config.features.some((feature) => feature.id === id);
}

export function recordFeature(
  config: ProjectConfig,
  id: string,
  version: string,
  options: Record<string, string | string[]> = {},
): ProjectConfig {
  const features = config.features.filter((feature) => feature.id !== id);
  features.push({ id, version, options });
  features.sort((a, b) => a.id.localeCompare(b.id));
  return { ...config, features };
}
