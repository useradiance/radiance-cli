import {
  applyModule,
  applyScaffold,
  applyStarter,
  backfillFunctions,
  updateConstitution,
  type ApplyContext,
  type TemplateVars,
} from "./apply/engine.js";
import { Workspace } from "./apply/workspace.js";
import { ui } from "./logger.js";
import {
  parseOptionFlags,
  resolveModuleOptions,
  type OptionFlag,
  type ResolvedOptions,
} from "./options.js";
import {
  readModuleManifest,
  readStarterManifest,
  resolveModuleOrder,
  type ModuleManifest,
  type StarterManifest,
  type TemplateSource,
} from "./registry.js";

export type InstalledFeature = {
  id: string;
  version: string;
  options: ResolvedOptions;
};

export type StageOptions = {
  root: string;
  source: TemplateSource;
  vars: TemplateVars;
  /** Copy the base scaffold first (a new project). */
  scaffold: boolean;
  starterId?: string | null;
  /** Modules the caller asked for; dependencies are resolved and added automatically. */
  moduleIds: string[];
  /** Modules already present in the project. */
  installed: string[];
  /** Existing features, so options and versions survive a reinstall. */
  existingFeatures?: InstalledFeature[];
  /** Raw `--option key=value` flags from the CLI. */
  optionFlags?: string[];
  /**
   * True for `radiance init`, where an unqualified `--option key=value` may
   * target any module the starter brings in.
   *
   * Was inferred as `moduleIds.length === 0`, which is not the same question
   * and got it wrong: `init --demo` pushes `demo-data` into `moduleIds`, so a
   * plain `--theme-pack ocean` was silently discarded and every project built
   * with demo content came out in the theme module's default palette instead
   * of the one that was asked for. The caller knows which command it is; it
   * should say so rather than have it guessed from an unrelated field.
   */
  initMode?: boolean;
  /** Prompt for options that were not supplied. */
  interactiveOptions?: boolean;
  /** Prompt for module env vars marked prompt/required (defaults to interactiveOptions). */
  interactiveEnv?: boolean;
  /**
   * Prompt for server secrets/params. Defaults to `interactiveEnv`.
   * Set false on `radiance init` so projects can be created without credentials;
   * build/deploy enforce them later.
   */
  interactiveServerConfig?: boolean;
};

export type StageResult = {
  workspace: Workspace;
  /** Modules applied in dependency order. */
  manifests: ModuleManifest[];
  starter: StarterManifest | null;
  features: InstalledFeature[];
  /** Options resolved per module during this run. */
  resolvedOptions: Record<string, ResolvedOptions>;
};

/**
 * Runs scaffold → modules → starter overlay against a staging workspace.
 *
 * This is the single code path behind `init`, `add` and the harness's Adapt phase, which is
 * what keeps a module installed by an AI prompt identical to one installed by hand.
 */
