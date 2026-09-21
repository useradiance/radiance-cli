import * as prompts from "@clack/prompts";

import { RadianceError } from "./logger.js";
import {
  normalizeEnvEntry,
  type EnvVarDef,
  type ModuleManifest,
  type ModuleOptionDef,
} from "./registry.js";

export type OptionValue = string | string[];
export type ResolvedOptions = Record<string, OptionValue>;

/** Raw CLI flags: `providers=email,google` or `auth.providers=email`. */
export type OptionFlag = {
  moduleId?: string;
  key: string;
  raw: string;
};

export function parseOptionFlags(flags: string[] | undefined): OptionFlag[] {
  if (!flags || flags.length === 0) return [];

  return flags.map((flag) => {
    const separator = flag.indexOf("=");
    if (separator === -1) {
      throw new RadianceError(
        `Invalid --option "${flag}"`,
        "Use --option key=value or --option module.key=value (comma-separated for multi).",
      );
    }

    const left = flag.slice(0, separator).trim();
    const raw = flag.slice(separator + 1).trim();
    if (!left || !raw) {
      throw new RadianceError(
        `Invalid --option "${flag}"`,
        "Both key and value are required.",
      );
    }

    const dotted = left.indexOf(".");
    if (dotted === -1) return { key: left, raw };

    return {
      moduleId: left.slice(0, dotted),
      key: left.slice(dotted + 1),
      raw,
    };
  });
}

function parseValue(def: ModuleOptionDef, raw: string): OptionValue {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (def.type === "multi") {
    return parts;
  }

  if (parts.length !== 1) {
    throw new RadianceError(
      `Option expects a single value, got "${raw}"`,
      `Choices: ${def.choices.join(", ")}`,
    );
  }

  return parts[0]!;
}

export function validateOptionValue(
  key: string,
  def: ModuleOptionDef,
  value: OptionValue,
): void {
  const selected = Array.isArray(value) ? value : [value];

  for (const item of selected) {
    if (!def.choices.includes(item)) {
      throw new RadianceError(
        `Invalid value "${item}" for option "${key}"`,
        `Choices: ${def.choices.join(", ")}`,
      );
    }
  }

  if (def.type === "multi") {
    const unique = [...new Set(selected)];
    if (unique.length !== selected.length) {
      throw new RadianceError(`Duplicate values in option "${key}"`);
    }
    if (unique.length < def.min) {
      throw new RadianceError(
        `Option "${key}" needs at least ${def.min} choice${def.min === 1 ? "" : "s"}`,
        `Choices: ${def.choices.join(", ")}`,
      );
    }
  }
}

function defaultValue(def: ModuleOptionDef): OptionValue {
  if (def.type === "multi") {
    return Array.isArray(def.default)
      ? [...def.default]
      : def.default
        ? [def.default]
        : [];
  }
  return Array.isArray(def.default)
    ? (def.default[0] ?? def.choices[0]!)
    : def.default;
}

/**
 * Resolves options for one module from CLI flags, a previous install, interactive prompts,
 * or defaults — in that order.
 */
export async function resolveModuleOptions(
  manifest: ModuleManifest,
  flags: OptionFlag[],
  previous: ResolvedOptions | undefined,
  interactive: boolean,
): Promise<ResolvedOptions> {
  const defs = manifest.options;
  const keys = Object.keys(defs);
  if (keys.length === 0) return {};

  const resolved: ResolvedOptions = {};

  for (const key of keys) {
    const def = defs[key]!;
    const flag = flags.find(
      (entry) =>
        entry.key === key &&
        (entry.moduleId === undefined || entry.moduleId === manifest.id),
    );

    if (flag) {
      const value = parseValue(def, flag.raw);
      validateOptionValue(key, def, value);
      resolved[key] = Array.isArray(value) ? [...new Set(value)] : value;
      continue;
    }

    if (previous?.[key] !== undefined) {
      validateOptionValue(key, def, previous[key]!);
      resolved[key] = previous[key]!;
      continue;
    }

    if (interactive) {
      resolved[key] = await promptOption(key, def);
      continue;
    }

    const value = defaultValue(def);
    validateOptionValue(key, def, value);
    resolved[key] = value;
  }

  // Reject flags aimed at this module for unknown keys.
  for (const flag of flags) {
    if (flag.moduleId && flag.moduleId !== manifest.id) continue;
    if (flag.moduleId === manifest.id && !(flag.key in defs)) {
      throw new RadianceError(
        `Unknown option "${flag.key}" for module "${manifest.id}"`,
        `Available: ${keys.join(", ") || "(none)"}`,
      );
    }
  }

  return resolved;
}

