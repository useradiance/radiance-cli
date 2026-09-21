import { createTwoFilesPatch } from "diff";
import pc from "picocolors";

import type { FileChange } from "./apply/workspace.js";

/** Unified diff for one staged change, coloured for a terminal. */
export function renderDiff(change: FileChange, contextLines = 3): string {
  if (change.kind === "delete") {
    return pc.red(`- ${change.path} (deleted)`);
  }

  const patch = createTwoFilesPatch(
    change.previous === null ? "/dev/null" : `a/${change.path}`,
    `b/${change.path}`,
    change.previous ?? "",
    change.contents ?? "",
    undefined,
    undefined,
    { context: contextLines },
  );

  return patch
    .split("\n")
    .slice(2) // Drop the redundant "Index:"-style header lines.
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return pc.dim(line);
      if (line.startsWith("@@")) return pc.cyan(line);
      if (line.startsWith("+")) return pc.green(line);
      if (line.startsWith("-")) return pc.red(line);
      return line;
    })
    .join("\n");
}

export function summarizeChanges(changes: FileChange[]): string {
  const symbols: Record<FileChange["kind"], string> = {
    create: pc.green("+"),
    update: pc.yellow("~"),
    delete: pc.red("-"),
  };

  return changes
    .map((change) => {
      const sources =
        change.sources.length > 0
          ? pc.dim(` (${change.sources.join(", ")})`)
          : "";
      return `  ${symbols[change.kind]} ${change.path}${sources}`;
    })
    .join("\n");
}

export function countByKind(
  changes: FileChange[],
): Record<FileChange["kind"], number> {
  return changes.reduce(
    (counts, change) => ({ ...counts, [change.kind]: counts[change.kind] + 1 }),
    { create: 0, update: 0, delete: 0 },
  );
}
