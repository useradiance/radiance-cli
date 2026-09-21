import { execa } from "execa";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { RadianceError } from "./logger.js";

export const PACKAGE_MANAGERS = ["npm", "yarn", "pnpm", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const PackageManagerSchema = z.enum(PACKAGE_MANAGERS);

/** Prefer yarn when several managers are available — matches the previous CLI default. */
const PREFERENCE_ORDER: PackageManager[] = ["yarn", "pnpm", "npm", "bun"];

const LOCKFILES: Record<PackageManager, readonly string[]> = {
  npm: ["package-lock.json"],
  yarn: ["yarn.lock"],
  pnpm: ["pnpm-lock.yaml"],
  bun: ["bun.lockb", "bun.lock"],
};

export const ALL_LOCKFILES = Object.values(LOCKFILES).flat();

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

export function parsePackageManager(value: string): PackageManager {
  const normalised = value.trim().toLowerCase();
  if (!isPackageManager(normalised)) {
    throw new RadianceError(
      `Unknown package manager "${value}"`,
      `Choose one of: ${PACKAGE_MANAGERS.join(", ")}.`,
    );
  }
  return normalised;
}

/** Detect which package manager owns an existing project via its lockfile. */
export function detectFromLockfile(root: string): PackageManager | null {
  for (const pm of PREFERENCE_ORDER) {
    if (LOCKFILES[pm].some((file) => existsSync(join(root, file)))) return pm;
  }
  return null;
}

export async function commandVersion(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execa(command, args, { timeout: 15_000 });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

export async function detectInstalled(): Promise<
  Partial<Record<PackageManager, string>>
> {
  const versions: Partial<Record<PackageManager, string>> = {};

  await Promise.all(
    PACKAGE_MANAGERS.map(async (pm) => {
      const version = await commandVersion(pm, ["--version"]);
      if (version) versions[pm] = version;
    }),
  );

  return versions;
}

export type ResolvePackageManagerInput = {
  /** Explicit CLI choice (`--pm`). */
  preferred?: string | null;
  /** Value stored in `radiance.json`. */
  project?: string | null;
  /** Value from global CLI config. */
  global?: string | null;
  /** Project root used for lockfile detection. */
  root?: string;
  /** Pre-fetched install map; detected when omitted. */
  installed?: Partial<Record<PackageManager, string>>;
};

/**
 * Picks a package manager in priority order:
 * CLI flag → project config → lockfile → global config → first installed (yarn preferred).
 */
export async function resolvePackageManager(
  input: ResolvePackageManagerInput = {},
): Promise<PackageManager> {
  const candidates: Array<{
    value: string | null | undefined;
    source: string;
  }> = [
    { value: input.preferred, source: "--pm" },
    { value: input.project, source: "radiance.json" },
    {
      value: input.root ? detectFromLockfile(input.root) : null,
      source: "lockfile",
    },
    { value: input.global, source: "config" },
  ];

  const installed = input.installed ?? (await detectInstalled());

  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const pm = parsePackageManager(candidate.value);
    if (!installed[pm]) {
      throw new RadianceError(
        `${pm} is configured (${candidate.source}) but not installed`,
        `Install ${pm}, or pick another manager with --pm (${PACKAGE_MANAGERS.join(", ")}).`,
      );
    }
    return pm;
  }

  for (const pm of PREFERENCE_ORDER) {
    if (installed[pm]) return pm;
  }

  throw new RadianceError(
    "No Node package manager found",
    `Install one of: ${PACKAGE_MANAGERS.join(", ")}.`,
  );
}

export function installCommand(pm: PackageManager): {
  command: string;
  args: string[];
} {
  switch (pm) {
    case "npm":
      return { command: "npm", args: ["install"] };
    case "yarn":
      return { command: "yarn", args: ["install"] };
    case "pnpm":
      return { command: "pnpm", args: ["install"] };
    case "bun":
      return { command: "bun", args: ["install"] };
  }
}

/** Install dependencies in a project subdirectory (e.g. `functions`). */
export function installInDirCommand(
  pm: PackageManager,
  dir: string,
): { command: string; args: string[] } {
  switch (pm) {
    case "npm":
      return { command: "npm", args: ["install", "--prefix", dir] };
    case "yarn":
      return { command: "yarn", args: ["--cwd", dir, "install"] };
    case "pnpm":
      return { command: "pnpm", args: ["--dir", dir, "install"] };
    case "bun":
      return { command: "bun", args: ["--cwd", dir, "install"] };
  }
}

export function formatInstallInDirHint(
  pm: PackageManager,
  dir: string,
): string {
  switch (pm) {
    case "npm":
      return `npm install --prefix ${dir}`;
    case "yarn":
      return `yarn --cwd ${dir} install`;
    case "pnpm":
      return `pnpm --dir ${dir} install`;
    case "bun":
      return `bun --cwd ${dir} install`;
  }
}

/** Run a package.json script (and optional args) with the chosen manager. */
export function runScriptCommand(
  pm: PackageManager,
  script: string,
  scriptArgs: string[] = [],
): { command: string; args: string[] } {
  switch (pm) {
    case "npm":
      return {
        command: "npm",
        args:
          scriptArgs.length > 0
            ? ["run", script, "--", ...scriptArgs]
            : ["run", script],
      };
    case "yarn":
      return { command: "yarn", args: [script, ...scriptArgs] };
    case "pnpm":
      return {
        command: "pnpm",
        args:
          scriptArgs.length > 0
            ? ["run", script, "--", ...scriptArgs]
            : ["run", script],
      };
    case "bun":
      return { command: "bun", args: ["run", script, ...scriptArgs] };
  }
}

/**
 * Run a script in a subdirectory of the project (e.g. `functions`).
 * Equivalent to yarn's `--cwd`.
 */
export function runScriptInDirCommand(
  pm: PackageManager,
  dir: string,
  script: string,
): { command: string; args: string[] } {
  switch (pm) {
    case "npm":
      return { command: "npm", args: ["--prefix", dir, "run", script] };
    case "yarn":
      return { command: "yarn", args: ["--cwd", dir, script] };
    case "pnpm":
      return { command: "pnpm", args: ["--dir", dir, "run", script] };
    case "bun":
      return { command: "bun", args: ["--cwd", dir, "run", script] };
  }
}

export function formatInstallHint(pm: PackageManager): string {
  return `${pm} install`;
}

export function formatRunHint(pm: PackageManager, script: string): string {
  switch (pm) {
    case "npm":
      return `npm run ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "pnpm":
      return `pnpm ${script}`;
    case "bun":
      return `bun run ${script}`;
  }
}
