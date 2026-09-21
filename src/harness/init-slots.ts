import { z } from "zod";

import {
  parseOptionFlags,
  validateOptionValue,
  type OptionValue,
} from "../core/options.js";
import { RadianceError } from "../core/logger.js";
import type { ModuleOptionDef, Registry } from "../core/registry.js";
import {
  PACKAGE_MANAGERS,
  PackageManagerSchema,
  type PackageManager,
} from "../core/package-manager.js";

/** Stable interview order. Module option slots follow once the starter is known. */
export const CORE_SLOT_PRIORITY = [
  "name",
  "starterId",
  "packageManager",
  "themePack",
  "locale",
] as const;

export type CoreSlotId = (typeof CORE_SLOT_PRIORITY)[number];

/** Module options that become required when the chosen starter includes that module. */
export const CONDITIONAL_OPTION_SLOTS = [
  { slotId: "navigation.shell", moduleId: "navigation", key: "shell" },
  { slotId: "auth.providers", moduleId: "auth", key: "providers" },
  {
    slotId: "auth.enforceEmailVerification",
    moduleId: "auth",
    key: "enforceEmailVerification",
  },
  {
    slotId: "firestore.nativePersistence",
    moduleId: "firestore",
    key: "nativePersistence",
  },
] as const;

export type OptionSlotId = (typeof CONDITIONAL_OPTION_SLOTS)[number]["slotId"];
export type SlotId = CoreSlotId | OptionSlotId | "firebase" | "bundleId";

export const THEME_PACKS = [
  "neutral",
  "contrast",
  "branded",
  "ocean",
  "ink",
  "hearth",
  "bloom",
  "flare",
  "paper",
  "grove",
  "violet",
  "citrus",
  "custom",
] as const;
export type ThemePack = (typeof THEME_PACKS)[number];

/** Built-in packs shown in the picker (excludes generated `custom`). */
export const BUILTIN_THEME_PACKS = [
  "neutral",
  "contrast",
  "branded",
  "ocean",
  "ink",
  "hearth",
  "bloom",
  "flare",
  "paper",
  "grove",
  "violet",
  "citrus",
] as const;
export type BuiltinThemePack = (typeof BUILTIN_THEME_PACKS)[number];

export const THEME_PACK_META: Record<
  BuiltinThemePack,
  { label: string; description: string }
> = {
  neutral: {
    label: "Neutral",
    description: "Cool graphite with a confident blue accent",
  },
  contrast: {
    label: "High contrast",
    description: "Near-black / near-white with vivid amber focus",
  },
  branded: {
    label: "Branded",
    description: "Deep ink with a coral rose accent",
  },
  ocean: { label: "Ocean", description: "Teal and cyan maritime surfaces" },
  ink: {
    label: "Ink",
    description: "Editorial black / white with electric indigo",
  },
  hearth: {
    label: "Hearth",
    description: "Warm terracotta and cream",
  },
  bloom: {
    label: "Bloom",
    description: "Dusty mauve for appointments",
  },
  flare: {
    label: "Flare",
    description: "Sunset orange for events",
  },
  paper: {
    label: "Paper",
    description: "Warm ivory with olive ink",
  },
  grove: {
    label: "Grove",
    description: "Forest green for local maps",
  },
  violet: {
    label: "Violet",
    description: "Deep purple for communities",
  },
  citrus: {
    label: "Citrus",
    description: "Gold and lime for habits",
  },
};

export const COMMON_LOCALES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "ja",
  "ko",
  "zh",
  "ar",
  "nl",
  "pl",
  "sv",
  "tr",
] as const;

