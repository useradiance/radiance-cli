import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ChangeKind = "create" | "update" | "delete";

export type FileChange = {
  path: string;
  kind: ChangeKind;
  contents: string | null;
  previous: string | null;
  sources: string[];
};

export type NoteLevel = "info" | "warn" | "conflict";

export type Note = {
  level: NoteLevel;
  message: string;
  source: string;
};

/**
 * Staging area for a set of edits.
 *
 * Everything an apply run does is buffered here, so a whole install can be shown as a diff
 * and confirmed before a single file on disk changes. Reads fall through to disk, which lets
 * modules merge into each other's output within one run.
 */
export class Workspace {
  private readonly overlay = new Map<string, string | null>();
  private readonly disk = new Map<string, string | null>();
  private readonly sources = new Map<string, Set<string>>();
  private readonly notes: Note[] = [];

  constructor(readonly root: string) {}

  private async readDisk(path: string): Promise<string | null> {
    if (this.disk.has(path)) return this.disk.get(path) ?? null;

    let contents: string | null = null;
    try {
      contents = await readFile(join(this.root, path), "utf8");
    } catch {
      contents = null;
    }

    this.disk.set(path, contents);
    return contents;
  }

  async read(path: string): Promise<string | null> {
    if (this.overlay.has(path)) return this.overlay.get(path) ?? null;
    return this.readDisk(path);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.read(path)) !== null;
  }

  async write(path: string, contents: string, source: string): Promise<void> {
    await this.readDisk(path);
    this.overlay.set(path, contents);
    this.attribute(path, source);
  }

  async remove(path: string, source: string): Promise<void> {
    if ((await this.read(path)) === null) return;
    this.overlay.set(path, null);
    this.attribute(path, source);
  }

  private attribute(path: string, source: string): void {
    const existing = this.sources.get(path) ?? new Set<string>();
    existing.add(source);
    this.sources.set(path, existing);
  }

  note(level: NoteLevel, message: string, source: string): void {
    this.notes.push({ level, message, source });
  }

  getNotes(): Note[] {
    return [...this.notes];
  }

  /** Buffered edits that actually differ from what is on disk. */
  changes(): FileChange[] {
    const changes: FileChange[] = [];

    for (const [path, contents] of this.overlay) {
      const previous = this.disk.get(path) ?? null;
      if (previous === contents) continue;

      const sources = [...(this.sources.get(path) ?? [])];

      if (contents === null) {
        changes.push({
          path,
          kind: "delete",
          contents: null,
          previous,
          sources,
        });
      } else if (previous === null) {
        changes.push({
          path,
          kind: "create",
          contents,
          previous: null,
          sources,
        });
      } else {
        changes.push({ path, kind: "update", contents, previous, sources });
      }
    }

    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
}
