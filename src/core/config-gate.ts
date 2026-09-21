import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

import { ensureTemplateSource } from "./cache.js";
import { loadConfig } from "./config.js";
import {
  collectModuleEnv,
  collectModuleParams,
  collectModuleSecrets,
  FUNCTIONS_ENV,
  FUNCTIONS_ENV_EXAMPLE,
  FUNCTIONS_SECRET_LOCAL,
  parseEnvValues,
} from "./env.js";
import { RadianceError, ui } from "./logger.js";
import type { ResolvedOptions } from "./options.js";
import type { ProjectConfig } from "./project.js";
import {
  readModuleManifest,
  type EnvVarDef,
  type ModuleManifest,
  type TemplateSource,
} from "./registry.js";

export type RequiredConfigKey = {
  key: string;
  moduleId: string;
  description: string;
  kind: "env" | "param" | "secret";
};

export type CollectedRequirements = {
  env: RequiredConfigKey[];
  params: RequiredConfigKey[];
  secrets: RequiredConfigKey[];
};

function requiredEntries(
  moduleId: string,
  kind: RequiredConfigKey["kind"],
  entries: Record<string, EnvVarDef>,
): RequiredConfigKey[] {
  return Object.entries(entries)
    .filter(([, def]) => def.required)
    .map(([key, def]) => ({
      key,
      moduleId,
      description: def.description,
      kind,
    }));
}

/** Pure collector — used by tests and {@link collectInstalledRequirements}. */
export function requirementsFromFeatures(
  features: Array<{
    id: string;
    manifest: ModuleManifest;
    options: ResolvedOptions;
  }>,
): CollectedRequirements {
  const env: RequiredConfigKey[] = [];
  const params: RequiredConfigKey[] = [];
  const secrets: RequiredConfigKey[] = [];
  const seen = {
    env: new Set<string>(),
    params: new Set<string>(),
    secrets: new Set<string>(),
  };

  for (const feature of features) {
    for (const item of requiredEntries(
      feature.id,
      "env",
      collectModuleEnv(feature.manifest, feature.options),
    )) {
      if (seen.env.has(item.key)) continue;
      seen.env.add(item.key);
      env.push(item);
    }
    for (const item of requiredEntries(
      feature.id,
      "param",
      collectModuleParams(feature.manifest, feature.options),
    )) {
      if (seen.params.has(item.key)) continue;
      seen.params.add(item.key);
      params.push(item);
    }
    for (const item of requiredEntries(
      feature.id,
      "secret",
      collectModuleSecrets(feature.manifest, feature.options),
    )) {
      if (seen.secrets.has(item.key)) continue;
      seen.secrets.add(item.key);
      secrets.push(item);
    }
  }

  return { env, params, secrets };
}

/** Gather required env / params / secrets from every installed module. */
export async function collectInstalledRequirements(
  project: ProjectConfig,
  source: TemplateSource,
): Promise<CollectedRequirements> {
  const features: Array<{
    id: string;
    manifest: ModuleManifest;
    options: ResolvedOptions;
  }> = [];

  for (const feature of project.features) {
    try {
      const manifest = await readModuleManifest(source, feature.id);
      features.push({
        id: feature.id,
        manifest,
        options: (feature.options ?? {}) as ResolvedOptions,
      });
    } catch {
      // Catalogue version drift — skip unknown modules rather than blocking deploy.
    }
  }

  return requirementsFromFeatures(features);
}

async function readDotenvFile(
  root: string,
  relative: string,
): Promise<Record<string, string>> {
  try {
    return parseEnvValues(await readFile(join(root, relative), "utf8"));
  } catch {
    return {};
  }
}

export function missingRequiredKeys(
  required: RequiredConfigKey[],
  values: Record<string, string>,
): RequiredConfigKey[] {
  return required.filter((item) => !values[item.key]?.trim());
}

function formatMissing(items: RequiredConfigKey[]): string {
  return items
    .map((item) => `  • ${item.key} (${item.moduleId}: ${item.description})`)
    .join("\n");
}

/**
 * True when Secret Manager already has a value for `key` in this Firebase project.
 * Does not print the secret value.
 */
