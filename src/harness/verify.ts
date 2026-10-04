import { execa } from "execa";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { timed } from "../core/timings.js";

export type VerifyResult = {
  ok: boolean;
  /** True when the check could not run at all (no dependencies installed yet). */
  skipped: boolean;
  reason?: string;
  output: string;
  /** Project-relative paths that produced errors, most errors first. */
  failingFiles: string[];
};

const MAX_OUTPUT_CHARS = 6000;

/**
 * Runs the project's TypeScript compiler.
 *
 * This is the harness's ground truth: a change is not "done" because the model said so, it is
 * done when the project still compiles.
 */
export async function typecheck(root: string): Promise<VerifyResult> {
  if (!existsSync(join(root, "node_modules", "typescript"))) {
    return {
      ok: true,
      skipped: true,
      reason:
        "TypeScript is not installed yet — run a package manager install to enable verification.",
      output: "",
      failingFiles: [],
    };
  }

  // Timed around the compiler alone, so a skipped check records no step.
  const result = await timed("typecheck", () =>
    execa("tsc", ["--noEmit", "--pretty", "false"], {
      cwd: root,
      preferLocal: true,
      localDir: root,
      reject: false,
      timeout: 300_000,
    }),
  );

  const output = `${result.stdout}\n${result.stderr}`.trim();

  return {
    ok: result.exitCode === 0,
    skipped: false,
    output: output.slice(0, MAX_OUTPUT_CHARS),
    failingFiles: parseFailingFiles(output),
  };
}

/** `app/(app)/index.tsx(12,3): error TS2304: Cannot find name 'foo'.` */
export function parseFailingFiles(output: string): string[] {
  const counts = new Map<string, number>();

  for (const line of output.split("\n")) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\): error /);
    const path = match?.[1];
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);
}

/** Errors that mention a specific file, so a repair prompt stays focused. */
export function errorsFor(output: string, path: string): string {
  return output
    .split("\n")
    .filter((line) => line.startsWith(path))
    .join("\n");
}
