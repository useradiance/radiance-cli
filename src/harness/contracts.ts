import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { contractSourceFiles } from "./retrieval.js";

/*
 * Budget for the whole contract block.
 *
 * Raised from 6,000: at that size the list was truncated long before it reached
 * the UI components the model is told to use, which is what left it guessing at
 * props. This is input, and input is both cheap and cacheable — far cheaper
 * than the repair round trip it prevents.
 */
const MAX_CONTRACTS_CHARS = 24_000;
const MAX_PER_FILE_CHARS = 1_800;

/**
 * Builds a compact, ground-truth API surface from the project's own source files.
 *
 * This is injected into every edit/batch prompt so the model cannot invent hook return
 * shapes, StateView props, or spacing tokens that do not exist.
 */
export async function buildProjectContracts(
  root: string,
  projectFiles: string[],
): Promise<string | null> {
  const paths = contractSourceFiles(projectFiles);
  if (paths.length === 0) return null;

  const sections: string[] = [];
  let total = 0;

  for (const path of paths) {
    const source = await readFile(join(root, path), "utf8").catch(() => null);
    if (!source) continue;

    const extracted = extractExportContracts(source, path);
    if (!extracted) continue;

    const block = `// ${path}\n${extracted}`;
    if (total + block.length > MAX_CONTRACTS_CHARS) break;

    sections.push(block);
    total += block.length;
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Pulls exported types, function signatures (plus inferred object returns), and const
 * object key maps from a TypeScript source file.
 */
export function extractExportContracts(source: string, path: string): string {
  const cleaned = stripComments(source);
  const parts: string[] = [];

  parts.push(...extractExportedTypes(cleaned));
  parts.push(...extractExportedFunctions(cleaned));
  parts.push(...extractExportedConstObjects(cleaned));

  const joined = parts.join("\n");
  if (joined.length <= MAX_PER_FILE_CHARS) return joined;

  return `${joined.slice(0, MAX_PER_FILE_CHARS)}\n// … truncated from ${path}`;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractExportedTypes(source: string): string[] {
  const results: string[] = [];
  // Allow optional type params: `export type Foo<T> = ...`
  const typeRe = /export\s+type\s+(\w+)(?:\s*<[^>]*>)?\s*=\s*/g;
  let match: RegExpExecArray | null;

  while ((match = typeRe.exec(source)) !== null) {
    const start = match.index;
    const bodyStart = typeRe.lastIndex;
    const end = findTypeEnd(source, bodyStart);
    const body = source.slice(start, end).trim().replace(/\s+/g, " ");
    if (body.length > 0 && body.length < 800) {
      results.push(body.endsWith(";") ? body : `${body};`);
    }
  }

  return results;
}

function findTypeEnd(source: string, from: number): number {
  let depth = 0;
  let inString: string | null = null;

  for (let i = from; i < source.length; i += 1) {
    const ch = source[i]!;
    const prev = source[i - 1];

    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === ";" && depth <= 0) return i + 1;
    else if (ch === "\n" && depth <= 0) {
      // Multi-line type without trailing semicolon — stop at blank line or next export
      const rest = source.slice(i + 1);
      if (
        /^\s*$/m.test(
          rest.slice(
            0,
            rest.indexOf("\n") === -1 ? rest.length : rest.indexOf("\n"),
          ),
        ) ||
        /^\s*export\s/m.test(rest)
      ) {
        return i;
      }
    }
  }

  return source.length;
}

function extractExportedFunctions(source: string): string[] {
  const results: string[] = [];
  // Optional generics: `export function useDocument<T = DocumentData>(...)`
  const fnStartRe =
    /export\s+(?:async\s+)?function\s+(\w+)(?:\s*<[^>]*>)?\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = fnStartRe.exec(source)) !== null) {
    const name = match[1]!;
    const openParen = fnStartRe.lastIndex - 1;
    const closeParen = findMatchingParen(source, openParen);
    if (closeParen < 0) continue;

    const params = source
      .slice(openParen, closeParen + 1)
      .replace(/\s+/g, " ")
      .trim();
    let i = closeParen + 1;
    while (i < source.length && /\s/.test(source[i]!)) i += 1;

    let explicitReturn: string | undefined;
    if (source[i] === ":") {
      i += 1;
      const retStart = i;
      while (i < source.length && source[i] !== "{") i += 1;
      explicitReturn = source.slice(retStart, i).replace(/\s+/g, " ").trim();
    }

    while (i < source.length && source[i] !== "{") i += 1;
    if (source[i] !== "{") continue;

    const bodyStart = i + 1;
    const bodyEnd = findMatchingBrace(source, i);
    const body = source.slice(bodyStart, bodyEnd);

    // Advance the regex past this function so the next search starts cleanly.
    fnStartRe.lastIndex = bodyEnd + 1;

    if (explicitReturn) {
      results.push(`export function ${name}${params}: ${explicitReturn};`);
      continue;
    }

    const returnShape = inferObjectReturn(body);
    if (returnShape) {
      results.push(`export function ${name}${params}: ${returnShape};`);
    } else {
      results.push(`export function ${name}${params};`);
    }
  }

  return results;
}

function findMatchingParen(source: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;

  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i]!;
    const prev = source[i - 1];

    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function inferObjectReturn(body: string): string | null {
  // Prefer the last top-level `return { ... }` in the function body.
  const returns = [...body.matchAll(/\breturn\s+(\{[\s\S]*?\})\s*;/g)];
  if (returns.length === 0) return null;

  const last = returns[returns.length - 1]![1]!;
  const inner = last.slice(1, -1);
  const keys: string[] = [];

  for (const part of inner.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Support `key`, `key: value`, and `...spread` (skip spreads).
    if (trimmed.startsWith("...")) continue;
    const key = trimmed.match(/^([A-Za-z_][\w]*)/)?.[1];
    if (key) keys.push(key);
  }

  if (keys.length === 0) return null;

  const unique = [...new Set(keys)];
  return `{ ${unique.join("; ")}; }`;
}

function extractExportedConstObjects(source: string): string[] {
  const results: string[] = [];
  const constRe = /export\s+const\s+(\w+)\s*(?::\s*[^=]+)?=\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = constRe.exec(source)) !== null) {
    const name = match[1]!;
    const openIdx = constRe.lastIndex - 1;
    const closeIdx = findMatchingBrace(source, openIdx);
    const objectBody = source.slice(openIdx + 1, closeIdx);
    const keys = [
      ...objectBody.matchAll(/(?:^|\n)\s*([A-Za-z_][\w]*)\s*:/g),
    ].map((m) => m[1]!);

    if (keys.length === 0) continue;
    results.push(
      `export const ${name}: { ${[...new Set(keys)].join("; ")}; };`,
    );
  }

  return results;
}

function findMatchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;

  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i]!;
    const prev = source[i - 1];

    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return source.length;
}

/** Merge planner-provided contracts with deterministic project contracts. */
export function mergeContracts(
  projectContracts: string | null,
  plannerContracts: string | null | undefined,
): string | null {
  const parts = [projectContracts, plannerContracts].filter(
    (part): part is string =>
      typeof part === "string" && part.trim().length > 0,
  );
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
