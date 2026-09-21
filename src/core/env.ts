import * as prompts from "@clack/prompts";

import type { Workspace } from "./apply/workspace.js";
import { RadianceError, ui } from "./logger.js";
import { collectOptionEffects, type ResolvedOptions } from "./options.js";
import type { EnvVarDef, EnvVarInput, ModuleManifest } from "./registry.js";
import { looksLikeServerSecret, normalizeEnvEntry } from "./registry.js";

/** Paths for non-secret Functions params (defineString). */
export const FUNCTIONS_ENV = "functions/.env";
export const FUNCTIONS_ENV_EXAMPLE = "functions/.env.example";
/** Local emulator secrets file (gitignored via `*.local`). */
export const FUNCTIONS_SECRET_LOCAL = "functions/.secret.local";

/** Replace or append `KEY=value` lines in a dotenv file. */
export function applyEnvValues(
  content: string,
  values: Record<string, string>,
): string {
  let next = content;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(next)) {
      next = next.replace(pattern, `${key}=${value}`);
    } else {
      next = `${next.trimEnd()}\n${key}=${value}\n`;
    }
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

/** Parse KEY=value pairs from dotenv content (comments and blanks ignored). */
export function parseEnvValues(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

/** Descriptions only — used when appending to `.env.example`. */
export function envDescriptions(
  entries: Record<string, EnvVarInput | EnvVarDef>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      normalizeEnvEntry(value).description,
    ]),
  );
}

function mergeNormalizedEntries(
  base: Record<string, EnvVarInput | EnvVarDef>,
  extra: Record<string, EnvVarDef>,
): Record<string, EnvVarDef> {
  const merged: Record<string, EnvVarInput | EnvVarDef> = {
    ...base,
    ...extra,
  };
  return Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [
      key,
      normalizeEnvEntry(value),
    ]),
  );
}

/** Merge unconditional + option-bound env declarations into normalized defs. */
export function collectModuleEnv(
  manifest: ModuleManifest,
  options: ResolvedOptions,
): Record<string, EnvVarDef> {
  const effects = collectOptionEffects(manifest, options);
  return mergeNormalizedEntries(manifest.env, effects.env);
}

/** Merge unconditional + option-bound secret declarations. */
export function collectModuleSecrets(
  manifest: ModuleManifest,
  options: ResolvedOptions,
): Record<string, EnvVarDef> {
  const effects = collectOptionEffects(manifest, options);
  return mergeNormalizedEntries(manifest.secrets, effects.secrets);
}

/** Merge unconditional + option-bound param declarations. */
export function collectModuleParams(
  manifest: ModuleManifest,
  options: ResolvedOptions,
): Record<string, EnvVarDef> {
  const effects = collectOptionEffects(manifest, options);
  return mergeNormalizedEntries(manifest.params, effects.params);
}

/**
 * Interactively collect values for promptable env vars that are still empty.
 * Empty answers are allowed; required keys get a warning so init is not blocked.
 */
export async function promptModuleEnv(params: {
  moduleId: string;
  moduleTitle: string;
  entries: Record<string, EnvVarDef>;
  existing: Record<string, string>;
  /** Heading suffix, e.g. "configuration" / "server params" / "secrets". */
  headingKind?: string;
  /** Where to set missing values (shown in warnings). */
  storeHint?: string;
  /** Use masked password input (for secrets). */
  secret?: boolean;
}): Promise<Record<string, string>> {
  const pending = Object.entries(params.entries).filter(([key, def]) => {
    if (!def.prompt) return false;
    return !params.existing[key]?.trim();
  });

  if (pending.length === 0) return {};

  const kind = params.headingKind ?? "configuration";
  const storeHint = params.storeHint ?? ".env";

  ui.blank();
  ui.heading(`${params.moduleTitle} ${kind}`);
  ui.detail(
    `Required by the ${params.moduleId} module — leave blank to fill in later.`,
  );

  const filled: Record<string, string> = {};

  for (const [key, def] of pending) {
    const message = def.required ? `${key} (required)` : key;
    const value = params.secret
      ? await prompts.password({
          message,
        })
      : await prompts.text({
          message,
          placeholder: def.description,
          initialValue: "",
        });

    if (prompts.isCancel(value)) throw new RadianceError("Cancelled.");

    const trimmed = value.trim();
    if (!trimmed) {
      if (def.required) {
        ui.warn(
          `Left ${key} empty — set it in ${storeHint} before this feature will work.`,
        );
      }
      continue;
    }

    filled[key] = trimmed;
  }

  return filled;
}

