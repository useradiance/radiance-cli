import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cacheDir } from "./paths.js";

/**
 * Translations already paid for, keyed by the English they came from.
 *
 * Most of a catalogue is the same from one project to the next — every
 * starter says "Sign in", "Save", "Something went wrong" — and a project that
 * is translated again after a follow-up prompt changes only a handful of
 * strings. Re-translating all of it each time is what made translation take a
 * minute per locale. The memory is shared across projects (it lives in the
 * cache directory unless told otherwise), so the hosted service can keep one
 * warm for every build.
 *
 * One file per locale, `{ "version": 1, "entries": { "<hash>": "<text>" } }`.
 * The key is a hash of the English source rather than the source itself so
 * the file stays compact and keys stay a fixed length; a hash also carries no
 * key path, so the same English under two keys shares one translation.
 */

export const TRANSLATION_MEMORY_ENV = "RADIANCE_TRANSLATION_MEMORY";

export type TranslationMemory = {
  version: 1;
  entries: Record<string, string>;
};

export function emptyTranslationMemory(): TranslationMemory {
  return { version: 1, entries: {} };
}

/** First 32 hex characters of the SHA-256 of the English source string. */
export function sourceHash(englishSource: string): string {
  return createHash("sha256")
    .update(englishSource, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Explicit option, then `RADIANCE_TRANSLATION_MEMORY`, then the cache directory. */
export function resolveTranslationMemoryDir(explicit?: string): string {
  const fromOption = explicit?.trim();
  if (fromOption) return fromOption;
  const fromEnv = process.env[TRANSLATION_MEMORY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return join(cacheDir(), "translation-memory");
}

/*
 * Locale codes come from `radiance.json`, which a project author edits by
 * hand; anything but the characters a BCP 47 tag uses is replaced so a code
 * can never point the file outside the memory directory.
 */
function memoryFile(dir: string, locale: string): string {
  const safe = locale.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
  return join(dir, `${safe}.json`);
}

/** The memory for `locale`, or an empty one when the file is missing or unreadable. */
export async function loadTranslationMemory(
  dir: string,
  locale: string,
): Promise<TranslationMemory> {
  let raw: string;
  try {
    raw = await readFile(memoryFile(dir, locale), "utf8");
  } catch {
    return emptyTranslationMemory();
  }
  return parseMemory(raw);
}

function parseMemory(raw: string): TranslationMemory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyTranslationMemory();
  }

  const memory = emptyTranslationMemory();
  if (!parsed || typeof parsed !== "object") return memory;
  const entries = (parsed as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return memory;
  }

  // Keep only well-formed entries; one bad value should not cost the rest.
  for (const [hash, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.length > 0) {
      memory.entries[hash] = value;
    }
  }
  return memory;
}

/**
 * Write the memory for `locale`, merged with whatever is on disk *now*.
 *
 * Another process may have saved entries since this one loaded — the hosted
 * service translates several projects at once into one memory — so the file
 * is re-read and merged at save time, this run's entries winning on a clash.
 * The write goes to a temporary file that is renamed into place, so a reader
 * never sees half a file.
 */
export async function saveTranslationMemory(
  dir: string,
  locale: string,
  memory: TranslationMemory,
): Promise<void> {
  const file = memoryFile(dir, locale);
  await mkdir(dir, { recursive: true });

  const onDisk = await loadTranslationMemory(dir, locale);
  const merged: TranslationMemory = {
    version: 1,
    entries: { ...onDisk.entries, ...memory.entries },
  };

  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(merged)}\n`, "utf8");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
