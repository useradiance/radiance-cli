import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { RadianceError } from "./logger.js";

export const WireProviderSchema = z.object({
  import: z.string(),
  component: z.string(),
});

export const WireMarkerSchema = z.object({
  file: z.string(),
  marker: z.string(),
  imports: z.array(z.string()).optional(),
  block: z.string(),
  /** Only applied when this module id is installed. */
  when: z.string().optional(),
});

export const ModuleOptionDefSchema = z.object({
  description: z.string().optional(),
  /** `single` picks one choice; `multi` picks any non-empty subset. */
  type: z.enum(["single", "multi"]).default("single"),
  choices: z.array(z.string()).min(1),
  default: z.union([z.string(), z.array(z.string())]),
  /** Minimum selections for a multi option. */
  min: z.number().int().min(0).default(1),
  /**
   * Copies the resolved string value onto a template var (e.g. theme `pack` → `themePack`).
   * Only meaningful for single options.
   */
  mapsTo: z.string().optional(),
});

export type ModuleOptionDef = z.infer<typeof ModuleOptionDefSchema>;

/**
 * Env var declaration for a module.
 * A plain string is still accepted (description only, not prompted).
 * Object form marks keys as promptable / required during `radiance init` and `radiance add`.
 */
export const EnvVarDefSchema = z
  .object({
    description: z.string(),
    required: z.boolean().default(false),
    /**
     * When omitted, defaults to `required` so required keys are always asked.
     * Set `false` for keys filled later (e.g. `radiance setup firebase` writes
     * `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`) — they stay in `.env.example` and
     * `radiance doctor` still enforces `required`.
     */
    prompt: z.boolean().optional(),
  })
  .transform((value) => ({
    description: value.description,
    required: value.required,
    prompt: value.prompt ?? value.required,
  }));

export type EnvVarDef = z.output<typeof EnvVarDefSchema>;
export type EnvVarInput = string | z.input<typeof EnvVarDefSchema>;

export const EnvEntriesSchema = z
  .record(z.string(), z.union([z.string(), EnvVarDefSchema]))
  .default({});

export type EnvEntries = z.infer<typeof EnvEntriesSchema>;

/** Server secrets / params — never EXPO_PUBLIC_* (those belong on `env`). */
export const ServerEntriesSchema = z
  .record(z.string(), z.union([z.string(), EnvVarDefSchema]))
  .default({})
  .superRefine((entries, ctx) => {
    for (const key of Object.keys(entries)) {
      if (key.startsWith("EXPO_PUBLIC_")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} must not use the EXPO_PUBLIC_ prefix — put client-facing values on \`env\`, not secrets/params`,
          path: [key],
        });
      }
    }
  });

export type ServerEntries = z.infer<typeof ServerEntriesSchema>;

export function normalizeEnvEntry(value: EnvVarInput | EnvVarDef): EnvVarDef {
  if (typeof value === "string") {
    return { description: value, required: false, prompt: false };
  }
  return {
    description: value.description,
    required: Boolean(value.required),
    prompt: value.prompt ?? Boolean(value.required),
  };
}

/**
 * Client `env` keys that look like server secrets (signing secrets, or
 * non-`EXPO_PUBLIC_` API keys). Known-public variants (`PUBLISHABLE` / `SEARCH`)
 * and `EXPO_PUBLIC_*_API_KEY` SDK keys (Maps, RevenueCat) are left alone.
 */
export function looksLikeServerSecret(key: string): boolean {
  if (key.includes("PUBLISHABLE") || key.includes("SEARCH")) return false;
  if (/_SECRET(?:_|$)/.test(key)) return true;
  if (!key.startsWith("EXPO_PUBLIC_") && /_API_KEY(?:_|$)/.test(key)) {
    return true;
  }
  return false;
}

/** Effects applied when a particular option choice is selected. */
export const OptionBindingSchema = z.object({
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  env: EnvEntriesSchema,
  secrets: ServerEntriesSchema,
  params: ServerEntriesSchema,
  firebase: z
    .object({
      authProviders: z.array(z.string()).default([]),
    })
    .default({ authProviders: [] }),
  /** Directory relative to the module root whose files are copied on top of `files/`. */
  files: z.string().optional(),
});

export type OptionBinding = z.infer<typeof OptionBindingSchema>;

export const ModuleManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string(),
  side: z.enum(["app", "functions", "both"]).default("app"),
  capabilities: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  scripts: z.record(z.string(), z.string()).default({}),
  overrides: z.array(z.string()).default([]),
  removes: z.array(z.string()).default([]),
  /** Client-facing vars → root `.env` / `.env.example` (often `EXPO_PUBLIC_*`). */
  env: EnvEntriesSchema,
  /**
   * Server credentials → Secret Manager (`defineSecret`). Never ship in the client.
   * Local emulator: `functions/.secret.local`. Production: `firebase functions:secrets:set`.
   */
  secrets: ServerEntriesSchema,
  /**
   * Non-secret server config → `defineString` params.
   * Local: `functions/.env`. Documented in `functions/.env.example`.
   */
  params: ServerEntriesSchema,
  options: z.record(z.string(), ModuleOptionDefSchema).default({}),
  /**
   * Per-option, per-choice extras. Base `dependencies` / `env` / `firebase.authProviders`
   * stay unconditional; anything choice-specific goes here.
   */
  optionBindings: z
    .record(z.string(), z.record(z.string(), OptionBindingSchema))
    .default({}),
  wire: z
    .object({
      providers: z.array(WireProviderSchema).default([]),
      markers: z.array(WireMarkerSchema).default([]),
    })
    .default({ providers: [], markers: [] }),
  firebase: z
    .object({
      services: z.array(z.string()).default([]),
      authProviders: z.array(z.string()).default([]),
      emulators: z.record(z.string(), z.unknown()).default({}),
      rules: z
        .object({
          firestore: z.string().optional(),
          storage: z.string().optional(),
        })
        .default({}),
      indexes: z.string().optional(),
      config: z.record(z.string(), z.unknown()).default({}),
      functions: z.array(z.string()).default([]),
    })
    .default({
      services: [],
      authProviders: [],
      emulators: {},
      rules: {},
      config: {},
      functions: [],
    }),
  notes: z.array(z.string()).default([]),
});

