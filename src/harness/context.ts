import fg from "fast-glob";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectConfig } from "../core/project.js";
import type { TemplateSource } from "../core/registry.js";

/** Everything the harness is allowed to look at, and nothing generated or vendored. */
const SOURCE_GLOBS = [
  "app/**/*.{ts,tsx}",
  "components/**/*.{ts,tsx}",
  "hooks/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
  "stores/**/*.{ts,tsx}",
  "functions/src/**/*.ts",
  "locales/*.json",
  "firestore.rules",
  "storage.rules",
  "firestore.indexes.json",
  "package.json",
  "app.config.ts",
];

const IGNORED = [
  "**/node_modules/**",
  "**/.expo/**",
  "**/dist/**",
  "**/build/**",
  "**/.radiance/**",
];

export type ProjectContext = {
  root: string;
  project: ProjectConfig;
  source: TemplateSource;
  constitution: string;
  /** Every source file path in the project, relative to the root. */
  files: string[];
};

export async function buildContext(
  root: string,
  project: ProjectConfig,
  source: TemplateSource,
): Promise<ProjectContext> {
  const files = await fg(SOURCE_GLOBS, {
    cwd: root,
    onlyFiles: true,
    ignore: IGNORED,
  });

  const constitution = await readFile(join(root, "RADIANCE.md"), "utf8").catch(
    () => "",
  );

  return { root, project, source, constitution, files: files.sort() };
}

/** A compact directory listing — enough for the model to place new files correctly. */
export function renderTree(files: string[], limit = 220): string {
  const shown = files.slice(0, limit);
  const remainder = files.length - shown.length;
  const lines = shown.map((file) => `  ${file}`);

  if (remainder > 0) lines.push(`  … and ${remainder} more files`);
  return lines.join("\n");
}

export function renderCatalogue(
  source: TemplateSource,
  installed: Set<string>,
): string {
  const modules = source.registry.modules.map((module) => {
    const mark = installed.has(module.id) ? "installed" : "available";
    return `- ${module.id} (${mark}): ${module.description} [${module.capabilities.join(", ")}]`;
  });

  return modules.join("\n");
}

export type FileSnippet = {
  path: string;
  contents: string;
  truncated: boolean;
};

const MAX_SNIPPET_CHARS = 8000;

export async function readSnippets(
  root: string,
  paths: string[],
): Promise<FileSnippet[]> {
  const snippets: FileSnippet[] = [];

  for (const path of paths) {
    const contents = await readFile(join(root, path), "utf8").catch(() => null);
    if (contents === null) continue;

    snippets.push({
      path,
      contents: contents.slice(0, MAX_SNIPPET_CHARS),
      truncated: contents.length > MAX_SNIPPET_CHARS,
    });
  }

  return snippets;
}

export function renderSnippets(snippets: FileSnippet[]): string {
  return snippets
    .map((snippet) => {
      const suffix = snippet.truncated ? "\n… (truncated)" : "";
      return `--- ${snippet.path}\n${snippet.contents}${suffix}`;
    })
    .join("\n\n");
}
