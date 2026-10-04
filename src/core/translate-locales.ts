import type { Workspace } from "./apply/workspace.js";
import { RadianceError, ui } from "./logger.js";
import { extractJson, type LlmClient } from "../harness/llm.js";
import { recordCount, timed } from "./timings.js";
import {
  loadTranslationMemory,
  resolveTranslationMemoryDir,
  saveTranslationMemory,
  sourceHash,
} from "./translation-memory.js";

/**
 * Translate every non-English catalogue from `locales/en.json`.
 *
 * This used to send the whole English catalogue in one call per locale and ask
 * for the whole translated catalogue back. That is bound by output tokens —
 * about seventy seconds a locale, one locale after another — and a large
 * catalogue could simply be cut off at the token limit. Now:
 *
 * - the English strings are taken out of the catalogue one by one, and the
 *   output is rebuilt from the English shape, so every locale file has exactly
 *   English's keys in English's order whatever the model does;
 * - strings already translated before (the translation memory) cost nothing;
 * - the rest go out in small batches that run concurrently, across locales
 *   too, so a run takes about as long as its slowest few batches;
 * - every translation is checked, and one that drops a `{{placeholder}}` is
 *   left in English rather than shipped broken.
 */

export type TranslateLocalesOptions = {
  /** Translation memory directory; see `resolveTranslationMemoryDir`. */
  memoryDir?: string;
  /** Batches in flight at once, across all locales. */
  concurrency?: number;
};

export type LocaleTranslationStats = {
  locale: string;
  /** Non-blank English strings in the catalogue. */
  strings: number;
  fromMemory: number;
  /** Translated by the model in this run. */
  translated: number;
  /** Left in English: the model failed or its answer did not check out. */
  fellBack: number;
};

/** Upper bounds for one batch: strings, and characters of English source. */
export const MAX_BATCH_STRINGS = 60;
export const MAX_BATCH_CHARS = 6000;

export const TRANSLATE_CONCURRENCY_ENV = "RADIANCE_TRANSLATE_CONCURRENCY";
const DEFAULT_CONCURRENCY = 4;

/** Translate cloned locale files from English using the LLM. */
export async function translateLocaleFiles(
  workspace: Workspace,
  locales: string[],
  client: LlmClient,
  options: TranslateLocalesOptions = {},
): Promise<LocaleTranslationStats[]> {
  const targets = [...new Set(locales)].filter((code) => code !== "en");
  if (targets.length === 0) return [];

  const enRaw = await workspace.read("locales/en.json");
  if (!enRaw) {
    ui.warn("Skipping locale translation — locales/en.json missing");
    return [];
  }

  let enJson: unknown;
  try {
    enJson = JSON.parse(enRaw);
  } catch {
    ui.warn("Skipping locale translation — locales/en.json is not valid JSON");
    return [];
  }

  const memoryDir = resolveTranslationMemoryDir(options.memoryDir);
  const limit = createLimiter(resolveConcurrency(options.concurrency));

  ui.detail(
    `Translating ${targets.map((code) => `locales/${code}.json`).join(", ")}…`,
  );

  const results = await Promise.all(
    targets.map((locale) =>
      timed(locale, () =>
        translateLocale(workspace, enJson, locale, client, memoryDir, limit),
      ).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Translation failed";
        ui.warn(`Could not translate ${locale}: ${message}`);
        if (error instanceof RadianceError && error.hint) {
          ui.detail(error.hint);
        }
        return null;
      }),
    ),
  );

  return results.filter(
    (stats): stats is LocaleTranslationStats => stats !== null,
  );
}

