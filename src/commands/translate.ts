import { loadConfig } from "../core/config.js";
import {
  maybeSweepI18n,
  maybeTranslateLocales,
  type SweepOptions,
  type TranslateOptions,
} from "../core/locale-pipeline.js";
import { bindLogSession, ui } from "../core/logger.js";
import { requireProject } from "../core/project.js";

/**
 * Sweep hard-coded UI copy into `locales/en.json`, then translate every other
 * locale the project has.
 *
 * The same two steps `init --translate-locales` runs at the end, as a command
 * of their own: translation belongs *after* the last code is written, and for
 * a caller that writes code after `init` — a follow-up prompt, added modules —
 * the end of `init` is too early. Everything written later would stay English.
 *
 * `--since <ref>` limits the sweep to the UI files changed since that commit —
 * the caller that runs this after a follow-up prompt knows which commit the
 * prompt started from — and `--translation-memory <dir>` points translation at
 * a memory shared between runs.
 */
export type TranslateCommandOptions = SweepOptions & TranslateOptions;

export async function translateCommand(
  options: TranslateCommandOptions,
): Promise<void> {
  const { root, config: project } = await requireProject();
  bindLogSession(root);

  const locales = project.locales ?? [];
  if (!locales.some((code) => code !== "en")) {
    ui.info(
      "This project has no locale other than English; nothing to translate.",
    );
    return;
  }

  const config = await loadConfig();
  await maybeSweepI18n(root, locales, config, options);
  await maybeTranslateLocales(root, locales, config, options);
}
