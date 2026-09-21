import * as prompts from "@clack/prompts";
import { z } from "zod";

import type { GlobalConfig } from "../core/config.js";
import { RadianceError, ui } from "../core/logger.js";
import {
  PACKAGE_MANAGERS,
  detectInstalled,
  resolvePackageManager,
  type PackageManager,
} from "../core/package-manager.js";
import {
  readModuleManifest,
  type Registry,
  type TemplateSource,
} from "../core/registry.js";
import { createClient, extractJson, type LlmClient } from "./llm.js";
import {
  BUILTIN_THEME_PACKS,
  COMMON_LOCALES,
  THEME_PACK_META,
  THEME_PACKS,
  applyDefaultsForYes,
  applyFlagOverrides,
  applyInterviewAnswer,
  describePlan,
  formatPlanSummary,
  emptyPlan,
  isPlanComplete,
  lockedSlotsFromFlags,
  mergePlanUpdates,
  missingSlots,
  sanitizePlanOptions,
  type BuiltinThemePack,
  type InitFlagSeed,
  type InitPlan,
  type OptionCatalog,
  type SlotId,
} from "./init-slots.js";
import { buildInitExtractPrompt, buildThemePackPrompt } from "./prompts.js";
import { applyPromptDelta, computePromptDelta } from "./prompt-delta.js";
import { matchStarters } from "./retrieval.js";
import {
  assertHex,
  expandThemeFromHex,
  isThemeColors,
  mapVibeToBuiltin,
  type ThemePackData,
} from "./theme-palette.js";

/** Models often emit `null` for omitted fields; Zod `.optional()` rejects that. */
function stripNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const cleaned = stripNulls(entry);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

function softEnum<T extends string>(values: readonly T[]) {
  return z.preprocess(
    (value) => {
      if (value === null || value === undefined || value === "")
        return undefined;
      return (values as readonly string[]).includes(value as string)
        ? value
        : undefined;
    },
    z.enum(values as [T, ...T[]]).optional(),
  );
}

const optionalString = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z.string().optional(),
);

const ExtractResponseSchema = z.object({
  updates: z
    .object({
      name: optionalString,
      starterId: z.union([z.string(), z.null()]).optional(),
      themePack: softEnum(THEME_PACKS),
      locale: optionalString,
      packageManager: softEnum(PACKAGE_MANAGERS),
      bundleId: optionalString,
      options: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .optional(),
      firebase: z.preprocess(
        (value) => (value === null ? undefined : value),
        z.boolean().optional(),
      ),
      extraModules: z.array(z.string()).optional(),
      promptGaps: z.array(z.string()).optional(),
      suggestedPlan: softEnum(["free", "paid"] as const),
    })
    .default({}),
  rationale: optionalString,
  followUpPrompt: optionalString,
});

/** Parse an LLM init-extract payload, tolerating nulls and junk enum values. */
export function parseInitExtractResponse(
  raw: unknown,
): z.infer<typeof ExtractResponseSchema> {
  return ExtractResponseSchema.parse(stripNulls(raw));
}

export type InitInterviewFlags = InitFlagSeed & {
  prompt?: string;
  yes?: boolean;
  provider?: string;
  model?: string;
};

export type InitInterviewResult = {
  plan: InitPlan;
  usedLlm: boolean;
};

/** Load option defs for conditional slots (+ theme.pack) from the template source. */
export async function loadOptionCatalog(
  source: TemplateSource,
): Promise<OptionCatalog> {
  const catalog: OptionCatalog = {};
  const moduleIds = ["navigation", "auth", "firestore", "theme"] as const;

  for (const moduleId of moduleIds) {
    if (!source.registry.modules.some((module) => module.id === moduleId))
      continue;
    const manifest = await readModuleManifest(source, moduleId);
    for (const [key, def] of Object.entries(manifest.options)) {
      catalog[`${moduleId}.${key}`] = def;
    }
  }

  return catalog;
}

function formatAllowedOptions(catalog: OptionCatalog): string {
  return Object.entries(catalog)
    .map(([slotId, def]) => {
      const kind = def.type === "multi" ? "multi" : "single";
      return `- ${slotId} (${kind}): ${def.choices.join(" | ")} (default: ${JSON.stringify(def.default)})`;
    })
    .join("\n");
}