export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

export const StarterManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  extends: z.string().default("expo-app"),
  title: z.string(),
  description: z.string(),
  modules: z.array(z.string()).default([]),
  overlay: z.string().default("overlay"),
  capabilities: z.array(z.string()).default([]),
  firebase: ModuleManifestSchema.shape.firebase,
  defaults: z
    .object({
      themePack: z.string().optional(),
      defaultLocale: z.string().optional(),
    })
    .default({}),
});

export type StarterManifest = z.infer<typeof StarterManifestSchema>;

export const RegistrySchema = z.object({
  version: z.string(),
  expoSdk: z.number(),
  scaffold: z.object({
    id: z.string(),
    path: z.string(),
    version: z.string(),
    requiredModules: z.array(z.string()).default([]),
  }),
  starters: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      version: z.string(),
      extends: z.string(),
      title: z.string(),
      description: z.string(),
      modules: z.array(z.string()),
      capabilities: z.array(z.string()),
      defaults: z.record(z.string(), z.string()).default({}),
    }),
  ),
  modules: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      version: z.string(),
      title: z.string(),
      description: z.string(),
      side: z.string(),
      capabilities: z.array(z.string()),
      requires: z.array(z.string()),
      conflicts: z.array(z.string()),
    }),
  ),
});

export type Registry = z.infer<typeof RegistrySchema>;
export type RegistryModule = Registry["modules"][number];
export type RegistryStarter = Registry["starters"][number];

/** A resolved templates release: the registry plus the directory it was read from. */
export type TemplateSource = {
  root: string;
  version: string;
  registry: Registry;
  /** True when reading a working copy rather than an immutable cached release. */
  local: boolean;
};

export async function readRegistry(root: string): Promise<Registry> {
  try {
    return RegistrySchema.parse(
      JSON.parse(await readFile(join(root, "registry.json"), "utf8")),
    );
  } catch (error) {
    throw new RadianceError(
      `Could not read the template registry at ${root}`,
      error instanceof Error ? error.message : undefined,
    );
  }
}

export async function readModuleManifest(
  source: TemplateSource,
  id: string,
): Promise<ModuleManifest> {
  const entry = source.registry.modules.find((module) => module.id === id);
  if (!entry) {
    throw new RadianceError(
      `Unknown module "${id}"`,
      `Run \`radiance templates list\` to see what is available in ${source.version}.`,
    );
  }

  const path = join(source.root, entry.path, "module.json");
  return ModuleManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function readStarterManifest(
  source: TemplateSource,
  id: string,
): Promise<StarterManifest> {
  const entry = source.registry.starters.find((starter) => starter.id === id);
  if (!entry) {
    const available = source.registry.starters
      .map((starter) => starter.id)
      .join(", ");
    throw new RadianceError(
      `Unknown starter "${id}"`,
      `Available starters: ${available}`,
    );
  }

  const path = join(source.root, entry.path, "starter.json");
  return StarterManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function moduleDir(source: TemplateSource, id: string): string {
  const entry = source.registry.modules.find((module) => module.id === id);
  if (!entry) throw new RadianceError(`Unknown module "${id}"`);
  return join(source.root, entry.path);
}

export function starterDir(source: TemplateSource, id: string): string {
  const entry = source.registry.starters.find((starter) => starter.id === id);
  if (!entry) throw new RadianceError(`Unknown starter "${id}"`);
  return join(source.root, entry.path);
}

/**
 * Orders modules so every dependency is installed before the module that needs it.
 * Throws on cycles rather than silently picking an order.
 */
export function resolveModuleOrder(
  registry: Registry,
  requested: string[],
  alreadyInstalled: string[] = [],
): string[] {
  const byId = new Map(registry.modules.map((module) => [module.id, module]));
  const installed = new Set(alreadyInstalled);
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, trail: string[]): void => {
    if (visited.has(id) || installed.has(id)) return;

    if (visiting.has(id)) {
      throw new RadianceError(
        `Circular module dependency: ${[...trail, id].join(" → ")}`,
      );
    }

    const entry = byId.get(id);
    if (!entry) {
      throw new RadianceError(
        `Unknown module "${id}"`,
        "Run `radiance templates list` to see available modules.",
      );
    }

    visiting.add(id);
    for (const dependency of entry.requires) {
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);

    visited.add(id);
    ordered.push(id);
  };

  for (const id of requested) {
    visit(id, []);
  }

  return ordered;
}
