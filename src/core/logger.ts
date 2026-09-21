import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import pc from "picocolors";

import { globalLogsDir, projectLogsDir } from "./paths.js";

export type LogSession = {
  path: string;
  command: string;
  startedAt: Date;
};

let verbose = false;
let session: LogSession | null = null;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

export function getLogSession(): LogSession | null {
  return session;
}

/** Commands that write a step log (and honor `--verbose` for terminal echo). */
export const MULTI_STEP_COMMANDS = new Set([
  "init",
  "add",
  "remove",
  "prompt",
  "update",
  "upgrade",
  "build",
  "preview",
  "deploy",
  "destroy",
  "setup firebase",
  "compile",
]);

function stampFilename(command: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = command.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9._-]+/g, "");
  return `${stamp}-${safe || "radiance"}.log`;
}

function writeHeader(command: string, argv: string[]): string {
  return [
    `# radiance ${command}`,
    `started: ${new Date().toISOString()}`,
    `cwd: ${process.cwd()}`,
    `argv: ${argv.join(" ") || "(none)"}`,
    `verbose: ${verbose}`,
    "",
  ].join("\n");
}

/**
 * Opens a log file for a multi-step command.
 * Prefers `<project>/.radiance/logs/` when inside a Radiance project; otherwise the global cache.
 */
export function startLogSession(options: {
  command: string;
  argv?: string[];
  projectRoot?: string | null;
}): string {
  if (session) endLogSession({ silent: true });

  const argv = options.argv ?? process.argv.slice(2);
  const root = options.projectRoot ?? null;
  const dir = root ? projectLogsDir(root) : globalLogsDir();
  mkdirSync(dir, { recursive: true });

  const path = join(dir, stampFilename(options.command));
  writeFileSync(path, `${writeHeader(options.command, argv)}\n`, "utf8");
  session = { path, command: options.command, startedAt: new Date() };
  appendRaw(`log file: ${path}`);
  return path;
}

/**
 * Moves the active log into a project directory (used by `init` once the app folder exists).
 */
export function bindLogSession(projectRoot: string): string | null {
  if (!session) return null;

  const dir = projectLogsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const nextPath = join(dir, basename(session.path));

  if (nextPath !== session.path) {
    try {
      copyFileSync(session.path, nextPath);
      appendFileSync(
        nextPath,
        `${new Date().toISOString()}  relocated log from ${session.path}\n`,
        "utf8",
      );
    } catch {
      // Keep writing to the original path if relocate fails.
      appendRaw(`could not relocate log to ${nextPath}`);
      return session.path;
    }
    session = { ...session, path: nextPath };
    appendRaw(`log file: ${nextPath}`);
  }

  return session.path;
}

export function endLogSession(
  options: { silent?: boolean } = {},
): string | null {
  if (!session) return null;

  const elapsedMs = Date.now() - session.startedAt.getTime();
  appendRaw(`finished: ${new Date().toISOString()} (${elapsedMs}ms)`);
  const path = session.path;
  session = null;

  if (!options.silent) {
    console.log(pc.dim(`  Log: ${path}`));
  }

  return path;
}

function appendRaw(message: string): void {
  if (!session) return;
  try {
    appendFileSync(
      session.path,
      `${new Date().toISOString()}  ${message}\n`,
      "utf8",
    );
  } catch {
    // Logging must never break the command.
  }
}

/** Always written to the active log; echoed to the terminal only when `--verbose`. */
export function trace(message: string): void {
  appendRaw(message);
  if (verbose) {
    console.log(pc.dim(`  · ${message}`));
  }
}

function mirror(message: string): void {
  if (!session) return;
  appendRaw(stripAnsi(message));
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

export const ui = {
  info(message: string): void {
    mirror(message);
    console.log(message);
  },

  step(message: string): void {
    mirror(`› ${message}`);
    console.log(`${pc.cyan("›")} ${message}`);
  },

  success(message: string): void {
    mirror(`✓ ${message}`);
    console.log(`${pc.green("✓")} ${message}`);
  },

  warn(message: string): void {
    mirror(`! ${message}`);
    console.warn(`${pc.yellow("!")} ${message}`);
  },

  error(message: string): void {
    mirror(`✗ ${message}`);
    console.error(`${pc.red("✗")} ${message}`);
  },

  detail(message: string): void {
    mirror(message);
    console.log(pc.dim(`  ${message}`));
  },

  heading(message: string): void {
    mirror(stripAnsi(message));
    console.log(`\n${pc.bold(message)}`);
  },

  blank(): void {
    console.log("");
  },

  /** Step detail for multi-step flows — log always, terminal only with `--verbose`. */
  trace,
};

export class RadianceError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "RadianceError";
    this.hint = hint;
  }
}
