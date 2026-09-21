import * as prompts from "@clack/prompts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import pc from "picocolors";

import { countByKind, renderDiff, summarizeChanges } from "../diff.js";
import { ui } from "../logger.js";
import type { FileChange, Note } from "./workspace.js";

export type WriteOptions = {
  /** Ask before touching disk. */
  confirm: boolean;
  /** Show what would happen and exit. */
  dryRun: boolean;
};

export type WriteResult = {
  written: FileChange[];
  skipped: FileChange[];
  cancelled: boolean;
};

export function reportNotes(notes: Note[]): void {
  const conflicts = notes.filter((note) => note.level === "conflict");
  const warnings = notes.filter((note) => note.level === "warn");
  const infos = notes.filter((note) => note.level === "info");

  for (const note of conflicts) ui.warn(`${note.source}: ${note.message}`);
  for (const note of warnings) ui.warn(`${note.source}: ${note.message}`);
  for (const note of infos) ui.detail(`${note.source}: ${note.message}`);
}

async function commit(root: string, changes: FileChange[]): Promise<void> {
  for (const change of changes) {
    const target = join(root, change.path);

    if (change.kind === "delete") {
      await rm(target, { force: true });
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, change.contents ?? "", "utf8");
  }
}

/**
 * Shows staged changes and writes the ones the user accepts.
 *
 * Nothing reaches disk before this point, so cancelling leaves the project exactly as it was.
 */
export async function applyChanges(
  root: string,
  changes: FileChange[],
  options: WriteOptions,
): Promise<WriteResult> {
  if (changes.length === 0) {
    ui.info("No changes to apply.");
    return { written: [], skipped: [], cancelled: false };
  }

  const counts = countByKind(changes);
  ui.heading(
    `${changes.length} file${changes.length === 1 ? "" : "s"}: ` +
      `${counts.create} new, ${counts.update} changed, ${counts.delete} removed`,
  );
  console.log(summarizeChanges(changes));

  if (options.dryRun) {
    ui.blank();
    ui.info(pc.dim("Dry run — nothing was written."));
    ui.trace("dry-run: no files written");
    return { written: [], skipped: changes, cancelled: false };
  }

  if (!options.confirm) {
    ui.trace(`committing ${changes.length} change(s) without confirmation`);
    await commit(root, changes);
    return { written: changes, skipped: [], cancelled: false };
  }

  ui.blank();
  const decision = await prompts.select({
    message: "Apply these changes?",
    options: [
      { value: "all", label: "Apply all" },
      { value: "review", label: "Review each file" },
      { value: "diff", label: "Show the full diff first" },
      { value: "cancel", label: "Cancel" },
    ],
  });

  if (prompts.isCancel(decision) || decision === "cancel") {
    ui.info("Cancelled. Nothing was written.");
    return { written: [], skipped: changes, cancelled: true };
  }

  if (decision === "diff") {
    for (const change of changes) {
      ui.blank();
      console.log(renderDiff(change));
    }

    const proceed = await prompts.confirm({
      message: "Apply all of the above?",
    });
    if (prompts.isCancel(proceed) || !proceed) {
      ui.info("Cancelled. Nothing was written.");
      return { written: [], skipped: changes, cancelled: true };
    }

    await commit(root, changes);
    return { written: changes, skipped: [], cancelled: false };
  }

  if (decision === "all") {
    await commit(root, changes);
    return { written: changes, skipped: [], cancelled: false };
  }

  const written: FileChange[] = [];
  const skipped: FileChange[] = [];

  for (const change of changes) {
    ui.blank();
    console.log(renderDiff(change));

    const accept = await prompts.confirm({ message: `Apply ${change.path}?` });
    if (prompts.isCancel(accept)) {
      await commit(root, written);
      return { written, skipped: [...skipped, change], cancelled: true };
    }

    if (accept) written.push(change);
    else skipped.push(change);
  }

  await commit(root, written);
  return { written, skipped, cancelled: false };
}