function planSummaryForPrompt(plan: InitPlan): string {
  const lines: string[] = [];
  if (plan.name) lines.push(`name=${plan.name}`);
  if (plan.starterId !== undefined) {
    lines.push(
      `starterId=${plan.starterId === null ? "null" : plan.starterId}`,
    );
  }
  if (plan.themePack) lines.push(`themePack=${plan.themePack}`);
  if (plan.locale) lines.push(`locale=${plan.locale}`);
  if (plan.packageManager) lines.push(`packageManager=${plan.packageManager}`);
  if (plan.bundleId) lines.push(`bundleId=${plan.bundleId}`);
  for (const [key, value] of Object.entries(plan.options)) {
    lines.push(
      `options.${key}=${Array.isArray(value) ? value.join(",") : value}`,
    );
  }
  return lines.join("\n");
}

/** Deterministic extraction when the LLM is unavailable. */
export function heuristicExtract(
  utterance: string,
  registry: Registry,
): Partial<InitPlan> {
  const lower = utterance.toLowerCase();
  const updates: Partial<InitPlan> = { options: {} };

  const matches = matchStarters(registry, utterance);
  if (matches[0] && matches[0].score >= 3) {
    updates.starterId = matches[0].id;
  }

  if (/\b(drawer)\b/.test(lower))
    updates.options!["navigation.shell"] = "drawer";
  else if (/\b(stack)\b/.test(lower))
    updates.options!["navigation.shell"] = "stack";
  else if (/\b(tabs?|tab bar)\b/.test(lower))
    updates.options!["navigation.shell"] = "tabs";

  const providers: string[] = [];
  if (/\bgoogle\b/.test(lower)) providers.push("google");
  if (/\bapple\b/.test(lower)) providers.push("apple");
  if (/\banonymous\b/.test(lower)) providers.push("anonymous");
  if (/\bemail\b/.test(lower) || /\bpassword\b/.test(lower))
    providers.push("email");
  if (providers.length > 0) updates.options!["auth.providers"] = providers;

  if (/\bcontrast\b/.test(lower)) updates.themePack = "contrast";
  else if (/\bbranded\b/.test(lower)) updates.themePack = "branded";
  else if (/\bocean\b/.test(lower)) updates.themePack = "ocean";
  else if (/\bhearth\b/.test(lower)) updates.themePack = "hearth";
  else if (/\bbloom\b/.test(lower)) updates.themePack = "bloom";
  else if (/\bflare\b/.test(lower)) updates.themePack = "flare";
  else if (/\bpaper\b/.test(lower)) updates.themePack = "paper";
  else if (/\bgrove\b/.test(lower)) updates.themePack = "grove";
  else if (/\bviolet\b/.test(lower)) updates.themePack = "violet";
  else if (/\bcitrus\b/.test(lower)) updates.themePack = "citrus";
  else if (/\bink\b/.test(lower)) updates.themePack = "ink";
  else if (/\bneutral\b/.test(lower)) updates.themePack = "neutral";

  for (const pm of PACKAGE_MANAGERS) {
    if (new RegExp(`\\b${pm}\\b`).test(lower)) {
      updates.packageManager = pm;
      break;
    }
  }

  const localeMatch = lower.match(
    /\blocale(?:s)?\s*[:=]?\s*([a-z]{2}(?:-[a-z]{2})?(?:\s*,\s*[a-z]{2}(?:-[a-z]{2})?)*)\b/,
  );
  if (localeMatch?.[1]) {
    const codes = localeMatch[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (codes.length > 0) {
      updates.locales = codes;
      updates.locale = codes[0];
    }
  }

  const nameMatch =
    utterance.match(
      /\b(?:call(?:ed)?|name(?:d)?)\s+(?:it|the app)?\s*["']?([A-Za-z][\w-]*)["']?/i,
    ) ??
    utterance.match(
      /\b(?:app|project)\s+(?:named|called)\s+["']?([A-Za-z][\w-]*)["']?/i,
    );
  if (
    nameMatch?.[1] &&
    !["the", "my", "an", "a"].includes(nameMatch[1].toLowerCase())
  ) {
    updates.name = nameMatch[1];
  }

  if (Object.keys(updates.options!).length === 0) delete updates.options;
  return updates;
}

async function llmExtract(
  client: LlmClient,
  utterance: string,
  plan: InitPlan,
  registry: Registry,
  catalog: OptionCatalog,
): Promise<
  Partial<InitPlan> & { followUpPrompt?: string; rationale?: string }
> {
  const missing = missingSlots(plan, registry);
  const raw = await client.complete(
    [
      {
        role: "system",
        content:
          "You extract Radiance init settings as JSON. Keep rationale under 12 words, friendly and direct — never formal or academic.",
      },
      {
        role: "user",
        content: buildInitExtractPrompt({
          utterance,
          planSummary: planSummaryForPrompt(plan),
          missing,
          starters: registry.starters,
          starterMatches: matchStarters(registry, utterance),
          allowedOptions: formatAllowedOptions(catalog),
          moduleLines: registry.modules
            .map(
              (module) =>
                `- ${module.id}: ${module.description} [${module.capabilities.join(", ")}]`,
            )
            .join("\n"),
        }),
      },
    ],
    { json: true, temperature: 0, maxTokens: 2048 },
  );

  const parsed = parseInitExtractResponse(extractJson(raw));
  const updates: Partial<InitPlan> = { ...parsed.updates };

  if (updates.starterId !== undefined && updates.starterId !== null) {
    if (
      !registry.starters.some((starter) => starter.id === updates.starterId)
    ) {
      const best = matchStarters(registry, utterance)[0];
      updates.starterId = best ? best.id : undefined;
    }
  }

  // Tooling / local prefs — never invent these; heuristics may set them when named.
  delete updates.packageManager;
  delete updates.themePack;
  delete updates.locale;

  if (updates.extraModules) {
    updates.extraModules = updates.extraModules.filter((id) =>
      registry.modules.some((module) => module.id === id),
    );
  }

  return {
    ...updates,
    rationale: parsed.rationale ? tidyRationale(parsed.rationale) : undefined,
    followUpPrompt: parsed.followUpPrompt,
  };
}

/** Keep on-screen LLM copy short even when the model ignores tone instructions. */
export function tidyRationale(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const first = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  if (first.length <= 100) return first.replace(/\.$/, "");
  return `${first.slice(0, 97).trimEnd()}…`;
}

async function extractFromUtterance(
  utterance: string,
  plan: InitPlan,
  registry: Registry,
  catalog: OptionCatalog,
  client: LlmClient | undefined,
): Promise<{ updates: Partial<InitPlan>; usedLlm: boolean }> {
  const heuristics = heuristicExtract(utterance, registry);

  if (client) {
    try {
      const extracted = await llmExtract(
        client,
        utterance,
        plan,
        registry,
        catalog,
      );
      // Re-apply only the local prefs heuristics actually found in the utterance.
      return {
        updates: {
          ...extracted,
          ...(heuristics.packageManager
            ? { packageManager: heuristics.packageManager }
            : {}),
          ...(heuristics.themePack ? { themePack: heuristics.themePack } : {}),
          ...(heuristics.locale ? { locale: heuristics.locale } : {}),
          ...(heuristics.locales ? { locales: heuristics.locales } : {}),
        },
        usedLlm: true,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Init LLM extract failed";
      const hint = error instanceof RadianceError ? error.hint : undefined;
      ui.warn(`${message}; using heuristics.`);
      if (hint) ui.detail(hint);
    }
  }

  return { updates: heuristics, usedLlm: false };
}

async function generateThemeFromDescription(
  client: LlmClient,
  description: string,
): Promise<ThemePackData> {
  const raw = await client.complete(
    [
      {
        role: "system",
        content:
          "You design cohesive light and dark colour palettes for mobile apps. Reply with JSON only.",
      },
      { role: "user", content: buildThemePackPrompt(description) },
    ],
    { json: true, temperature: 0.4, maxTokens: 2048 },
  );

  const parsed = extractJson<{
    label?: string;
    description?: string;
    light?: unknown;
    dark?: unknown;
  }>(raw);

  if (!isThemeColors(parsed.light) || !isThemeColors(parsed.dark)) {
    throw new RadianceError(
      "Theme model returned an incomplete palette",
      "Try again, pick a built-in pack, or paste hex colours instead.",
    );
  }

  return {
    id: "custom",
    label: parsed.label?.trim() || "Custom",
    description: parsed.description?.trim() || description.slice(0, 80),
    light: parsed.light,
    dark: parsed.dark,
  };
}

async function askThemeStep(
  plan: InitPlan,
  registry: Registry,
  client: LlmClient | undefined,
): Promise<Partial<InitPlan>> {
  const starter =
    plan.starterId && plan.starterId !== null
      ? registry.starters.find((entry) => entry.id === plan.starterId)
      : undefined;
  const suggested = starter?.defaults?.themePack;
  const initialBuiltin = BUILTIN_THEME_PACKS.includes(
    suggested as BuiltinThemePack,
  )
    ? (suggested as BuiltinThemePack)
    : "neutral";

  const mode = await prompts.select({
    message: "How do you want to theme the app?",
    options: [
      {
        value: "builtin",
        label: "Built-in pack",
        hint: suggested ? `starter suggests ${suggested}` : "curated palettes",
      },
      {
        value: "describe",
        label: "Describe a vibe",
        hint: client
          ? "LLM generates a custom palette"
          : "maps to closest built-in",
      },
      {
        value: "colors",
        label: "Enter colours",
        hint: "primary hex (+ optional background / accent)",
      },
    ],
    initialValue: "builtin",
  });
  if (prompts.isCancel(mode)) throw new RadianceError("Cancelled.");

  if (mode === "builtin") {
    const choice = await prompts.select({
      message: "Theme pack",
      options: BUILTIN_THEME_PACKS.map((pack) => ({
        value: pack,
        label: THEME_PACK_META[pack].label,
        hint:
          pack === initialBuiltin && suggested
            ? `starter default · ${THEME_PACK_META[pack].description}`
            : THEME_PACK_META[pack].description,
      })),
      initialValue: initialBuiltin,
    });
    if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
    return {
      themePack: choice as (typeof THEME_PACKS)[number],
      options: { "theme.pack": choice as string },
    };
  }

  if (mode === "describe") {
    const description = await prompts.text({
      message: "Describe the look and feel (colours, mood, references)",
      placeholder:
        "dark maritime teal with soft cyan accents, calm and premium",
      validate: (value) =>
        value?.trim() ? undefined : "Describe the theme you want",
    });
    if (prompts.isCancel(description)) throw new RadianceError("Cancelled.");
    const trimmed = description.trim();

    if (client) {
      try {
        const pack = await generateThemeFromDescription(client, trimmed);
        ui.detail(`Custom theme “${pack.label}” ready`);
        return {
          themePack: "custom",
          themeDescription: trimmed,
          customTheme: pack,
          options: { "theme.pack": "custom" },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Theme generation failed";
        ui.warn(`${message}; falling back to a built-in pack.`);
      }
    } else {
      ui.warn(
        "No LLM configured — mapping your description to a built-in pack.",
      );
    }

    const guess = mapVibeToBuiltin(trimmed);
    ui.detail(`${guess.reason} → ${guess.pack}`);
    return {
      themePack: guess.pack,
      themeDescription: trimmed,
      options: { "theme.pack": guess.pack },
    };
  }

  const primary = await prompts.text({
    message: "Primary colour (hex)",
    placeholder: "#2563eb",
    validate: (value) => {
      try {
        assertHex(value ?? "", "primary");
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid hex";
      }
    },
  });
  if (prompts.isCancel(primary)) throw new RadianceError("Cancelled.");

  const background = await prompts.text({
    message: "Background colour (hex, optional)",
    placeholder: "leave blank to derive",
  });
  if (prompts.isCancel(background)) throw new RadianceError("Cancelled.");

  const accent = await prompts.text({
    message: "Accent colour (hex, optional)",
    placeholder: "leave blank to use primary",
  });
  if (prompts.isCancel(accent)) throw new RadianceError("Cancelled.");

  const seed = {
    primary: primary.trim(),
    ...(background.trim() ? { background: background.trim() } : {}),
    ...(accent.trim() ? { accent: accent.trim() } : {}),
  };
  const pack = expandThemeFromHex(seed);
  return {
    themePack: "custom",
    themeColors: seed,
    customTheme: pack,
    options: { "theme.pack": "custom" },
  };
}

async function askLocaleStep(
  llmAvailable: boolean,
): Promise<Partial<InitPlan>> {
  const selected = await prompts.multiselect({
    message: "Which locales should the app support?",
    options: [
      ...COMMON_LOCALES.map((code) => ({
        value: code,
        label: code,
      })),
      { value: "__other__", label: "Other…", hint: "type a BCP-47 code" },
    ],
    required: true,
    initialValues: ["en"],
  });
  if (prompts.isCancel(selected)) throw new RadianceError("Cancelled.");

  const locales = new Set<string>();
  for (const value of selected as string[]) {
    if (value === "__other__") {
      const other = await prompts.text({
        message: "Additional locale code",
        placeholder: "nb",
        validate: (v) => (v?.trim() ? undefined : "Enter a locale code"),
      });
      if (prompts.isCancel(other)) throw new RadianceError("Cancelled.");
      locales.add(other.trim().toLowerCase());
      continue;
    }
    locales.add(value);
  }

  if (locales.size === 0) locales.add("en");
  const list = [...locales];

  const defaultLocale = await prompts.select({
    message: "Default locale",
    options: list.map((code) => ({ value: code, label: code })),
    initialValue: list.includes("en") ? "en" : list[0],
  });
  if (prompts.isCancel(defaultLocale)) throw new RadianceError("Cancelled.");

  let translateLocales = false;
  if (list.length > 1 && llmAvailable) {
    const translate = await prompts.confirm({
      message:
        "After building the app, sweep UI strings into locales and translate with the LLM?",
      initialValue: true,
    });
    if (prompts.isCancel(translate)) throw new RadianceError("Cancelled.");
    translateLocales = Boolean(translate);
  }

  return {
    locales: list,
    locale: defaultLocale as string,
    translateLocales,
  };
}

async function askSlot(
  slot: SlotId,
  plan: InitPlan,
  registry: Registry,
  catalog: OptionCatalog,
  globalDefaultPm: PackageManager | undefined,
  client: LlmClient | undefined,
): Promise<Partial<InitPlan>> {
  ui.detail(describePlan(plan) || "Nothing set yet");

  switch (slot) {
    case "name": {
      const answer = await prompts.text({
        message: "App name (directory to create)",
        placeholder: "my-app",
        validate: (value) => {
          const trimmed = value?.trim();
          if (!trimmed) return "Enter a name for the app directory";
          if (trimmed === "." || trimmed === "..")
            return "Pick a directory name, not `.` or `..`";
          return undefined;
        },
      });
      if (prompts.isCancel(answer)) throw new RadianceError("Cancelled.");
      return { name: answer.trim() };
    }

    case "starterId": {
      const choice = await prompts.select({
        message: "What are you building?",
        options: [
          ...registry.starters.map((starter) => ({
            value: starter.id,
            label: starter.title,
            hint: starter.description,
          })),
          {
            value: "__scaffold__",
            label: "Bare scaffold",
            hint: "Tooling only, no domain screens",
          },
        ],
      });
      if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
      return {
        starterId: choice === "__scaffold__" ? null : (choice as string),
      };
    }

    case "themePack": {
      return askThemeStep(plan, registry, client);
    }

    case "locale": {
      return askLocaleStep(Boolean(client));
    }

    case "packageManager": {
      const installed = await detectInstalled();
      const available = PACKAGE_MANAGERS.filter((pm) => installed[pm]);
      if (available.length === 0) {
        throw new RadianceError(
          "No Node package manager found",
          `Install one of: ${PACKAGE_MANAGERS.join(", ")}.`,
        );
      }
      const initial =
        (globalDefaultPm && installed[globalDefaultPm]
          ? globalDefaultPm
          : undefined) ??
        (await resolvePackageManager({ global: globalDefaultPm, installed }));

      const choice = await prompts.select({
        message: "Package manager",
        options: available.map((pm) => ({
          value: pm,
          label: pm,
          hint: installed[pm],
        })),
        initialValue: initial,
      });
      if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
      return { packageManager: choice as PackageManager };
    }

    case "firebase":
    case "bundleId":
      return {};

    default: {
      const def = catalog[slot];
      if (!def) {
        throw new RadianceError(`No catalogue definition for option "${slot}"`);
      }

      if (def.type === "multi") {
        const choice = await prompts.multiselect({
          message: def.description ?? slot,
          options: def.choices.map((value) => ({ value, label: value })),
          required: def.min > 0,
          initialValues: Array.isArray(def.default)
            ? def.default
            : def.default
              ? [def.default]
              : [],
        });
        if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
        return { options: { [slot]: choice as string[] } };
      }

      const choice = await prompts.select({
        message: def.description ?? slot,
        options: def.choices.map((value) => ({ value, label: value })),
        initialValue: Array.isArray(def.default) ? def.default[0] : def.default,
      });
      if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
      return { options: { [slot]: choice as string } };
    }
  }
}

function tryCreateClient(
  config: GlobalConfig,
  flags: InitInterviewFlags,
): LlmClient | undefined {
  try {
    const overrides: Partial<GlobalConfig> = {};
    if (flags.provider) {
      if (
        !["ollama", "openai", "anthropic", "cursor"].includes(flags.provider)
      ) {
        throw new RadianceError(
          `Unknown provider "${flags.provider}"`,
          "Choose ollama, openai, anthropic or cursor.",
        );
      }
      overrides.provider = flags.provider as GlobalConfig["provider"];
    }
    if (flags.model) overrides.model = flags.model;
    return createClient(config, overrides);
  } catch (error) {
    if (
      error instanceof RadianceError &&
      error.message.startsWith("Unknown provider")
    ) {
      throw error;
    }
    ui.warn(
      error instanceof Error
        ? `LLM unavailable (${error.message}); continuing with heuristics + prompts.`
        : "LLM unavailable; continuing with heuristics + prompts.",
    );
    return undefined;
  }
}

/**
 * Extract → delta → ask until the InitPlan is complete (or `-y` autofills).
 */
export async function runInitInterview(args: {
  nameArg?: string;
  flags: InitInterviewFlags;
  source: TemplateSource;
  config: GlobalConfig;
  /** When true, skip the opening free-text description (caller already has `--prompt` or flags). */
  skipOpeningPrompt?: boolean;
}): Promise<InitInterviewResult> {
  const { flags, source, config } = args;
  const registry = source.registry;
  const catalog = await loadOptionCatalog(source);
  const locked = lockedSlotsFromFlags({
    ...flags,
    name: args.nameArg ?? flags.name,
  });

  let plan = applyFlagOverrides(
    emptyPlan(),
    { ...flags, name: args.nameArg ?? flags.name },
    registry,
  );
  plan = sanitizePlanOptions(plan, catalog);

  const client =
    flags.yes && !flags.prompt ? undefined : tryCreateClient(config, flags);
  let usedLlm = false;

  let opening = flags.prompt?.trim();

  if (
    !opening &&
    !flags.yes &&
    !args.skipOpeningPrompt &&
    plan.starterId === undefined
  ) {
    const answer = await prompts.text({
      message:
        "Describe what you are building (leave blank to browse starters)",
      placeholder: "an online store with Stripe and Google sign-in",
    });
    if (prompts.isCancel(answer)) throw new RadianceError("Cancelled.");
    opening = answer.trim() || undefined;
  }

  if (opening) {
    const extracted = await extractFromUtterance(
      opening,
      plan,
      registry,
      catalog,
      client,
    );
    usedLlm = usedLlm || extracted.usedLlm;
    plan = mergePlanUpdates(
      plan,
      { ...extracted.updates, openingPrompt: opening },
      locked,
    );
    plan = sanitizePlanOptions(plan, catalog);
    if (extracted.updates.rationale) {
      ui.step(extracted.updates.rationale);
    }
    // Starter may already be known — compute prompt↔template delta immediately.
    if (plan.starterId !== undefined) {
      plan = applyPromptDelta(
        plan,
        computePromptDelta(opening, plan, registry),
      );
    }
  }

  // Prefer a configured default over inventing one; still ask when unset.
  if (
    !plan.packageManager &&
    config.packageManager &&
    !locked.has("packageManager")
  ) {
    plan = { ...plan, packageManager: config.packageManager };
  }

  // Normalise locale list when only a single default was seeded from flags.
  if (plan.locale && !plan.locales?.length && !locked.has("locale")) {
    plan = { ...plan, locales: [plan.locale] };
  }

  if (flags.yes) {
    try {
      const defaultPm =
        config.packageManager ??
        (await resolvePackageManager({ global: config.packageManager }));
      plan = applyDefaultsForYes(plan, registry, catalog, defaultPm);
      if (plan.openingPrompt || opening) {
        plan = applyPromptDelta(
          plan,
          computePromptDelta(
            plan.openingPrompt ?? opening ?? "",
            plan,
            registry,
          ),
        );
      }
    } catch (error) {
      if (error instanceof RadianceError) throw error;
      throw new RadianceError(
        error instanceof Error
          ? error.message
          : "Could not finish the init plan",
        'Pass a directory name: `radiance init my-app --prompt "..." -y`.',
      );
    }
    plan = sanitizePlanOptions(plan, catalog, { strict: true });
    const complete = isPlanComplete(plan, registry);
    if (!complete.ok) {
      throw new RadianceError(
        `Init plan still incomplete: ${complete.missing.join(", ")}`,
        "Pass the missing values as flags, or omit `-y` to be interviewed.",
      );
    }
    return { plan, usedLlm };
  }

  // Manual browse path inside interview (should be rare — init.ts usually handles blank).
  if (!opening && plan.starterId === undefined) {
    const starterUpdate = await askSlot(
      "starterId",
      plan,
      registry,
      catalog,
      config.packageManager,
      client,
    );
    plan = applyInterviewAnswer(plan, starterUpdate, locked);
  }

  const safetyBudget = () => missingSlots(plan, registry).length + 4;
  let turns = 0;
  let maxTurns = safetyBudget();

  while (!isPlanComplete(plan, registry).ok) {
    if (turns >= maxTurns) {
      throw new RadianceError(
        "Init interview exceeded the turn limit",
        `Still missing: ${missingSlots(plan, registry).join(", ")}.`,
      );
    }

    const missing = missingSlots(plan, registry);
    const nextSlot = missing[0]!;
    turns += 1;
    maxTurns = Math.max(maxTurns, safetyBudget());

    const answer = await askSlot(
      nextSlot,
      plan,
      registry,
      catalog,
      config.packageManager,
      client,
    );
    plan = applyInterviewAnswer(plan, answer, locked);
    plan = sanitizePlanOptions(plan, catalog);

    // Recompute delta whenever the starter becomes known or changes.
    if (nextSlot === "starterId" && plan.openingPrompt) {
      plan = applyPromptDelta(
        plan,
        computePromptDelta(plan.openingPrompt, plan, registry),
      );
    }
  }

  // Final delta pass once the plan is complete.
  if (plan.openingPrompt) {
    plan = applyPromptDelta(
      plan,
      computePromptDelta(plan.openingPrompt, plan, registry),
    );
  }

  ui.blank();
  ui.heading("Init plan");
  for (const line of formatPlanSummary(plan)) {
    ui.detail(line);
  }
  if (plan.promptGaps?.length) {
    ui.blank();
    ui.detail("Still to build after the template:");
    for (const gap of plan.promptGaps) ui.detail(`  • ${gap}`);
  }
  if (plan.suggestedPlan === "paid") {
    ui.warn(
      "This app likely needs the paid plan (cloud Storage / Functions). Choose paid when linking Firebase.",
    );
  }
  if (plan.rationale) ui.detail(plan.rationale);

  const proceed = await prompts.confirm({
    message: `Create ${plan.name}?`,
    initialValue: true,
  });
  if (prompts.isCancel(proceed) || !proceed) {
    throw new RadianceError("Cancelled.");
  }

  return { plan, usedLlm };
}
