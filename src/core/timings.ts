import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Where a run spends its time, for a caller that drives the CLI headlessly.
 *
 * The hosted service runs `init`, `prompt` and `translate` back to back, and a
 * project with a description took minutes without anyone being able to say
 * which of them — or which LLM call inside them — was slow. The terminal
 * spinners say nothing once stdout is a pipe, and the step log has no
 * durations. So, when `RADIANCE_TIMINGS_FILE` names a file, every `timed()`
 * step, every LLM call and a few counters are written there as JSON when the
 * process exits.
 *
 * Without the variable all of this is inert: `timed()` just calls through,
 * nothing is collected and no exit hook is installed. Only names, durations,
 * sizes and token counts are recorded — never argv, prompt text, keys or file
 * contents, because the file is read by another service.
 */

export const TIMINGS_FILE_ENV = "RADIANCE_TIMINGS_FILE";

export type TimedStep = {
  /** Nesting path, e.g. `prompt/verify/typecheck`. */
  name: string;
  /** Milliseconds from when timings started (module load) to the step's start. */
  startMs: number;
  /** For a step still running at exit: how long it had run by then. */
  ms: number;
  /** `false` when the step threw, or had not finished when the process exited. */
  ok: boolean;
};

export type LlmCallTiming = {
  /** The `timed()` path the call was made from, or `-` outside any step. */
  step: string;
  provider: string;
  model: string;
  ms: number;
  promptChars: number;
  replyChars: number;
  /** What the caller asked for; `null` when it left the provider default. */
  maxTokens: number | null;
  json: boolean;
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
};

export type TimingsReport = {
  version: 1;
  command: string | null;
  totalMs: number;
  steps: TimedStep[];
  llm: LlmCallTiming[];
  counts: Record<string, number>;
};

/** Token usage a provider client reports for the call it is serving. */
export type LlmUsage = { inputTokens?: number; outputTokens?: number };

const origin = performance.now();

/*
 * The current step path travels with the async context rather than a module
 * variable: batches of translation and parallel repairs run concurrently, and
 * each has to be attributed to the step that started it, not to whichever
 * step happened to start last.
 */
const stepPath = new AsyncLocalStorage<string>();

/*
 * The same reasoning for usage. A provider learns its token counts deep inside
 * `complete()`; a "last usage" global would hand one call's counts to another
 * call running beside it. Each wrapped call opens its own sink instead.
 */
const usageSink = new AsyncLocalStorage<LlmUsage>();

/*
 * A step is recorded when it starts, not when it ends, so the list is in
 * start order (parents before children) without sorting on rounded times,
 * and a step still running when the process exits — `process.exit` from a
 * cancelled prompt, say — is reported as unfinished rather than dropped.
 */
type OpenStep = { step: TimedStep; started: number; done: boolean };

let command: string | null = null;
let steps: OpenStep[] = [];
let llmCalls: LlmCallTiming[] = [];
let counts: Record<string, number> = {};
let exitHookFor: string | null = null;

function timingsFile(): string | undefined {
  const value = process.env[TIMINGS_FILE_ENV]?.trim();
  return value ? value : undefined;
}

export function timingsEnabled(): boolean {
  return timingsFile() !== undefined;
}

function elapsed(from: number): number {
  return Math.round(performance.now() - from);
}

/*
 * Installed on the first thing recorded, not at import: a run without the
 * variable should not grow an exit listener. `exit` rather than commander's
 * `postAction`, because `postAction` does not run when the command throws —
 * and a failed run is exactly the one whose timings matter. The path is
 * resolved now, since `init` changes directory to run its follow-up.
 */
function ensureExitHook(): void {
  const file = timingsFile();
  if (!file || exitHookFor !== null) return;
  exitHookFor = resolve(file);
  const target = exitHookFor;
  process.once("exit", () => writeTimingsFile(target));
}

/** Name of the command being timed; set once from the CLI's `preAction` hook. */
export function setTimingsCommand(name: string): void {
  if (!timingsEnabled()) return;
  command = name;
  ensureExitHook();
}

/** The step path an LLM call made right now would be attributed to. */
export function currentTimingStep(): string {
  return stepPath.getStore() ?? "-";
}

/**
 * Run `fn` as a named step. Inside another step the name is joined onto its
 * path with `/`. Errors are recorded as `ok: false` and rethrown unchanged.
 */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!timingsEnabled()) return fn();

  ensureExitHook();
  const parent = stepPath.getStore();
  const path = parent ? `${parent}/${name}` : name;
  const started = performance.now();
  const entry: OpenStep = {
    step: {
      name: path,
      startMs: Math.round(started - origin),
      ms: 0,
      ok: false,
    },
    started,
    done: false,
  };
  steps.push(entry);

  try {
    const value = await stepPath.run(path, fn);
    entry.step.ok = true;
    return value;
  } finally {
    entry.step.ms = elapsed(started);
    entry.done = true;
  }
}

/** Add `value` to a named counter (counters are summed across the run). */
export function recordCount(name: string, value: number): void {
  if (!timingsEnabled()) return;
  ensureExitHook();
  counts[name] = (counts[name] ?? 0) + value;
}

export function recordLlmCall(call: LlmCallTiming): void {
  if (!timingsEnabled()) return;
  ensureExitHook();
  llmCalls.push(call);
}

/**
 * Called by a provider client once it knows the token counts of its reply.
 * A no-op outside a call opened with `collectUsage` (e.g. timings are off).
 */
export function reportUsage(usage: LlmUsage): void {
  const sink = usageSink.getStore();
  if (!sink) return;
  if (typeof usage.inputTokens === "number") {
    sink.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    sink.outputTokens = usage.outputTokens;
  }
}

/** Run one LLM call with `sink` receiving whatever it passes to `reportUsage`. */
export function collectUsage<T>(
  sink: LlmUsage,
  fn: () => Promise<T>,
): Promise<T> {
  return usageSink.run(sink, fn);
}

/** Everything recorded so far, in the shape written to the file. */
export function timingsReport(): TimingsReport {
  return {
    version: 1,
    command,
    totalMs: elapsed(origin),
    steps: steps.map(({ step, started, done }) =>
      done ? { ...step } : { ...step, ms: elapsed(started), ok: false },
    ),
    llm: [...llmCalls],
    counts: { ...counts },
  };
}

/** Forget everything recorded. For tests; the CLI records one command per process. */
export function resetTimings(): void {
  command = null;
  steps = [];
  llmCalls = [];
  counts = {};
}

function writeTimingsFile(path: string): void {
  // Checked again at exit, so a test (or caller) that unsets the variable
  // after recording gets nothing written.
  if (!timingsEnabled()) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(timingsReport(), null, 2)}\n`);
  } catch {
    // Timings are diagnostics; failing to write them must not fail the run.
  }
}