export const InitPlanSchema = z.object({
  name: z.string().min(1).optional(),
  /** `null` means bare scaffold; omit until the user chooses. */
  starterId: z.union([z.string().min(1), z.null()]).optional(),
  themePack: z.enum(THEME_PACKS).optional(),
  /** Free-text theme description when the user chose "describe". */
  themeDescription: z.string().min(1).optional(),
  /** Hex seed when the user pasted colors. */
  themeColors: z
    .object({
      primary: z.string().min(1),
      background: z.string().optional(),
      accent: z.string().optional(),
    })
    .optional(),
  /**
   * Fully generated custom pack (from LLM or hex expansion).
   * Written to lib/theme/packs/custom.ts during init.
   */
  customTheme: z
    .object({
      id: z.string(),
      label: z.string(),
      description: z.string().optional(),
      light: z.record(z.string(), z.string()),
      dark: z.record(z.string(), z.string()),
    })
    .optional(),
  /** Default locale (BCP-47). */
  locale: z.string().min(1).optional(),
  /** All locales to ship (includes default). */
  locales: z.array(z.string().min(1)).optional(),
  /** Ask LLM to translate non-default locale files after install. */
  translateLocales: z.boolean().optional(),
  packageManager: PackageManagerSchema.optional(),
  bundleId: z.string().min(1).optional(),
  /** Module options keyed as `moduleId.key` (e.g. `auth.providers`). */
  options: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .default({}),
  firebase: z.boolean().optional(),
  /**
   * Catalogue modules to install in addition to the starter.
   * Filled from the prompt↔starter delta (e.g. maps for a geo social app).
   */
  extraModules: z.array(z.string()).default([]),
  /** Product gaps the starter does not cover — used to build followUpPrompt. */
  promptGaps: z.array(z.string()).default([]),
  /** Billing posture implied by modules / the opening prompt. */
  suggestedPlan: z.enum(["free", "paid"]).optional(),
  /** Original NL description (kept for delta + follow-up). */
  openingPrompt: z.string().optional(),
  followUpPrompt: z.string().optional(),
  rationale: z.string().optional(),
});

export type InitPlan = z.infer<typeof InitPlanSchema>;
export type ProjectPlanHint = NonNullable<InitPlan["suggestedPlan"]>;

export type OptionCatalog = Record<string, ModuleOptionDef>;

export type Completeness = {
  ok: boolean;
  missing: SlotId[];
};

/** Modules installed for this plan (starter list, or scaffold required modules). */
export function modulesForPlan(plan: InitPlan, registry: Registry): string[] {
  if (plan.starterId === undefined) return [];
  if (plan.starterId === null) return [...registry.scaffold.requiredModules];

  const starter = registry.starters.find(
    (entry) => entry.id === plan.starterId,
  );
  return starter ? [...starter.modules] : [];
}

/** Starter/scaffold modules plus any prompt-delta extras. */
export function allModulesForPlan(
  plan: InitPlan,
  registry: Registry,
): string[] {
  const base = modulesForPlan(plan, registry);
  const extras = (plan.extraModules ?? []).filter(
    (id) =>
      !base.includes(id) && registry.modules.some((module) => module.id === id),
  );
  return [...base, ...extras];
}

export function optionSlotIdsForPlan(
  plan: InitPlan,
  registry: Registry,
): OptionSlotId[] {
  const modules = new Set(allModulesForPlan(plan, registry));
  return CONDITIONAL_OPTION_SLOTS.filter((slot) =>
    modules.has(slot.moduleId),
  ).map((slot) => slot.slotId);
}

/** Required slots still empty — code-owned delta for the interview. */
export function missingSlots(plan: InitPlan, registry: Registry): SlotId[] {
  const missing: SlotId[] = [];

  for (const slot of CORE_SLOT_PRIORITY) {
    if (slot === "starterId") {
      if (plan.starterId === undefined) missing.push(slot);
      continue;
    }
    if (slot === "locale") {
      if (!plan.locale?.trim() || !plan.locales?.length) missing.push(slot);
      continue;
    }
    if (plan[slot] === undefined || plan[slot] === "") missing.push(slot);
  }

  for (const slotId of optionSlotIdsForPlan(plan, registry)) {
    if (plan.options[slotId] === undefined) missing.push(slotId);
  }

  return missing;
}

