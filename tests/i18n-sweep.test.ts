import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { Workspace } from "../src/core/apply/workspace.js";
import { changedUiFiles, sweepI18nCatalogue } from "../src/core/i18n-sweep.js";
import type { LlmClient } from "../src/harness/llm.js";

/**
 * `radiance translate --since <ref>` sweeps only the UI files changed since
 * that ref: committed after it, staged, unstaged or untracked — and nothing
 * outside the sweep's globs, and nothing when git cannot tell.
 */

const scratch = mkdtempSync(join(tmpdir(), "radiance-sweep-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const SCREEN = `export default function Screen() {\n  return <Text>Hello there, this is copy</Text>;\n}\n`;

function write(root: string, path: string, contents = SCREEN): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

/** A repo with a base commit, one commit after it, and uncommitted work. */
function repo(): { root: string; base: string } {
  const root = mkdtempSync(join(scratch, "repo-"));
  git(root, "init", "--quiet");
  write(root, "locales/en.json", "{}\n");
  write(root, "app/index.tsx");
  write(root, "app/untouched.tsx");
  write(root, "components/Old.tsx");
  write(root, "app/removed.tsx");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");

  write(root, "app/(tabs)/[id].tsx");
  write(root, "lib/not-ui.ts");
  rmSync(join(root, "app/removed.tsx"));
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "follow-up");

  write(root, "components/Old.tsx", `${SCREEN}// edited\n`); // unstaged
  write(root, "components/Staged.tsx");
  git(root, "add", "components/Staged.tsx"); // staged
  write(root, "app/new-screen.tsx"); // untracked
  write(root, "node_modules/pkg/app/index.tsx"); // ignored by the globs
  return { root, base };
}

describe("changedUiFiles", () => {
  it("unions committed, staged, unstaged and untracked UI files since the ref", async () => {
    const { root, base } = repo();
    assert.deepEqual(await changedUiFiles(root, base), [
      "app/(tabs)/[id].tsx",
      "app/new-screen.tsx",
      "components/Old.tsx",
      "components/Staged.tsx",
    ]);
  });

  it("returns an empty list when nothing under app/ or components/ changed", async () => {
    const { root } = repo();
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "everything");
    assert.deepEqual(await changedUiFiles(root, "HEAD"), []);
  });

  it("returns null when git cannot answer", async () => {
    const { root } = repo();
    assert.equal(await changedUiFiles(root, "no-such-ref"), null);
    assert.equal(await changedUiFiles(root, "--output=oops"), null);
    const bare = mkdtempSync(join(tmpdir(), "radiance-not-a-repo-"));
    try {
      assert.equal(await changedUiFiles(bare, "HEAD"), null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("sweepI18nCatalogue with onlyPaths", () => {
  function fakeClient() {
    const prompts: string[] = [];
    const client: LlmClient = {
      provider: "anthropic",
      model: "fake",
      async complete(messages) {
        prompts.push(messages.map((message) => message.content).join("\n"));
        return JSON.stringify({ en: {}, edits: [] });
      },
    };
    return { client, prompts };
  }

  it("reviews only the given files", async () => {
    const { root } = repo();
    const fake = fakeClient();

    await sweepI18nCatalogue(new Workspace(root), fake.client, root, [
      "app/new-screen.tsx",
    ]);

    assert.equal(fake.prompts.length, 1);
    assert.match(fake.prompts[0]!, /--- app\/new-screen\.tsx/);
    assert.doesNotMatch(fake.prompts[0]!, /app\/untouched\.tsx/);
  });

  it("makes no call when none of the given files is a UI file", async () => {
    const { root } = repo();
    const fake = fakeClient();

    const result = await sweepI18nCatalogue(
      new Workspace(root),
      fake.client,
      root,
      ["lib/not-ui.ts"],
    );

    assert.deepEqual(result, { keysAdded: 0, filesEdited: 0 });
    assert.equal(fake.prompts.length, 0);
  });
});
