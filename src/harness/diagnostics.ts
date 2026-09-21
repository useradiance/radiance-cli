import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";

import { RadianceError, ui } from "../core/logger.js";
import { RUNS_DIR } from "../core/paths.js";
import { previewModelOutput, type LlmClient } from "./llm.js";

export type HarnessStage = "plan" | "edit" | "repair" | "verify" | "prompt";

export type HarnessFailureDump = {
  at: string;
  stage: HarnessStage;
  provider?: string;
  model?: string;
  request?: string;
  path?: string;
  error: string;
  hint?: string;
  /** Raw model output — the usual smoking gun for malformed JSON. */
  raw?: string;
};

/** Verbose harness tracing when `RADIANCE_DEBUG=1` (or any non-empty value). */
export function isHarnessDebug(): boolean {
  return Boolean(process.env.RADIANCE_DEBUG);
}

export function harnessDebug(message: string): void {
  if (!isHarnessDebug()) return;
  console.error(pc.dim(`[radiance] ${message}`));
}

/** Pretty-print a multi-line RadianceError hint (or any diagnostic block). */
export function printHint(hint: string | undefined): void {
  if (!hint) return;
  for (const line of hint.split("\n")) {
    ui.detail(line);
  }
}

export function withDumpHint(
  error: RadianceError,
  dumpPath: string,
): RadianceError {
  const line = `Diagnostics saved to ${dumpPath}`;
  return new RadianceError(
    error.message,
    error.hint ? `${error.hint}\n${line}` : line,
  );
}

/** Writes a failure record under `.radiance/runs/` and returns the project-relative path. */
export async function writeHarnessFailure(
  root: string,
  dump: Omit<HarnessFailureDump, "at">,
): Promise<string> {
  const dir = join(root, RUNS_DIR);
  await mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relative = join(RUNS_DIR, `${stamp}-failure.json`);
  const record: HarnessFailureDump = { at: new Date().toISOString(), ...dump };

  await writeFile(
    join(root, relative),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  harnessDebug(
    `wrote failure dump ${relative} (${dump.raw?.length ?? 0} chars of raw output)`,
  );
  return relative;
}

/**
 * Wraps an LLM client so each call logs timing and a response preview under RADIANCE_DEBUG.
 * Always-on for prompt failures via writeHarnessFailure; this is the live trace.
 */
export function withHarnessLogging(client: LlmClient): LlmClient {
  if (!isHarnessDebug()) return client;

  return {
    provider: client.provider,
    model: client.model,
    async complete(messages, options) {
      const chars = messages.reduce(
        (sum, message) => sum + message.content.length,
        0,
      );
      harnessDebug(
        `${client.provider}/${client.model} → ${messages.length} msg(s), ~${chars} chars` +
          `${options?.json ? ", json" : ""}`,
      );

      const started = Date.now();
      try {
        const raw = await client.complete(messages, options);
        harnessDebug(`← ${raw.length} chars in ${Date.now() - started}ms`);
        harnessDebug(previewModelOutput(raw, 500));
        return raw;
      } catch (error) {
        harnessDebug(
          `LLM call failed after ${Date.now() - started}ms: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        throw error;
      }
    },
  };
}