export function isPlanComplete(
  plan: InitPlan,
  registry: Registry,
): Completeness {
  const missing = missingSlots(plan, registry);
  return { ok: missing.length === 0, missing };
}

export type InitFlagSeed = {
  name?: string;
  template?: string;
  scaffold?: boolean;
  themePack?: string;
  /** Only pass when the user actually set `--locale` (not a Commander default). */
  locale?: string;
  bundleId?: string;
  pm?: string;
  packageManager?: string;
  option?: string[];
  firebase?: boolean;
};

/** Highest-precedence seed: explicit CLI flags. Never invents values. */
export function applyFlagOverrides(
  plan: InitPlan,
  flags: InitFlagSeed,
  registry: Registry,
): InitPlan {
  const next: InitPlan = {
    ...plan,
    options: { ...plan.options },
  };

  if (flags.name?.trim()) next.name = flags.name.trim();

  if (flags.scaffold) {
    next.starterId = null;
  } else if (flags.template) {
    if (!registry.starters.some((starter) => starter.id === flags.template)) {
      throw new RadianceError(
        `Unknown starter "${flags.template}"`,
        `Available: ${registry.starters.map((starter) => starter.id).join(", ")}`,
      );
    }
    next.starterId = flags.template;
  }

  if (flags.themePack) {
    if (!THEME_PACKS.includes(flags.themePack as ThemePack)) {
      throw new RadianceError(
        `Unknown theme pack "${flags.themePack}"`,
        `Choose one of: ${THEME_PACKS.join(", ")}.`,
      );
    }
    next.themePack = flags.themePack as ThemePack;
  }

  if (flags.locale?.trim()) {
    const parts = flags.locale
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      next.locales = [...new Set(parts)];
      next.locale = parts[0]!;
    }
  }
  if (flags.bundleId?.trim()) next.bundleId = flags.bundleId.trim();

  const pm = flags.pm ?? flags.packageManager;
  if (pm) {
    if (!PACKAGE_MANAGERS.includes(pm as PackageManager)) {
      throw new RadianceError(
        `Unknown package manager "${pm}"`,
        `Choose one of: ${PACKAGE_MANAGERS.join(", ")}.`,
      );
    }
    next.packageManager = pm as PackageManager;
  }

  if (flags.firebase === false) next.firebase = false;

  if (flags.option?.length) {
    for (const flag of parseOptionFlags(flags.option)) {
      const slotId = flag.moduleId
        ? `${flag.moduleId}.${flag.key}`
        : guessOptionSlot(flag.key);
      next.options[slotId] = flag.raw.includes(",")
        ? flag.raw
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : flag.raw;
    }
  }

  return next;
}

function guessOptionSlot(key: string): string {
  const known = CONDITIONAL_OPTION_SLOTS.find((slot) => slot.key === key);
  if (known) return known.slotId;
  if (key === "pack") return "theme.pack";
  return key;
}

/**
 * Autofill remaining required slots for `-y`. Errors if `name` is still missing.
 * Uses starter defaults then catalogue / code defaults.
 */
export function applyDefaultsForYes(
  plan: InitPlan,
  registry: Registry,
  catalog: OptionCatalog,
  defaultPackageManager: PackageManager = "npm",
): InitPlan {
  if (!plan.name?.trim()) {
    throw new RadianceError(
      "Missing app name",
      'Pass a directory name: `radiance init my-app --prompt "..." -y`.',
    );
  }

  const next: InitPlan = {
    ...plan,
    options: { ...plan.options },
  };

  if (next.starterId === undefined) next.starterId = null;

  const starter =
    next.starterId === null
      ? undefined
      : registry.starters.find((entry) => entry.id === next.starterId);

  if (!next.themePack) {
    const fromStarter = starter?.defaults?.themePack;
    next.themePack = BUILTIN_THEME_PACKS.includes(
      fromStarter as BuiltinThemePack,
    )
      ? (fromStarter as ThemePack)
      : "neutral";
  }

  if (!next.locale) {
    next.locale = starter?.defaults?.defaultLocale ?? "en";
  }
  if (!next.locales?.length) {
    next.locales = [next.locale];
  }
  if (!next.locales.includes(next.locale)) {
    next.locales = [next.locale, ...next.locales];
  }

  if (!next.packageManager) {
    next.packageManager = defaultPackageManager;
  }

  for (const slotId of optionSlotIdsForPlan(next, registry)) {
    if (next.options[slotId] !== undefined) continue;
    const def = catalog[slotId];
    if (!def) continue;
    next.options[slotId] = defaultOptionValue(def);
  }

  // Theme pack maps onto the theme module option when present.
  if (modulesForPlan(next, registry).includes("theme") && next.themePack) {
    next.options["theme.pack"] = next.themePack;
  }

  if (next.firebase === undefined) next.firebase = false;

  return next;
}

