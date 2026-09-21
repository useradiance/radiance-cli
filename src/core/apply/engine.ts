import fg from "fast-glob";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { buildAuthProvidersConfig } from "../firebase-auth.js";
import {
  collectModuleEnv,
  collectModuleParams,
  collectModuleSecrets,
  FUNCTIONS_ENV,
  FUNCTIONS_ENV_EXAMPLE,
  FUNCTIONS_SECRET_LOCAL,
  noteMissingRequiredEnv,
  noteMissingSecrets,
  noteSuspiciousClientEnv,
  promptModuleEnv,
  readFunctionsFile,
  readWorkspaceEnv,
  upsertFunctionsFile,
  upsertWorkspaceEnv,
} from "../env.js";
import { ui } from "../logger.js";
import {
  applyMapsTo,
  collectOptionEffects,
  optionBooleans,
  optionPlaceholders,
  type ResolvedOptions,
} from "../options.js";
import type {
  ModuleManifest,
  StarterManifest,
  TemplateSource,
} from "../registry.js";
import { moduleDir, starterDir } from "../registry.js";
import {
  insertAtMarker,
  insertImport,
  normalizeMarkerBlock,
  registerProvider,
} from "./markers.js";
import {
  appendEnvExample,
  deepMerge,
  mergeIndexes,
  mergeLocales,
  mergePackageJson,
  parseJson,
  stringifyJson,
} from "./merge.js";
import type { Workspace } from "./workspace.js";

export type TemplateVars = {
  appName: string;
  slug: string;
  scheme: string;
  bundleId: string;
  themePack: string;
  defaultLocale: string;
};

export type ApplyContext = {
  workspace: Workspace;
  source: TemplateSource;
  vars: TemplateVars;
  /** Modules already installed plus the ones being applied in this run. */
  installed: Set<string>;
  /** Resolved options for the module currently being applied. */
  moduleOptions?: ResolvedOptions;
  /** Resolved options keyed by module id for the whole stageInstall run. */
  featureOptions?: Record<string, ResolvedOptions>;
  /** Prompt for module env vars marked `prompt` / `required` when empty. */
  interactiveEnv?: boolean;
  /**
   * Prompt for secrets/params. When false (typical for `init`), only notes are
   * recorded — build/deploy gates enforce presence later.
   */
  interactiveServerConfig?: boolean;
};

const TABS_OVERLAY_PREFIX = "app/(app)/(tabs)/";

/**
 * Starter overlays always author screens under `(tabs)/`. Drawer and stack shells use a
 * different folder, so remap those paths when applying the overlay.
 */
export function remapStarterOverlayPath(
  path: string,
  shell: string | undefined,
): string {
  if (!path.startsWith(TABS_OVERLAY_PREFIX)) return path;
  if (shell === "drawer") {
    return `app/(app)/(drawer)/${path.slice(TABS_OVERLAY_PREFIX.length)}`;
  }
  if (shell === "stack") {
    return `app/(app)/${path.slice(TABS_OVERLAY_PREFIX.length)}`;
  }
  return path;
}

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".icns",
  ".pdf",
  ".zip",
  ".gz",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  ".keystore",
  ".jks",
]);

/** Anything without a known binary extension and without NUL bytes is treated as text. */
function isTextFile(path: string, contents: Buffer): boolean {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();

  if (BINARY_EXTENSIONS.has(extension)) return false;
  return !contents.includes(0);
}

export function substitute(
  content: string,
  vars: TemplateVars,
  extras: Record<string, string> = {},
): string {
  const lookup: Record<string, string> = {
    ...(vars as Record<string, string>),
    ...extras,
  };

  // Dotted keys first (option.providers.email), then simple ones (themePack).
  return content.replace(
    /\{\{radiance\.([a-zA-Z0-9_.]+)\}\}/g,
    (match, key: string) => {
      return lookup[key] ?? match;
    },
  );
}

function moduleExtras(
  ctx: ApplyContext,
  manifest?: ModuleManifest,
): Record<string, string> {
  if (!ctx.moduleOptions) return {};
  const options = ctx.moduleOptions;
  return {
    ...optionPlaceholders(options),
    ...(manifest ? optionBooleans(manifest, options) : {}),
  };
}