export async function secretExistsInSecretManager(
  root: string,
  key: string,
  projectId?: string,
): Promise<boolean> {
  const args = ["functions:secrets:access", key, "--non-interactive"];
  if (projectId) args.push("--project", projectId);

  const result = await execa("firebase", args, {
    cwd: root,
    reject: false,
    timeout: 60_000,
    env: { ...process.env, CI: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  return result.exitCode === 0;
}

export type ConfigGateOptions = {
  /** Check required client `env` keys in root `.env`. Default true. */
  clientEnv?: boolean;
  /** Check required `params` in `functions/.env`. */
  params?: boolean;
  /**
   * Where required secrets must exist:
   * - `local` — `functions/.secret.local` (emulator / local functions build)
   * - `secret-manager` — Firebase Secret Manager (cloud functions deploy)
   * - `either` — local file OR Secret Manager
   * - `false` — skip
   */
  secrets?: false | "local" | "secret-manager" | "either";
  projectId?: string;
  /** Injected requirements (tests). When omitted, loaded from the catalogue. */
  requirements?: CollectedRequirements;
};

/**
 * Fail closed when required module config is missing before build or deploy.
 */
export async function assertRequiredConfig(
  root: string,
  project: ProjectConfig,
  options: ConfigGateOptions,
): Promise<void> {
  const checkClient = options.clientEnv !== false;
  const checkParams = Boolean(options.params);
  const secretsMode = options.secrets ?? false;

  if (!checkClient && !checkParams && !secretsMode) return;

  const required =
    options.requirements ??
    (await collectInstalledRequirements(
      project,
      await ensureTemplateSource(await loadConfig()),
    ));

  const problems: string[] = [];
  const hints: string[] = [];

  if (checkClient && required.env.length > 0) {
    const values = await readDotenvFile(root, ".env");
    const missing = missingRequiredKeys(required.env, values);
    if (missing.length > 0) {
      problems.push(
        `Missing required client env in .env:\n${formatMissing(missing)}`,
      );
      hints.push("Set the keys in `.env` (see `.env.example`).");
    }
  }

  if (checkParams && required.params.length > 0) {
    const values = await readDotenvFile(root, FUNCTIONS_ENV);
    const missing = missingRequiredKeys(required.params, values);
    if (missing.length > 0) {
      problems.push(
        `Missing required Functions params in ${FUNCTIONS_ENV}:\n${formatMissing(missing)}`,
      );
      hints.push(
        `Set the keys in \`${FUNCTIONS_ENV}\` (see \`${FUNCTIONS_ENV_EXAMPLE}\`).`,
      );
    }
  }

  if (secretsMode && required.secrets.length > 0) {
    const localValues = await readDotenvFile(root, FUNCTIONS_SECRET_LOCAL);
    const missing: RequiredConfigKey[] = [];

    for (const item of required.secrets) {
      const localOk = Boolean(localValues[item.key]?.trim());
      if (secretsMode === "local") {
        if (!localOk) missing.push(item);
        continue;
      }

      if (secretsMode === "either" && localOk) continue;

      const remoteOk = await secretExistsInSecretManager(
        root,
        item.key,
        options.projectId,
      );
      if (secretsMode === "secret-manager" || secretsMode === "either") {
        if (!remoteOk) missing.push(item);
      }
    }

    if (missing.length > 0) {
      if (secretsMode === "local") {
        problems.push(
          `Missing required secrets in ${FUNCTIONS_SECRET_LOCAL}:\n${formatMissing(missing)}`,
        );
        hints.push(
          `Add them to \`${FUNCTIONS_SECRET_LOCAL}\` for the emulator, then ` +
            "`firebase functions:secrets:set <KEY>` for production.",
        );
      } else if (secretsMode === "either") {
        problems.push(
          `Missing required secrets (neither ${FUNCTIONS_SECRET_LOCAL} nor Secret Manager):\n${formatMissing(missing)}`,
        );
        hints.push(
          `Set locally in \`${FUNCTIONS_SECRET_LOCAL}\` or run \`firebase functions:secrets:set <KEY>\`.`,
        );
      } else {
        problems.push(
          `Missing required secrets in Firebase Secret Manager:\n${formatMissing(missing)}`,
        );
        hints.push(
          "Run `firebase functions:secrets:set <KEY>` for each key (values can live in " +
            `\`${FUNCTIONS_SECRET_LOCAL}\` for the emulator only).`,
        );
      }
    }
  }

  if (problems.length === 0) return;

  ui.trace(`config gate failed:\n${problems.join("\n")}`);
  throw new RadianceError(
    "Required project configuration is incomplete",
    `${problems.join("\n\n")}\n\n${hints.join(" ")}`,
  );
}

/** Preflight for `radiance build` (app artifacts need client env). */
export async function assertReadyForBuild(
  root: string,
  project: ProjectConfig,
): Promise<void> {
  await assertRequiredConfig(root, project, {
    clientEnv: true,
    params: false,
    secrets: false,
  });
}

/**
 * Preflight for `radiance deploy`.
 * App targets need client env; Functions need params + Secret Manager secrets.
 */
export async function assertReadyForDeploy(
  root: string,
  project: ProjectConfig,
  options: {
    checkClientEnv: boolean;
    checkFunctions: boolean;
    projectId?: string;
  },
): Promise<void> {
  await assertRequiredConfig(root, project, {
    clientEnv: options.checkClientEnv,
    params: options.checkFunctions,
    secrets: options.checkFunctions ? "secret-manager" : false,
    projectId: options.projectId,
  });
}
