import * as prompts from "@clack/prompts";

import { RadianceError, ui } from "../core/logger.js";

export type FollowUpOfferOptions = {
  /** When true, skip the confirm prompt. */
  yes: boolean;
  /**
   * When true with `yes`, auto-run the residual prompt once.
   * Nested callers should omit this (print-only) so chains cannot recurse.
   */
  chain?: boolean;
  heading: string;
  confirmMessage: string;
  run: (followUpPrompt: string) => Promise<void>;
};

/**
 * Surface a residual `radiance prompt` request: preview, then confirm-to-run
 * (or print-only when non-interactive / `-y` without `--follow-up`).
 */
export async function offerFollowUpPrompt(
  followUpPrompt: string,
  options: FollowUpOfferOptions,
): Promise<void> {
  const trimmed = followUpPrompt.trim();
  if (!trimmed) return;

  ui.blank();
  ui.heading(options.heading);
  for (const line of trimmed.split("\n").slice(0, 6)) {
    ui.detail(line);
  }

  if (options.yes && !options.chain) {
    ui.detail(`Later: radiance prompt ${JSON.stringify(trimmed)}`);
    return;
  }

  if (options.yes && options.chain) {
    try {
      await options.run(trimmed);
    } catch (error) {
      ui.warn(
        error instanceof Error
          ? `Follow-up prompt failed: ${error.message}`
          : "Follow-up prompt failed.",
      );
      if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
      ui.detail(`Retry with: radiance prompt ${JSON.stringify(trimmed)}`);
    }
    return;
  }

  const answer = await prompts.confirm({
    message: options.confirmMessage,
    initialValue: true,
  });
  if (prompts.isCancel(answer) || !answer) {
    ui.detail(`Later: radiance prompt ${JSON.stringify(trimmed)}`);
    return;
  }

  try {
    await options.run(trimmed);
  } catch (error) {
    ui.warn(
      error instanceof Error
        ? `Follow-up prompt failed: ${error.message}`
        : "Follow-up prompt failed.",
    );
    if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
    ui.detail(`Retry with: radiance prompt ${JSON.stringify(trimmed)}`);
  }
}
