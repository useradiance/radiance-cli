import { createClient } from "../harness/llm.js";
import type { GlobalConfig, ProviderId } from "./config.js";
import {
  changedUiFiles,
  sweepI18nCatalogue,
  syncLocaleKeysFromEnglish,
} from "./i18n-sweep.js";
import { RadianceError, ui } from "./logger.js";
import { timed } from "./timings.js";
import { translateLocaleFiles } from "./translate-locales.js";

/**
 * The i18n sweep and locale translation, shared by `init` and `add`.
 *
 * Lived in `init` while only `init` could produce a multi-locale project. But
 * a module added afterwards brings its own English strings, and translating at
 * the end of `init` left those in English in every other catalogue — so `add`
 * needs the same two steps, and a second copy of them would drift.
 */

/** Which model to use; mirrors the `--provider` / `--model` flags. */
export type LlmChoice = { provider?: string; model?: string; yes?: boolean };

export type SweepOptions = LlmChoice & {
  /**
   * `--since <git-ref>`: review only the UI files changed since this ref, and
   * skip the sweep (and its LLM call) when none did.
   */
  since?: string;
};

export type TranslateOptions = LlmChoice & {
  /** `--translation-memory <dir>`; see `resolveTranslationMemoryDir`. */
  translationMemory?: string;
};

function llmOverrides(options: LlmChoice): {
  provider?: ProviderId;
  model?: string;
} {
  const overrides: { provider?: ProviderId; model?: string } = {};
  if (options.provider) overrides.provider = options.provider as ProviderId;
  if (options.model) overrides.model = options.model;
  return overrides;
}

export async function maybeSweepI18n(
  root: string,
  locales: string[],
  config: GlobalConfig,
  options: SweepOptions,
): Promise<void> {
  await timed("i18n-sweep", () => sweepI18n(root, locales, config, options));
}

async function sweepI18n(
  root: string,
  locales: string[],
  config: GlobalConfig,
  options: SweepOptions,
): Promise<void> {
  const { Workspace } = await import("./apply/workspace.js");
  const { applyChanges } = await import("./apply/writer.js");

  try {
    ui.blank();
    ui.heading("Ensuring all UI strings are in locales");

    // Worked out before a client exists, so a run with nothing to review
    // needs no API key either.
    const onlyPaths = options.since
      ? await sweepScope(root, options.since)
      : undefined;
    if (onlyPaths?.length === 0) {
      ui.info(
        `No UI files changed since ${options.since}; skipping the i18n sweep.`,
      );
      return;
    }

    const client = createClient(config, llmOverrides(options));
    const workspace = new Workspace(root);
    const result = await sweepI18nCatalogue(workspace, client, root, onlyPaths);
    await syncLocaleKeysFromEnglish(workspace, locales);

    const changes = workspace.changes();
    if (changes.length > 0) {
      await applyChanges(root, changes, { confirm: false, dryRun: false });
    }
    ui.success(
      `i18n sweep complete (+${result.keysAdded} keys, ${result.filesEdited} file(s) updated)`,
    );
  } catch (error) {
    ui.warn(
      error instanceof Error
        ? `i18n sweep skipped: ${error.message}`
        : "i18n sweep skipped.",
    );
    if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
  }
}

/**
 * The UI files `--since` narrows the sweep to; `undefined` (sweep everything)
 * when git cannot answer, because a missed string is worse than a slow sweep.
 */
async function sweepScope(
  root: string,
  since: string,
): Promise<string[] | undefined> {
  const changed = await changedUiFiles(root, since);
  if (changed === null) {
    ui.warn(
      `Could not list the files changed since ${since} with git; sweeping every UI file instead.`,
    );
    return undefined;
  }
  if (changed.length > 0) {
    ui.detail(
      `${changed.length} UI file(s) changed since ${since}; reviewing only those.`,
    );
  }
  return changed;
}

export async function maybeTranslateLocales(
  root: string,
  locales: string[],
  config: GlobalConfig,
  options: TranslateOptions,
): Promise<void> {
  const targets = locales.filter((code) => code !== "en");
  if (targets.length === 0) return;

  await timed("translate", () =>
    translateLocales(root, locales, targets, config, options),
  );
}

async function translateLocales(
  root: string,
  locales: string[],
  targets: string[],
  config: GlobalConfig,
  options: TranslateOptions,
): Promise<void> {
  // Build a disk-backed workspace so we read files the follow-up prompt / i18n sweep wrote.
  const { Workspace } = await import("./apply/workspace.js");
  const { applyChanges } = await import("./apply/writer.js");

  try {
    const client = createClient(config, llmOverrides(options));

    ui.blank();
    ui.heading("Translating locale files");

    const workspace = new Workspace(root);
    await translateLocaleFiles(workspace, locales, client, {
      ...(options.translationMemory
        ? { memoryDir: options.translationMemory }
        : {}),
    });

    const changes = workspace.changes();
    if (changes.length > 0) {
      await applyChanges(root, changes, { confirm: false, dryRun: false });
      ui.success(`Translated ${changes.length} locale file(s)`);
    }
  } catch (error) {
    ui.warn(
      error instanceof Error
        ? `Locale translation skipped: ${error.message}`
        : "Locale translation skipped.",
    );
    if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
    ui.detail(`Translate ${targets.join(", ")} later with: radiance translate`);
  }
}