async function translateLocale(
  workspace: Workspace,
  enJson: unknown,
  locale: string,
  client: LlmClient,
  memoryDir: string,
  limit: Limiter,
): Promise<LocaleTranslationStats> {
  const memory = await loadTranslationMemory(memoryDir, locale);

  /** English source → the text to write for it, once known. */
  const resolved = new Map<string, string>();
  const stats: LocaleTranslationStats = {
    locale,
    strings: 0,
    fromMemory: 0,
    translated: 0,
    fellBack: 0,
  };

  // Counted per occurrence, sent per distinct string: "Save" under three keys
  // is one string for the model and three for the stats.
  const occurrences = new Map<string, number>();
  for (const source of stringLeaves(enJson)) {
    // Nothing to translate in a blank string; it is copied as it is.
    if (!source.trim()) continue;
    stats.strings += 1;
    occurrences.set(source, (occurrences.get(source) ?? 0) + 1);
  }

  const misses: string[] = [];
  for (const [source, count] of occurrences) {
    // A remembered translation is checked like a fresh one, so a bad entry
    // (a hand-edited file, an older validator) is translated again, not reused.
    const remembered = acceptTranslation(
      source,
      memory.entries[sourceHash(source)],
    );
    if (remembered !== null) {
      resolved.set(source, remembered);
      stats.fromMemory += count;
    } else {
      misses.push(source);
    }
  }

  const batches = batchSources(misses);
  const answers = await Promise.all(
    batches.map((batch) => limit(() => translateBatch(client, locale, batch))),
  );

  /*
   * Only this run's new translations are saved. The save merges them over
   * what is on disk then, so entries another process added since this one
   * loaded the memory survive, and none of them is overwritten by the copy
   * loaded at the start.
   */
  const learned: Record<string, string> = {};
  batches.forEach((batch, index) => {
    const translations = answers[index] ?? [];
    batch.forEach((source, position) => {
      const count = occurrences.get(source) ?? 1;
      const translation = translations[position] ?? null;
      if (translation === null) {
        stats.fellBack += count;
        return;
      }
      resolved.set(source, translation);
      learned[sourceHash(source)] = translation;
      stats.translated += count;
    });
  });

  const output = mapStringLeaves(
    enJson,
    (source) => resolved.get(source) ?? source,
  );
  await workspace.write(
    `locales/${locale}.json`,
    `${JSON.stringify(output, null, 2)}\n`,
    "i18n:translate",
  );

  if (Object.keys(learned).length > 0) {
    try {
      await saveTranslationMemory(memoryDir, locale, {
        version: 1,
        entries: learned,
      });
    } catch (error) {
      ui.warn(
        `Could not save the translation memory for ${locale}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  ui.detail(
    `${locale}: ${stats.strings} string(s) — ${stats.fromMemory} from memory, ` +
      `${stats.translated} translated, ${stats.fellBack} kept in English`,
  );
  recordCount("translate.strings", stats.strings);
  recordCount("translate.fromMemory", stats.fromMemory);
  recordCount("translate.translated", stats.translated);
  recordCount("translate.fellBack", stats.fellBack);

  return stats;
}

/**
 * Ask for one batch, retrying once when the call fails or the reply is not
 * JSON. Returns one entry per source: the checked translation, or `null` to
 * keep the English.
 */
async function translateBatch(
  client: LlmClient,
  locale: string,
  sources: string[],
): Promise<(string | null)[]> {
  const payload = Object.fromEntries(
    sources.map((source, index) => [String(index), source]),
  );
  const messages = [
    {
      role: "system" as const,
      content:
        "You translate the user-facing strings of a mobile app for its i18next catalogue. Reply with JSON only.",
    },
    {
      role: "user" as const,
      content: `Translate each value in this JSON object from English into the locale "${locale}"${languageLabel(locale)}.

Return one JSON object with exactly the same keys ("0", "1", …), each mapped to its translated string. Do not add, drop or merge keys.
Copy these exactly as they appear, untranslated: interpolation placeholders like {{name}}, nesting references like $t(key), and numbered tags like <0>…</0> or <1/>.
Keep it short and natural for app UI, and leave product and brand names as they are.

${JSON.stringify(payload, null, 2)}`,
    },
  ];

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await client.complete(messages, {
        json: true,
        temperature: 0.2,
        maxTokens: 8192,
      });
      const answer = translationsObject(extractJson<unknown>(raw));
      return sources.map((source, index) =>
        acceptTranslation(source, answer[String(index)]),
      );
    } catch (error) {
      lastError = error;
    }
  }

  ui.warn(
    `Could not translate ${sources.length} string(s) into ${locale} (${
      lastError instanceof Error ? lastError.message : "no usable reply"
    }); keeping them in English.`,
  );
  return sources.map(() => null);
}

/**
 * The id → translation object in a reply. Models sometimes wrap the answer
 * (`{ "translations": { "0": … } }`); a lone object value is unwrapped rather
 * than failing a batch whose content is fine.
 */
function translationsObject(parsed: unknown): Record<string, unknown> {
  if (!isPlainObject(parsed)) {
    throw new RadianceError("The model did not return a JSON object");
  }
  if (!("0" in parsed)) {
    const values = Object.values(parsed);
    if (values.length === 1 && isPlainObject(values[0])) return values[0];
  }
  return parsed;
}

/**
 * A translation worth writing, or `null` to keep the English.
 *
 * It must be a non-empty string that carries the same i18next machinery as
 * the English: a translation without its `{{count}}` renders a sentence with a
 * hole in it, and a lost `<0>` tag breaks the `Trans` component that renders
 * it — both worse than an untranslated string.
 */
export function acceptTranslation(
  source: string,
  candidate: unknown,
): string | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const expected = placeholderSignature(source);
  const actual = placeholderSignature(candidate);
  if (expected.length !== actual.length) return null;
  return expected.every((token, index) => token === actual[index])
    ? candidate
    : null;
}

const PLACEHOLDER =
  /\{\{[^{}]*\}\}|\$t\([^()]*(?:\([^()]*\)[^()]*)*\)|<\/?\d+\s*\/?>/g;

/**
 * The multiset of interpolations, nesting references and numbered tags in a
 * string, sorted. Whitespace is dropped because i18next trims it —
 * `{{ name }}` and `{{name}}` are the same placeholder.
 */
function placeholderSignature(text: string): string[] {
  return (text.match(PLACEHOLDER) ?? [])
    .map((token) => token.replace(/\s+/g, ""))
    .sort();
}

/** Split distinct sources into batches within the string and character limits. */
function batchSources(sources: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const source of sources) {
    const full =
      current.length >= MAX_BATCH_STRINGS ||
      chars + source.length > MAX_BATCH_CHARS;
    if (current.length > 0 && full) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(source);
    chars += source.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** Every string leaf of a JSON value, in document order. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (isPlainObject(value)) return Object.values(value).flatMap(stringLeaves);
  return [];
}

/**
 * A copy of `value` with every string leaf replaced by `fn(leaf)`: the same
 * keys in the same order, arrays kept as arrays, numbers, booleans and nulls
 * copied. `Object.fromEntries` rather than assignment, so even a `__proto__`
 * key comes out as a key.
 */
function mapStringLeaves(
  value: unknown,
  fn: (source: string) => string,
): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value))
    return value.map((item) => mapStringLeaves(item, fn));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        mapStringLeaves(child, fn),
      ]),
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** ` (French)` for `fr`, so the model is told the language as well as the code. */
function languageLabel(locale: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(locale);
    return name && name !== locale ? ` (${name})` : "";
  } catch {
    return "";
  }
}

function resolveConcurrency(explicit?: number): number {
  const candidates = [explicit, Number(process.env[TRANSLATE_CONCURRENCY_ENV])];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
      return value;
    }
  }
  return DEFAULT_CONCURRENCY;
}

type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * At most `max` tasks running at once. A finishing task hands its slot
 * straight to the next queued one, so a task that arrives in between cannot
 * slip in and push the count over the limit.
 */
function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