async function promptOption(
  key: string,
  def: ModuleOptionDef,
): Promise<OptionValue> {
  if (def.type === "multi") {
    const choice = await prompts.multiselect({
      message: def.description ?? `Select ${key}`,
      options: def.choices.map((value) => ({ value, label: value })),
      required: def.min > 0,
      initialValues: Array.isArray(def.default)
        ? def.default
        : def.default
          ? [def.default]
          : [],
    });

    if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
    const value = choice as string[];
    validateOptionValue(key, def, value);
    return value;
  }

  const choice = await prompts.select({
    message: def.description ?? `Select ${key}`,
    options: def.choices.map((value) => ({ value, label: value })),
    initialValue: Array.isArray(def.default) ? def.default[0] : def.default,
  });

  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
  validateOptionValue(key, def, choice as string);
  return choice as string;
}

/** True when a multi option includes `choice`, or a single option equals it. */
export function optionIncludes(
  options: ResolvedOptions,
  key: string,
  choice: string,
): boolean {
  const value = options[key];
  if (value === undefined) return false;
  return Array.isArray(value) ? value.includes(choice) : value === choice;
}

export type OptionBindingEffects = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  env: Record<string, EnvVarDef>;
  secrets: Record<string, EnvVarDef>;
  params: Record<string, EnvVarDef>;
  authProviders: string[];
  /** Extra file trees to copy (paths relative to the module directory). */
  files: string[];
};

/** Collects package/env/firebase/file effects for the selected option values. */
export function collectOptionEffects(
  manifest: ModuleManifest,
  options: ResolvedOptions,
): OptionBindingEffects {
  const effects: OptionBindingEffects = {
    dependencies: {},
    devDependencies: {},
    env: {},
    secrets: {},
    params: {},
    authProviders: [],
    files: [],
  };

  for (const [key, value] of Object.entries(options)) {
    const bindings = manifest.optionBindings[key];
    if (!bindings) continue;

    const selected = Array.isArray(value) ? value : [value];
    for (const choice of selected) {
      const binding = bindings[choice];
      if (!binding) continue;

      Object.assign(effects.dependencies, binding.dependencies);
      Object.assign(effects.devDependencies, binding.devDependencies);
      for (const [envKey, envValue] of Object.entries(binding.env)) {
        effects.env[envKey] = normalizeEnvEntry(envValue);
      }
      for (const [secretKey, secretValue] of Object.entries(binding.secrets)) {
        effects.secrets[secretKey] = normalizeEnvEntry(secretValue);
      }
      for (const [paramKey, paramValue] of Object.entries(binding.params)) {
        effects.params[paramKey] = normalizeEnvEntry(paramValue);
      }
      effects.authProviders.push(...binding.firebase.authProviders);
      if (binding.files) effects.files.push(binding.files);
    }
  }

  return effects;
}

/**
 * Applies `mapsTo` options onto template vars (e.g. theme `pack` → `themePack`).
 * Only string (single) values are supported for mapsTo.
 */
export function applyMapsTo(
  manifest: ModuleManifest,
  options: ResolvedOptions,
  vars: Record<string, string>,
): void {
  for (const [key, def] of Object.entries(manifest.options)) {
    if (!def.mapsTo) continue;
    const value = options[key];
    if (typeof value === "string") vars[def.mapsTo] = value;
  }
}

/** Placeholder map for the module currently being applied. */
export function optionPlaceholders(
  options: ResolvedOptions,
): Record<string, string> {
  const placeholders: Record<string, string> = {};

  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value)) {
      placeholders[`option.${key}`] = value.join(",");
      placeholders[`option.${key}.json`] = JSON.stringify(value);
      for (const choice of value) {
        placeholders[`option.${key}.${choice}`] = "true";
      }
    } else {
      placeholders[`option.${key}`] = value;
      placeholders[`option.${key}.json`] = JSON.stringify(value);
      placeholders[`option.${key}.${value}`] = "true";
    }
  }

  return placeholders;
}

/** For choices not selected, emit explicit false so templates can branch. */
export function optionBooleans(
  manifest: ModuleManifest,
  options: ResolvedOptions,
): Record<string, string> {
  const placeholders: Record<string, string> = {};

  for (const [key, def] of Object.entries(manifest.options)) {
    for (const choice of def.choices) {
      const name = `option.${key}.${choice}`;
      if (placeholders[name] === undefined) {
        placeholders[name] = optionIncludes(options, key, choice)
          ? "true"
          : "false";
      }
    }
  }

  return placeholders;
}