type CopyOptions = {
  source: string;
  /** Files this copy may replace even when they already differ. */
  overrides?: string[];
  /** Replace everything — used for starter overlays, which own their domain files. */
  force?: boolean;
  ignore?: string[];
  targetPrefix?: string;
  extras?: Record<string, string>;
};

async function copyTree(
  ctx: ApplyContext,
  fromDir: string,
  options: CopyOptions,
): Promise<void> {
  const entries = await fg("**/*", {
    cwd: fromDir,
    dot: true,
    onlyFiles: true,
    ignore: options.ignore ?? [],
  });

  for (const entry of entries.sort()) {
    const target = options.targetPrefix
      ? posix.join(options.targetPrefix, entry)
      : entry;
    const raw = await readFile(join(fromDir, entry));

    if (!isTextFile(entry, raw)) {
      ctx.workspace.note(
        "warn",
        `Skipped binary file ${entry} — Radiance only applies text files.`,
        options.source,
      );
      continue;
    }

    const contents = substitute(raw.toString("utf8"), ctx.vars, options.extras);
    const existing = await ctx.workspace.read(target);

    if (existing !== null && existing !== contents && !options.force) {
      if (!options.overrides?.includes(target)) {
        ctx.workspace.note(
          "conflict",
          `${target} already exists and differs — kept your version.`,
          options.source,
        );
        ui.trace(`skip conflict ${target} (${options.source})`);
        continue;
      }
    }

    ui.trace(
      `${existing === null ? "write" : "update"} ${target} (${options.source})`,
    );
    await ctx.workspace.write(target, contents, options.source);
  }
}

async function mergeLocaleDir(
  ctx: ApplyContext,
  fromDir: string,
  source: string,
  extras: Record<string, string> = {},
): Promise<void> {
  const files = await fg("*.json", { cwd: fromDir, onlyFiles: true });

  for (const file of files.sort()) {
    const incoming = JSON.parse(await readFile(join(fromDir, file), "utf8"));
    const targetPath = posix.join("locales", file);
    const existing = parseJson(await ctx.workspace.read(targetPath), {});

    const { merged, conflicts } = mergeLocales(
      existing,
      substituteJson(incoming, ctx, extras),
    );

    if (conflicts.length > 0) {
      ctx.workspace.note(
        "info",
        `Kept existing translations for ${conflicts.join(", ")}.`,
        source,
      );
    }

    await ctx.workspace.write(targetPath, stringifyJson(merged), source);
  }
}

function substituteJson(
  value: unknown,
  ctx: ApplyContext,
  extras: Record<string, string> = {},
): Record<string, unknown> {
  return JSON.parse(substitute(JSON.stringify(value), ctx.vars, extras));
}

async function applyFirebase(
  ctx: ApplyContext,
  dir: string,
  firebase: ModuleManifest["firebase"],
  source: string,
): Promise<void> {
  // Security rule fragments are spliced between the markers and tagged with the module id,
  // so reinstalling replaces the previous block instead of duplicating it.
  for (const [target, file] of [
    ["firestore.rules", firebase.rules.firestore],
    ["storage.rules", firebase.rules.storage],
  ] as const) {
    if (!file) continue;

    const fragment = (await readFile(join(dir, file), "utf8")).trimEnd();
    const current = await ctx.workspace.read(target);

    if (current === null) {
      ctx.workspace.note("warn", `No ${target} to merge rules into.`, source);
      continue;
    }

    const next = insertAtMarker(current, "rules", fragment, { tag: source });
    if (next === current) {
      ctx.workspace.note(
        "warn",
        `No radiance:rules marker in ${target}.`,
        source,
      );
      continue;
    }

    await ctx.workspace.write(target, next, source);
  }

  if (firebase.indexes) {
    const incoming = JSON.parse(
      await readFile(join(dir, firebase.indexes), "utf8"),
    );
    const existing = parseJson(
      await ctx.workspace.read("firestore.indexes.json"),
      {
        indexes: [],
        fieldOverrides: [],
      },
    );
    await ctx.workspace.write(
      "firestore.indexes.json",
      stringifyJson(mergeIndexes(existing, incoming)),
      source,
    );
  }

  const hasEmulators = Object.keys(firebase.emulators).length > 0;
  const hasConfig = Object.keys(firebase.config).length > 0;
  const authConfig = buildAuthProvidersConfig(firebase.authProviders, {
    displayName: ctx.vars.appName,
  });

  if (hasEmulators || hasConfig || authConfig) {
    const existing = parseJson(await ctx.workspace.read("firebase.json"), {});
    let merged = existing;
    if (hasConfig) merged = deepMerge(merged, firebase.config);
    if (hasEmulators)
      merged = deepMerge(merged, { emulators: firebase.emulators });
    if (authConfig) merged = deepMerge(merged, { auth: authConfig });
    await ctx.workspace.write("firebase.json", stringifyJson(merged), source);
  }
}

