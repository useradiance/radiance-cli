import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  bindLogSession,
  endLogSession,
  getLogSession,
  isVerbose,
  setVerbose,
  startLogSession,
  trace,
  ui,
} from "../src/core/logger.js";

const dirs: string[] = [];

afterEach(async () => {
  endLogSession({ silent: true });
  setVerbose(false);
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("command log session", () => {
  it("writes traces to a log file and mirrors ui lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-log-"));
    dirs.push(root);

    const path = startLogSession({
      command: "init",
      projectRoot: root,
      argv: ["init", "demo"],
    });
    assert.ok(path.includes(".radiance"));
    assert.equal(getLogSession()?.path, path);

    ui.step("doing a thing");
    trace("quiet detail");

    const finished = endLogSession({ silent: true });
    assert.equal(finished, path);

    const contents = await readFile(path, "utf8");
    assert.match(contents, /# radiance init/);
    assert.match(contents, /› doing a thing/);
    assert.match(contents, /quiet detail/);
    assert.match(contents, /finished:/);
  });

  it("relocates the log into a project directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-log-"));
    dirs.push(root);

    process.env.RADIANCE_CACHE_DIR = join(root, "cache");
    try {
      const globalPath = startLogSession({
        command: "init",
        projectRoot: null,
        argv: ["init"],
      });
      assert.ok(globalPath.includes("cache"));

      const project = join(root, "app");
      const relocated = bindLogSession(project);
      assert.ok(relocated?.includes(join(".radiance", "logs")));
      assert.notEqual(relocated, globalPath);

      endLogSession({ silent: true });
      const contents = await readFile(relocated!, "utf8");
      assert.match(contents, /relocated log from/);
    } finally {
      delete process.env.RADIANCE_CACHE_DIR;
    }
  });

  it("respects setVerbose", () => {
    setVerbose(true);
    assert.equal(isVerbose(), true);
    setVerbose(false);
    assert.equal(isVerbose(), false);
  });
});