export async function stageInstall(
  options: StageOptions,
): Promise<StageResult> {
  const workspace = new Workspace(options.root);
  const flags = parseOptionFlags(options.optionFlags);

  ui.trace(`stageInstall root=${options.root}`);
  ui.trace(
    `stageInstall scaffold=${options.scaffold} starter=${options.starterId ?? "none"} ` +
      `modules=[${options.moduleIds.join(", ") || "—"}] installed=[${options.installed.join(", ") || "—"}]`,
  );

  const starter = options.starterId
    ? await readStarterManifest(options.source, options.starterId)
    : null;

  const requested = [
    ...(options.scaffold
      ? options.source.registry.scaffold.requiredModules
      : []),
    ...(starter?.modules ?? []),
    ...options.moduleIds,
  ];

  const ordered = resolveModuleOrder(
    options.source.registry,
    requested,
    options.installed,
  );
  ui.trace(`module order: ${ordered.join(" → ") || "(none)"}`);

  const resolvedOptions: Record<string, ResolvedOptions> = {};
  for (const feature of options.existingFeatures ?? []) {
    resolvedOptions[feature.id] = feature.options ?? {};
  }

  const context: ApplyContext = {
    workspace,
    source: options.source,
    vars: options.vars,
    installed: new Set([...options.installed, ...ordered]),
    featureOptions: resolvedOptions,
    interactiveEnv:
      options.interactiveEnv ?? Boolean(options.interactiveOptions),
    interactiveServerConfig:
      options.interactiveServerConfig ??
      options.interactiveEnv ??
      Boolean(options.interactiveOptions),
  };

  if (options.scaffold) {
    ui.trace("applying scaffold");
    await applyScaffold(context);
  }

  const previousById = new Map(
    (options.existingFeatures ?? []).map((feature) => [feature.id, feature]),
  );

  const manifests: ModuleManifest[] = [];

  for (const id of ordered) {
    const manifest = await readModuleManifest(options.source, id);
    const previous = previousById.get(id)?.options;
    const explicitlyRequested = options.moduleIds.includes(id);
    const initMode = options.initMode ?? options.moduleIds.length === 0;
    const moduleOptions = await resolveModuleOptions(
      manifest,
      flagsForModule(flags, id, manifest, explicitlyRequested, initMode),
      previous,
      Boolean(options.interactiveOptions) && explicitlyRequested,
    );

    const optionSummary = Object.entries(moduleOptions)
      .map(
        ([key, value]) =>
          `${key}=${Array.isArray(value) ? value.join(",") : value}`,
      )
      .join(" ");
    ui.trace(
      `applying module ${id}${optionSummary ? ` (${optionSummary})` : ""}`,
    );

    resolvedOptions[id] = moduleOptions;
    await applyModule(context, manifest, moduleOptions);
    manifests.push(manifest);
  }

  // Modules installed earlier may have deferred their Cloud Functions until a functions
  // package existed. If this run created one, collect what they left behind.
  if (ordered.includes("functions")) {
    const candidates = [...new Set([...options.installed, ...ordered])].filter(
      (id) => id !== "functions",
    );

    for (const id of candidates) {
      ui.trace(`backfilling functions for ${id}`);
      const manifest = await readModuleManifest(options.source, id);
      await backfillFunctions(context, manifest);
    }
  }

  if (starter) {
    ui.trace(`applying starter overlay ${starter.id}`);
    await applyStarter(context, starter);
  }

  const features = mergeFeatures(
    options.existingFeatures ?? [],
    manifests,
    resolvedOptions,
  );
  ui.trace("updating RADIANCE.md capabilities");
  await updateConstitution(context, features, starter?.id ?? null);

  ui.trace(
    `stageInstall done — ${workspace.changes().length} staged change(s)`,
  );
  return { workspace, manifests, starter, features, resolvedOptions };
}

/**
 * Flags without a module prefix apply to an explicitly requested module that
 * declares the option, or — during `init` — to whichever module owns it.
 *
 * "During `init`" is now told to us rather than guessed from an empty module
 * list; see `StageOptions.initMode`.
 */
export function flagsForModule(
  flags: OptionFlag[],
  moduleId: string,
  manifest: ModuleManifest,
  explicitlyRequested: boolean,
  initMode: boolean,
): OptionFlag[] {
  return flags.filter((flag) => {
    if (flag.moduleId) return flag.moduleId === moduleId;
    if (!(flag.key in manifest.options)) return false;
    return explicitlyRequested || initMode;
  });
}

function mergeFeatures(
  existing: InstalledFeature[],
  manifests: ModuleManifest[],
  resolvedOptions: Record<string, ResolvedOptions>,
): InstalledFeature[] {
  const byId = new Map(
    existing.map((feature) => [
      feature.id,
      {
        id: feature.id,
        version: feature.version,
        options: feature.options ?? {},
      },
    ]),
  );

  for (const manifest of manifests) {
    byId.set(manifest.id, {
      id: manifest.id,
      version: manifest.version,
      options: resolvedOptions[manifest.id] ?? {},
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const RESERVED_SCHEME_PREFIX = /^[^a-z]+/;

export function deriveVars(
  name: string,
  overrides: Partial<TemplateVars> = {},
): TemplateVars {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const scheme =
    slug.replace(/-/g, "").replace(RESERVED_SCHEME_PREFIX, "") || "radianceapp";

  return {
    appName: name.trim(),
    slug: slug || "radiance-app",
    scheme,
    bundleId: `com.radiance.${scheme}`,
    themePack: "neutral",
    defaultLocale: "en",
    ...overrides,
  };
}