export async function applyScaffold(ctx: ApplyContext): Promise<void> {
  const dir = join(ctx.source.root, ctx.source.registry.scaffold.path);
  ui.trace(`copy scaffold from ${dir}`);
  await copyTree(ctx, dir, {
    source: "scaffold",
    ignore: ["scaffold.json"],
    force: true,
  });
}

export async function applyModule(
  ctx: ApplyContext,
  manifest: ModuleManifest,
  options: ResolvedOptions = {},
): Promise<void> {
  const dir = moduleDir(ctx.source, manifest.id);
  const source = manifest.id;
  const previousOptions = ctx.moduleOptions;
  ctx.moduleOptions = options;

  applyMapsTo(manifest, options, ctx.vars as unknown as Record<string, string>);
  const extras = moduleExtras(ctx, manifest);
  const effects = collectOptionEffects(manifest, options);

  for (const path of manifest.removes) {
    ui.trace(`remove ${path} (${source})`);
    await ctx.workspace.remove(path, source);
  }

  ui.trace(`copy files/ for ${source}`);
  await copyTree(ctx, join(dir, "files"), {
    source,
    overrides: manifest.overrides,
    extras,
  }).catch(() => undefined);

  for (const variant of effects.files) {
    ui.trace(`copy variant ${variant} for ${source}`);
    await copyTree(ctx, join(dir, variant), {
      source,
      overrides: manifest.overrides,
      force: true,
      extras,
    }).catch(() => undefined);
  }

  // Server-side code is only meaningful once the project has a functions project to host it.
  if (ctx.installed.has("functions")) {
    ui.trace(`copy functions/ for ${source}`);
    await copyTree(ctx, join(dir, "functions"), {
      source,
      targetPrefix: "functions",
      overrides: manifest.overrides,
      extras,
    }).catch(() => undefined);
  } else if (await hasDirectory(join(dir, "functions"))) {
    ctx.workspace.note(
      "info",
      `${manifest.id} ships Cloud Functions — run \`radiance add functions\` to install them.`,
      source,
    );
  }

  if (await hasDirectory(join(dir, "locales"))) {
    ui.trace(`merge locales for ${source}`);
    await mergeLocaleDir(ctx, join(dir, "locales"), source, extras);
  }

  const firebase = {
    ...manifest.firebase,
    authProviders:
      effects.authProviders.length > 0
        ? effects.authProviders
        : manifest.firebase.authProviders,
  };
  await applyFirebase(ctx, dir, firebase, source);

  const packageJson = parseJson(await ctx.workspace.read("package.json"), {});
  const { merged, versionConflicts } = mergePackageJson(packageJson, {
    dependencies: { ...manifest.dependencies, ...effects.dependencies },
    devDependencies: {
      ...manifest.devDependencies,
      ...effects.devDependencies,
    },
    scripts: manifest.scripts,
  });

  for (const conflict of versionConflicts) {
    ctx.workspace.note(
      "warn",
      `${conflict.name} is pinned to ${conflict.existing}; ${manifest.id} expects ${conflict.requested}.`,
      source,
    );
  }

  await ctx.workspace.write("package.json", stringifyJson(merged), source);

  const env = collectModuleEnv(manifest, options);
  if (Object.keys(env).length > 0) {
    noteSuspiciousClientEnv(ctx.workspace, manifest.id, env);

    const existingExample = (await ctx.workspace.read(".env.example")) ?? "";
    await ctx.workspace.write(
      ".env.example",
      appendEnvExample(existingExample, manifest.id, env),
      source,
    );

    const existingEnv = await readWorkspaceEnv(ctx.workspace);
    if (ctx.interactiveEnv) {
      const filled = await promptModuleEnv({
        moduleId: manifest.id,
        moduleTitle: manifest.title,
        entries: env,
        existing: existingEnv,
      });
      await upsertWorkspaceEnv(ctx.workspace, filled, source);
      Object.assign(existingEnv, filled);
    }

    noteMissingRequiredEnv(ctx.workspace, manifest.id, env, existingEnv);
  }

  const params = collectModuleParams(manifest, options);
  if (Object.keys(params).length > 0) {
    const existingExample =
      (await ctx.workspace.read(FUNCTIONS_ENV_EXAMPLE)) ?? "";
    await ctx.workspace.write(
      FUNCTIONS_ENV_EXAMPLE,
      appendEnvExample(existingExample, manifest.id, params),
      source,
    );

    const existingParams = await readFunctionsFile(
      ctx.workspace,
      FUNCTIONS_ENV,
    );
    if (ctx.interactiveServerConfig) {
      const filled = await promptModuleEnv({
        moduleId: manifest.id,
        moduleTitle: manifest.title,
        entries: params,
        existing: existingParams,
        headingKind: "server params",
        storeHint: FUNCTIONS_ENV,
      });
      await upsertFunctionsFile(ctx.workspace, FUNCTIONS_ENV, filled, source);
      Object.assign(existingParams, filled);
    }

    noteMissingRequiredEnv(
      ctx.workspace,
      manifest.id,
      params,
      existingParams,
      FUNCTIONS_ENV,
    );
  }

  const secrets = collectModuleSecrets(manifest, options);
  if (Object.keys(secrets).length > 0) {
    const existingSecrets = await readFunctionsFile(
      ctx.workspace,
      FUNCTIONS_SECRET_LOCAL,
    );
    if (ctx.interactiveServerConfig) {
      const filled = await promptModuleEnv({
        moduleId: manifest.id,
        moduleTitle: manifest.title,
        entries: secrets,
        existing: existingSecrets,
        headingKind: "secrets",
        storeHint: FUNCTIONS_SECRET_LOCAL,
        secret: true,
      });
      await upsertFunctionsFile(
        ctx.workspace,
        FUNCTIONS_SECRET_LOCAL,
        filled,
        source,
      );
      Object.assign(existingSecrets, filled);
    }

    noteMissingSecrets(ctx.workspace, manifest.id, secrets, existingSecrets);
    if (!ctx.interactiveServerConfig) {
      for (const key of Object.keys(secrets)) {
        ctx.workspace.note(
          "info",
          `${key} can be set later — required before \`radiance deploy --functions\`.`,
          source,
        );
      }
    }
  }

  ui.trace(`wire providers/markers for ${source}`);
  await applyWiring(ctx, manifest);
  ctx.moduleOptions = previousOptions;
}

