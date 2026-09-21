/**
 * Radiance-managed regions.
 *
 * Generated code is spliced between `radiance:<name>:start` and `radiance:<name>:end`
 * markers so installs stay idempotent and anything a user writes outside the markers
 * survives untouched. Everything here is plain text manipulation — no AST, no reformatting.
 */

export function startMarker(name: string): string {
  return `radiance:${name}:start`;
}

export function endMarker(name: string): string {
  return `radiance:${name}:end`;
}

export function hasMarker(content: string, name: string): boolean {
  return (
    content.includes(startMarker(name)) && content.includes(endMarker(name))
  );
}

function findMarkerLines(
  lines: string[],
  name: string,
): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.includes(startMarker(name)));
  const end = lines.findIndex((line) => line.includes(endMarker(name)));
  if (start === -1 || end === -1 || end < start) return null;
  return { start, end };
}

function indentationOf(line: string): string {
  return line.match(/^\s*/)?.[0] ?? "";
}

function commentStyle(line: string): (text: string) => string {
  if (line.includes("{/*")) return (text) => `{/* ${text} */}`;
  if (line.trimStart().startsWith("#")) return (text) => `# ${text}`;
  return (text) => `// ${text}`;
}

export type InsertOptions = {
  /**
   * Wraps the block in its own start/end comments so a later install can replace exactly
   * this module's contribution instead of appending a duplicate.
   */
  tag?: string;
};

/**
 * Catalogue JSON sometimes stores `\\n` (a literal backslash-n) instead of a real
 * newline. Split on those too so functions barrels do not land on one broken line.
 */
export function normalizeMarkerBlock(block: string): string {
  return block.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
}

/** Inserts `block` just before the end marker. Returns the content unchanged if absent. */
export function insertAtMarker(
  content: string,
  name: string,
  block: string,
  options: InsertOptions = {},
): string {
  const lines = content.split("\n");
  const marker = findMarkerLines(lines, name);
  if (!marker) return content;

  const endLine = lines[marker.end] ?? "";
  const indent = indentationOf(endLine);
  const comment = commentStyle(endLine);
  const normalizedBlock = normalizeMarkerBlock(block);
  const blockLines = normalizedBlock
    .split("\n")
    .map((line) => (line ? `${indent}${line}` : line));

  if (options.tag) {
    const tagStart = `${indent}${comment(startMarker(`module:${options.tag}`))}`;
    const tagEnd = `${indent}${comment(endMarker(`module:${options.tag}`))}`;

    const tagged = [tagStart, ...blockLines, tagEnd];

    const existingStart = lines.findIndex(
      (line, index) =>
        index > marker.start &&
        index < marker.end &&
        line.includes(startMarker(`module:${options.tag}`)),
    );
    const existingEnd =
      existingStart === -1
        ? -1
        : lines.findIndex(
            (line, index) =>
              index > existingStart &&
              index < marker.end &&
              line.includes(endMarker(`module:${options.tag}`)),
          );

    if (existingStart !== -1 && existingEnd !== -1) {
      lines.splice(existingStart, existingEnd - existingStart + 1, ...tagged);
      return lines.join("\n");
    }

    lines.splice(marker.end, 0, ...tagged);
    return lines.join("\n");
  }

  const region = lines.slice(marker.start + 1, marker.end).join("\n");
  if (region.includes(normalizedBlock.trim())) return content;

  lines.splice(marker.end, 0, ...blockLines);
  return lines.join("\n");
}

/** Adds an import after the last existing import, skipping duplicates. */
export function insertImport(content: string, importLine: string): string {
  const normalized = importLine.trim();
  if (content.includes(normalized)) return content;

  const lines = content.split("\n");
  let lastImport = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*import\s/.test(line)) lastImport = index;
    // Stop at the first real statement so imports inside strings or later code are ignored.
    if (
      lastImport !== -1 &&
      line.trim() !== "" &&
      !/^\s*(import\s|\/\/|\/\*|\*)/.test(line)
    )
      break;
  }

  if (lastImport === -1) {
    return `${normalized}\n\n${content}`;
  }

  lines.splice(lastImport + 1, 0, normalized);
  return lines.join("\n");
}

/** Registers a React provider in `lib/registry/providers.tsx`. */
export function registerProvider(
  content: string,
  provider: { import: string; component: string },
  tag?: string,
): string {
  const withImport = insertAtMarker(
    content,
    "providers:imports",
    provider.import,
    tag ? { tag: `${tag}:import` } : {},
  );
  const applied =
    withImport === content && !hasMarker(content, "providers:imports")
      ? insertImport(content, provider.import)
      : withImport;

  return insertAtMarker(
    applied,
    "providers:list",
    `${provider.component},`,
    tag ? { tag } : {},
  );
}

/** Removes a tagged `radiance:module:<id>` block (inclusive of its markers). */
export function stripModuleTag(content: string, moduleId: string): string {
  const start = startMarker(`module:${moduleId}`);
  const end = endMarker(`module:${moduleId}`);
  const lines = content.split("\n");
  const next: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (line.includes(start)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.includes(end)) skipping = false;
      continue;
    }
    next.push(line);
  }

  return next.join("\n");
}

/** Drops a provider import + list entry, including tagged blocks when `tag` is set. */
export function unregisterProvider(
  content: string,
  provider: { import: string; component: string },
  tag?: string,
): string {
  let next = content;
  if (tag) {
    next = stripModuleTag(next, tag);
    next = stripModuleTag(next, `${tag}:import`);
  }

  const importLine = provider.import.trim();
  next = next
    .split("\n")
    .filter((line) => line.trim() !== importLine)
    .join("\n");

  const component = provider.component.trim();
  next = next
    .split("\n")
    .filter(
      (line) => line.trim() !== `${component},` && line.trim() !== component,
    )
    .join("\n");

  return next;
}

/** Removes an untagged wired block if it is still present verbatim. */
export function removeExactBlock(content: string, block: string): string {
  const trimmed = normalizeMarkerBlock(block).trim();
  if (!trimmed) return content;
  if (!content.includes(trimmed)) return content;
  return content.replace(trimmed, "").replace(/\n{3,}/g, "\n\n");
}