export function defaultOptionValue(def: ModuleOptionDef): OptionValue {
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

/** Merge model/heuristic updates without overwriting already-filled slots or flag seeds. */
export function mergePlanUpdates(
  plan: InitPlan,
  updates: Partial<InitPlan>,
  locked: ReadonlySet<string>,
): InitPlan {
  const next: InitPlan = {
    ...plan,
    options: { ...plan.options },
  };

  const assign = <K extends keyof InitPlan>(
    key: K,
    value: InitPlan[K] | undefined,
  ) => {
    if (value === undefined) return;
    if (locked.has(key)) return;
    if (key === "starterId") {
      if (plan.starterId !== undefined) return;
      next.starterId = value as InitPlan["starterId"];
      return;
    }
    if (key === "options") return;
    if (plan[key] !== undefined && plan[key] !== "") return;
    next[key] = value as never;
  };

  assign("name", updates.name);
  assign("starterId", updates.starterId);
  assign("themePack", updates.themePack);
  assign("locale", updates.locale);
  assign("packageManager", updates.packageManager);
  assign("bundleId", updates.bundleId);
  assign("firebase", updates.firebase);

  if (updates.themeDescription && !locked.has("themePack")) {
    next.themeDescription = updates.themeDescription;
  }
  if (updates.themeColors && !locked.has("themePack")) {
    next.themeColors = updates.themeColors;
  }
  if (updates.customTheme && !locked.has("themePack")) {
    next.customTheme = updates.customTheme;
  }
  if (updates.locales?.length && !locked.has("locale")) {
    if (!plan.locales?.length) next.locales = [...updates.locales];
  }
  if (updates.translateLocales !== undefined && !locked.has("locale")) {
    if (plan.translateLocales === undefined)
      next.translateLocales = updates.translateLocales;
  }

  if (updates.followUpPrompt) next.followUpPrompt = updates.followUpPrompt;
  if (updates.rationale) next.rationale = updates.rationale;
  if (updates.openingPrompt) next.openingPrompt = updates.openingPrompt;
  if (updates.suggestedPlan && !locked.has("suggestedPlan")) {
    next.suggestedPlan = updates.suggestedPlan;
  }

  if (updates.extraModules?.length) {
    const merged = new Set([
      ...(next.extraModules ?? []),
      ...updates.extraModules,
    ]);
    next.extraModules = [...merged];
  }
  if (updates.promptGaps?.length) {
    const gaps = [...(next.promptGaps ?? [])];
    for (const gap of updates.promptGaps) {
      if (
        !gaps.some((existing) => existing.toLowerCase() === gap.toLowerCase())
      ) {
        gaps.push(gap);
      }
    }
    next.promptGaps = gaps;
  }

  if (updates.options) {
    for (const [key, value] of Object.entries(updates.options)) {
      if (locked.has(`options.${key}`)) continue;
      if (next.options[key] !== undefined) continue;
      next.options[key] = value;
    }
  }

  return next;
}

export function lockedSlotsFromFlags(flags: InitFlagSeed): Set<string> {
  const locked = new Set<string>();
  if (flags.name?.trim()) locked.add("name");
  if (flags.scaffold || flags.template) locked.add("starterId");
  if (flags.themePack) locked.add("themePack");
  if (flags.locale?.trim()) locked.add("locale");
  if (flags.bundleId?.trim()) locked.add("bundleId");
  if (flags.pm ?? flags.packageManager) locked.add("packageManager");
  if (flags.firebase === false) locked.add("firebase");
  if (flags.option?.length) {
    for (const flag of parseOptionFlags(flags.option)) {
      const slotId = flag.moduleId
        ? `${flag.moduleId}.${flag.key}`
        : guessOptionSlot(flag.key);
      locked.add(`options.${slotId}`);
      if (flag.key === "pack" || slotId === "theme.pack")
        locked.add("themePack");
    }
  }
  return locked;
}

/** Validate option values against the catalogue; drop or throw unknown keys. */
export function sanitizePlanOptions(
  plan: InitPlan,
  catalog: OptionCatalog,
  { strict = false }: { strict?: boolean } = {},
): InitPlan {
  const options: Record<string, OptionValue> = {};

  for (const [slotId, value] of Object.entries(plan.options)) {
    const def = catalog[slotId];
    if (!def) {
      if (strict) throw new Error(`Unknown option slot "${slotId}"`);
      continue;
    }
    try {
      validateOptionValue(slotId, def, value);
      options[slotId] = Array.isArray(value) ? [...new Set(value)] : value;
    } catch (error) {
      if (strict) throw error;
    }
  }

  return { ...plan, options };
}

/** Turn resolved options into `--option` flags for `stageInstall`. */
export function planToOptionFlags(plan: InitPlan): string[] {
  const flags: string[] = [];

  for (const [slotId, value] of Object.entries(plan.options)) {
    const raw = Array.isArray(value) ? value.join(",") : value;
    flags.push(`${slotId}=${raw}`);
  }

  if (plan.themePack && !plan.options["theme.pack"] && !plan.options.pack) {
    flags.push(`pack=${plan.themePack}`);
  }

  return flags;
}

/** Apply a Clack answer for the current slot, respecting flag locks only. */
export function applyInterviewAnswer(
  plan: InitPlan,
  updates: Partial<InitPlan>,
  locked: ReadonlySet<string>,
): InitPlan {
  const next: InitPlan = {
    ...plan,
    options: { ...plan.options },
  };

  if (updates.name !== undefined && !locked.has("name"))
    next.name = updates.name;
  if (updates.starterId !== undefined && !locked.has("starterId")) {
    next.starterId = updates.starterId;
  }
  if (updates.themePack !== undefined && !locked.has("themePack")) {
    next.themePack = updates.themePack;
  }
  if (updates.themeDescription !== undefined && !locked.has("themePack")) {
    next.themeDescription = updates.themeDescription;
  }
  if (updates.themeColors !== undefined && !locked.has("themePack")) {
    next.themeColors = updates.themeColors;
  }
  if (updates.customTheme !== undefined && !locked.has("themePack")) {
    next.customTheme = updates.customTheme;
  }
  if (updates.locale !== undefined && !locked.has("locale"))
    next.locale = updates.locale;
  if (updates.locales !== undefined && !locked.has("locale"))
    next.locales = updates.locales;
  if (updates.translateLocales !== undefined && !locked.has("locale")) {
    next.translateLocales = updates.translateLocales;
  }
  if (updates.packageManager !== undefined && !locked.has("packageManager")) {
    next.packageManager = updates.packageManager;
  }
  if (updates.bundleId !== undefined && !locked.has("bundleId")) {
    next.bundleId = updates.bundleId;
  }
  if (updates.firebase !== undefined && !locked.has("firebase")) {
    next.firebase = updates.firebase;
  }
  if (updates.followUpPrompt) next.followUpPrompt = updates.followUpPrompt;
  if (updates.rationale) next.rationale = updates.rationale;
  if (updates.extraModules?.length) {
    next.extraModules = [
      ...new Set([...(next.extraModules ?? []), ...updates.extraModules]),
    ];
  }
  if (updates.promptGaps?.length) {
    const gaps = [...(next.promptGaps ?? [])];
    for (const gap of updates.promptGaps) {
      if (
        !gaps.some((existing) => existing.toLowerCase() === gap.toLowerCase())
      ) {
        gaps.push(gap);
      }
    }
    next.promptGaps = gaps;
  }
  if (updates.suggestedPlan) next.suggestedPlan = updates.suggestedPlan;
  if (updates.openingPrompt) next.openingPrompt = updates.openingPrompt;

  if (updates.options) {
    for (const [key, value] of Object.entries(updates.options)) {
      if (locked.has(`options.${key}`)) continue;
      next.options[key] = value;
    }
  }

  return next;
}

export function emptyPlan(): InitPlan {
  return { options: {}, extraModules: [], promptGaps: [] };
}

/**
 * Compact human-readable progress line for the interview.
 * Example: "social-app · branded theme · yarn · plus maps · paid plan recommended"
 */
export function describePlan(plan: InitPlan): string {
  const parts: string[] = [];

  if (plan.name) parts.push(plan.name);

  if (plan.starterId === null) parts.push("bare scaffold");
  else if (plan.starterId) parts.push(plan.starterId);

  if (plan.themePack) parts.push(`${plan.themePack} theme`);
  if (plan.locales && plan.locales.length > 1) {
    parts.push(`locales ${plan.locales.join(",")}`);
  } else if (plan.locale && plan.locale !== "en") {
    parts.push(`locale ${plan.locale}`);
  }
  if (plan.packageManager) parts.push(plan.packageManager);

  if (plan.extraModules?.length) {
    parts.push(`plus ${plan.extraModules.join(", ")}`);
  }

  if (plan.suggestedPlan === "paid") parts.push("paid plan recommended");
  else if (plan.suggestedPlan === "free") parts.push("free plan");

  const shell = plan.options["navigation.shell"];
  if (typeof shell === "string") parts.push(`${shell} navigation`);

  const providers = plan.options["auth.providers"];
  if (Array.isArray(providers) && providers.length > 0) {
    parts.push(`${providers.join("/")} auth`);
  } else if (typeof providers === "string" && providers) {
    parts.push(`${providers} auth`);
  }

  return parts.join(" · ");
}

/** Multi-line summary for the final confirm screen. */
export function formatPlanSummary(plan: InitPlan): string[] {
  const lines: string[] = [];

  if (plan.name) lines.push(`App       ${plan.name}`);
  if (plan.starterId === null) lines.push("Starter   bare scaffold");
  else if (plan.starterId) lines.push(`Starter   ${plan.starterId}`);
  if (plan.themePack) lines.push(`Theme     ${plan.themePack}`);
  if (plan.locales?.length) {
    lines.push(
      `Locales   ${plan.locales.join(", ")} (default ${plan.locale ?? plan.locales[0]})`,
    );
  } else if (plan.locale) {
    lines.push(`Locale    ${plan.locale}`);
  }
  if (plan.packageManager) lines.push(`Packages  ${plan.packageManager}`);

  if (plan.extraModules?.length) {
    lines.push(`Also add  ${plan.extraModules.join(", ")}`);
  }

  if (plan.suggestedPlan === "paid") {
    lines.push("Plan      paid (recommended — Storage / Functions)");
  } else if (plan.suggestedPlan === "free") {
    lines.push("Plan      free");
  }

  const shell = plan.options["navigation.shell"];
  if (typeof shell === "string") lines.push(`Nav       ${shell}`);

  const providers = plan.options["auth.providers"];
  if (Array.isArray(providers) && providers.length > 0) {
    lines.push(`Auth      ${providers.join(", ")}`);
  } else if (typeof providers === "string" && providers) {
    lines.push(`Auth      ${providers}`);
  }

  return lines;
}