async function applyWiring(
  ctx: ApplyContext,
  manifest: ModuleManifest,
): Promise<void> {
  const source = manifest.id;

  for (const provider of manifest.wire.providers) {
    const path = "lib/registry/providers.tsx";
    const current = await ctx.workspace.read(path);
    if (current === null) {
      ctx.workspace.note(
        "warn",
        `No ${path} — provider not registered.`,
        source,
      );
      continue;
    }
    await ctx.workspace.write(
      path,
      registerProvider(current, provider, source),
      source,
    );
  }

  for (const marker of manifest.wire.markers) {
    if (marker.when && !ctx.installed.has(marker.when)) continue;

    const current = await ctx.workspace.read(marker.file);
    if (current === null) {
      ctx.workspace.note(
        "info",
        `Skipped wiring into ${marker.file} — file not present.`,
        source,
      );
      continue;
    }

    let next = current;
    for (const importLine of marker.imports ?? []) {
      next = insertImport(next, importLine);
    }

    const withBlock = insertAtMarker(next, marker.marker, marker.block, {
      tag: source,
    });
    if (
      withBlock === next &&
      !next.includes(normalizeMarkerBlock(marker.block).trim())
    ) {
      ctx.workspace.note(
        "warn",
        `No radiance:${marker.marker} marker in ${marker.file} — wire it by hand.`,
        source,
      );
    }

    await ctx.workspace.write(marker.file, withBlock, source);
  }
}

