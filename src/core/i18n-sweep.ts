import fg from "fast-glob";
import { z } from "zod";

import { deepMerge } from "./apply/merge.js";
import type { Workspace } from "./apply/workspace.js";
import { RadianceError, ui } from "./logger.js";
import { extractJson, type LlmClient } from "../harness/llm.js";
import { buildI18nSweepPrompt, CONSTITUTION } from "../harness/prompts.js";
import { readSnippets, renderSnippets } from "../harness/context.js";

const EN_PATH = "locales/en.json";

const SweepSchema = z.object({
  en: z.record(z.string(), z.unknown()),
  edits: z
    .array(
      z.object({
        path: z.string().min(1),
        contents: z.string(),
      }),
    )
    .default([]),
  summary: z.string().optional(),
});

const UI_GLOBS = ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"];
const IGNORED = [
  "**/node_modules/**",
  "**/.expo/**",
  "**/dist/**",
  "**/build/**",
];

/** Strings that look like user-facing JSX copy (heuristic for which files to send the model). */
const HARDCODED_HINT =
  />\s*[A-Z][^<{]{2,}|["'`][A-Z][^"'`]{3,}["'`]\s*(?:\}|,|\))|title:\s*['"][A-Z]|placeholder=\{?['"][A-Z]/;

/**
 * Ask the LLM to put every user-facing string into locales/en.json and wire components
 * through `t()`. Runs after feature generation and before translating other locales.
 */
export async function sweepI18nCatalogue(
  workspace: Workspace,
  client: LlmClient,
  root: string,
): Promise<{ keysAdded: number; filesEdited: number }> {
  const enRaw = await workspace.read(EN_PATH);
  if (!enRaw) {
    throw new RadianceError(
      "locales/en.json missing",
      "Cannot sweep i18n without an English catalogue.",
    );
  }

  let existingEn: Record<string, unknown>;
  try {
    existingEn = JSON.parse(enRaw) as Record<string, unknown>;
  } catch {
    throw new RadianceError("locales/en.json is not valid JSON");
  }

  const candidates = await fg(UI_GLOBS, {
    cwd: root,
    onlyFiles: true,
    ignore: IGNORED,
  });

  const suspicious: string[] = [];
  for (const path of candidates.sort()) {
    const contents = await workspace.read(path);
    if (!contents) continue;
    if (HARDCODED_HINT.test(contents) || !contents.includes("useTranslation")) {
      // Prefer screens / feature components; skip tiny pure style wrappers without text.
      if (contents.length < 80) continue;
      suspicious.push(path);
    }
  }

  // Always include a reasonable set of UI files even if the heuristic is quiet.
  const focus = [
    ...new Set([
      ...suspicious,
      ...candidates.filter((p) => p.startsWith("app/")),
    ]),
  ]
    .sort()
    .slice(0, 24);

  const snippets = await readSnippets(root, focus);
  // Prefer workspace overlay contents when present (post-follow-up edits may be staged).
  for (const snippet of snippets) {
    const staged = await workspace.read(snippet.path);
    if (staged !== null) {
      snippet.contents = staged.slice(0, 8000);
      snippet.truncated = staged.length > 8000;
    }
  }

  ui.detail(`Reviewing ${snippets.length} UI file(s) for missing i18n keys…`);

  const raw = await client.complete(
    [
      { role: "system", content: CONSTITUTION },
      {
        role: "user",
        content: buildI18nSweepPrompt({
          enJson: existingEn,
          fileTree: focus.join("\n"),
          snippets: renderSnippets(snippets),
        }),
      },
    ],
    { json: true, temperature: 0.1, maxTokens: 16_000 },
  );

  const parsed = SweepSchema.parse(stripNulls(extractJson(raw)));
  const mergedEn = deepMerge(existingEn, parsed.en as Record<string, unknown>);
  const beforeKeys = countLeafStrings(existingEn);
  const afterKeys = countLeafStrings(mergedEn);
  const keysAdded = Math.max(0, afterKeys - beforeKeys);

  await workspace.write(
    EN_PATH,
    `${JSON.stringify(mergedEn, null, 2)}\n`,
    "i18n:sweep",
  );

  const allowed = new Set(focus);
  let filesEdited = 0;
  for (const edit of parsed.edits) {
    const path = edit.path.replace(/^\.\//, "");
    if (!allowed.has(path)) {
      ui.detail(`Skipping i18n edit outside review set: ${path}`);
      continue;
    }
    if (!edit.contents.trim()) continue;
    await workspace.write(
      path,
      ensureTrailingNewline(edit.contents),
      "i18n:sweep",
    );
    filesEdited += 1;
  }

  if (parsed.summary) ui.detail(parsed.summary);
  return { keysAdded, filesEdited };
}

/** Ensure non-English locale files have every key from en.json (English placeholders). */
export async function syncLocaleKeysFromEnglish(
  workspace: Workspace,
  locales: string[],
): Promise<void> {
  const enRaw = await workspace.read(EN_PATH);
  if (!enRaw) return;

  let enJson: Record<string, unknown>;
  try {
    enJson = JSON.parse(enRaw) as Record<string, unknown>;
  } catch {
    return;
  }

  for (const code of locales) {
    if (code === "en") continue;
    const path = `locales/${code}.json`;
    const existingRaw = await workspace.read(path);
    let existing: Record<string, unknown> = {};
    if (existingRaw) {
      try {
        existing = JSON.parse(existingRaw) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    // Incoming English fills gaps only — keep any already-translated values.
    const { merged } = mergePreferExisting(existing, enJson);
    await workspace.write(
      path,
      `${JSON.stringify(merged, null, 2)}\n`,
      "i18n:sync",
    );
  }
}

function mergePreferExisting(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { merged: Record<string, unknown> } {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    const current = merged[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      merged[key] = mergePreferExisting(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      ).merged;
    } else if (current === undefined) {
      merged[key] = value;
    }
  }
  return { merged };
}

function countLeafStrings(value: unknown): number {
  if (typeof value === "string") return 1;
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (sum, child) => sum + countLeafStrings(child),
    0,
  );
}

function ensureTrailingNewline(contents: string): string {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

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