/** Stage `.env` updates for keys the user (or flags) provided. */
export async function upsertWorkspaceEnv(
  workspace: Workspace,
  values: Record<string, string>,
  source: string,
): Promise<void> {
  if (Object.keys(values).length === 0) return;

  const existing =
    (await workspace.read(".env")) ??
    (await workspace.read(".env.example")) ??
    "";
  await workspace.write(".env", applyEnvValues(existing, values), source);
}

/** Stage updates under a functions path (params `.env` or secrets `.secret.local`). */
export async function upsertFunctionsFile(
  workspace: Workspace,
  path: string,
  values: Record<string, string>,
  source: string,
): Promise<void> {
  if (Object.keys(values).length === 0) return;

  const existing = (await workspace.read(path)) ?? "";
  await workspace.write(path, applyEnvValues(existing, values), source);
}

/** Read currently known env values from staged `.env` / `.env.example`. */
export async function readWorkspaceEnv(
  workspace: Workspace,
): Promise<Record<string, string>> {
  const content =
    (await workspace.read(".env")) ??
    (await workspace.read(".env.example")) ??
    "";
  return parseEnvValues(content);
}

/** Read KEY=value pairs from a staged functions config file. */
export async function readFunctionsFile(
  workspace: Workspace,
  path: string,
): Promise<Record<string, string>> {
  const content = (await workspace.read(path)) ?? "";
  return parseEnvValues(content);
}

/** Note required env keys that are still blank after a non-interactive install. */
export function noteMissingRequiredEnv(
  workspace: Workspace,
  moduleId: string,
  entries: Record<string, EnvVarDef>,
  existing: Record<string, string>,
  storeHint = ".env",
): void {
  for (const [key, def] of Object.entries(entries)) {
    if (!def.required) continue;
    // Prompt-skipped keys are provisioned later (Firebase setup, native files, …).
    if (!def.prompt) continue;
    if (existing[key]?.trim()) continue;
    workspace.note(
      "warn",
      `Set ${key} in ${storeHint} (${def.description}).`,
      moduleId,
    );
  }
}

/** Note production `firebase functions:secrets:set` for each undeployed secret. */
export function noteMissingSecrets(
  workspace: Workspace,
  moduleId: string,
  entries: Record<string, EnvVarDef>,
  existingLocal: Record<string, string>,
): void {
  for (const [key, def] of Object.entries(entries)) {
    if (!def.required) continue;
    if (existingLocal[key]?.trim()) {
      workspace.note(
        "info",
        `For production: firebase functions:secrets:set ${key}`,
        moduleId,
      );
      continue;
    }
    workspace.note(
      "warn",
      `Set ${key} for the emulator in ${FUNCTIONS_SECRET_LOCAL}, then run: firebase functions:secrets:set ${key} (${def.description}).`,
      moduleId,
    );
  }
}

/** Warn when client `env` keys look like they belong on `secrets` instead. */
export function noteSuspiciousClientEnv(
  workspace: Workspace,
  moduleId: string,
  entries: Record<string, EnvVarDef>,
): void {
  for (const key of Object.keys(entries)) {
    if (!looksLikeServerSecret(key)) continue;
    workspace.note(
      "warn",
      `${key} looks like a server secret but is declared on \`env\` (client). Prefer \`secrets\` + defineSecret unless this is intentionally public.`,
      moduleId,
    );
  }
}