/**
 * Installs the server-side half of a module that was added before `functions` existed.
 *
 * Modules ship Cloud Functions but skip them when the project has no functions package. When
 * one arrives later this backfills exactly that part, leaving the app code alone.
 */
export async function backfillFunctions(
  ctx: ApplyContext,
  manifest: ModuleManifest,
): Promise<void> {
  const dir = join(moduleDir(ctx.source, manifest.id), "functions");
  if (!(await hasDirectory(dir))) return;

  await copyTree(ctx, dir, {
    source: manifest.id,
    targetPrefix: "functions",
    overrides: manifest.overrides,
  });

  const markers = manifest.wire.markers.filter(
    (marker) => marker.when === "functions",
  );
  if (markers.length === 0) return;

  await applyWiring(ctx, { ...manifest, wire: { ...manifest.wire, markers } });
}

export async function applyStarter(
  ctx: ApplyContext,
  manifest: StarterManifest,
): Promise<void> {
  const dir = starterDir(ctx.source, manifest.id);
  const source = `starter:${manifest.id}`;
  const shell = navigationShell(ctx);

  // Overlays own their domain files and deliberately replace module defaults such as the
  // tab registry and the home screen. Paths under (tabs)/ are rewritten for drawer/stack.
  await copyStarterOverlay(ctx, join(dir, manifest.overlay), source, shell);

  const localeDir = join(dir, manifest.overlay, "locales");
  if (await hasDirectory(localeDir)) {
    await mergeLocaleDir(ctx, localeDir, source);
  }

  await applyFirebase(ctx, dir, manifest.firebase, source);
}

function navigationShell(ctx: ApplyContext): string | undefined {
  const value = ctx.featureOptions?.navigation?.shell;
  return typeof value === "string" ? value : undefined;
}

async function copyStarterOverlay(
  ctx: ApplyContext,
  fromDir: string,
  source: string,
  shell: string | undefined,
): Promise<void> {
  const entries = await fg("**/*", {
    cwd: fromDir,
    dot: true,
    onlyFiles: true,
    ignore: ["locales/**"],
  });

  for (const entry of entries.sort()) {
    const target = remapStarterOverlayPath(entry, shell);
    if (target !== entry) {
      ui.trace(`remap overlay ${entry} → ${target} (shell=${shell})`);
    }

    const raw = await readFile(join(fromDir, entry));
    if (!isTextFile(entry, raw)) {
      ctx.workspace.note(
        "warn",
        `Skipped binary file ${entry} — Radiance only applies text files.`,
        source,
      );
      continue;
    }

    const contents = substitute(raw.toString("utf8"), ctx.vars);
    const existing = await ctx.workspace.read(target);
    ui.trace(`${existing === null ? "write" : "update"} ${target} (${source})`);
    await ctx.workspace.write(target, contents, source);
  }
}

async function hasDirectory(path: string): Promise<boolean> {
  const entries = await fg("**/*", {
    cwd: path,
    onlyFiles: true,
    dot: true,
  }).catch(() => []);
  return entries.length > 0;
}

/** Refreshes the installed-capabilities block in RADIANCE.md. */
export async function updateConstitution(
  ctx: ApplyContext,
  features: { id: string; version: string }[],
  starter: string | null,
): Promise<void> {
  const path = "RADIANCE.md";
  const current = await ctx.workspace.read(path);
  if (current === null) return;

  const lines = [
    "",
    `**Starter:** ${starter ?? "none (bare scaffold)"}`,
    "",
    "**Installed modules**",
    "",
    ...features.map((feature) => {
      const entry = ctx.source.registry.modules.find(
        (module) => module.id === feature.id,
      );
      return `- \`${feature.id}@${feature.version}\` — ${entry?.description ?? ""}`;
    }),
    "",
  ];

  const start = current.indexOf("<!-- radiance:capabilities:start -->");
  const end = current.indexOf("<!-- radiance:capabilities:end -->");
  if (start === -1 || end === -1) return;

  const next =
    current.slice(0, start + "<!-- radiance:capabilities:start -->".length) +
    lines.join("\n") +
    current.slice(end);

  await ctx.workspace.write(path, next, "radiance");
}
