import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RadianceError } from "../src/core/logger.js";
import {
  detectFromLockfile,
  formatInstallHint,
  formatRunHint,
  installCommand,
  parsePackageManager,
  resolvePackageManager,
  runScriptCommand,
  runScriptInDirCommand,
} from "../src/core/package-manager.js";

describe("package-manager", () => {
  it("parses known managers and rejects unknown ones", () => {
    assert.equal(parsePackageManager("Yarn"), "yarn");
    assert.throws(
      () => parsePackageManager("cargo"),
      (error: unknown) => {
        assert.ok(error instanceof RadianceError);
        return true;
      },
    );
  });

  it("detects the package manager from lockfiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-pm-"));
    assert.equal(detectFromLockfile(root), null);

    await writeFile(join(root, "pnpm-lock.yaml"), "");
    assert.equal(detectFromLockfile(root), "pnpm");

    await writeFile(join(root, "yarn.lock"), "");
    // yarn is preferred when multiple lockfiles exist
    assert.equal(detectFromLockfile(root), "yarn");
  });

  it("builds install and run commands per manager", () => {
    assert.deepEqual(installCommand("npm"), {
      command: "npm",
      args: ["install"],
    });
    assert.deepEqual(installCommand("bun"), {
      command: "bun",
      args: ["install"],
    });

    assert.deepEqual(runScriptCommand("npm", "start"), {
      command: "npm",
      args: ["run", "start"],
    });
    assert.deepEqual(
      runScriptCommand("yarn", "expo", ["export", "--platform", "web"]),
      {
        command: "yarn",
        args: ["expo", "export", "--platform", "web"],
      },
    );
    assert.deepEqual(runScriptCommand("npm", "expo", ["export"]), {
      command: "npm",
      args: ["run", "expo", "--", "export"],
    });

    assert.deepEqual(runScriptInDirCommand("npm", "functions", "build"), {
      command: "npm",
      args: ["--prefix", "functions", "run", "build"],
    });
    assert.deepEqual(runScriptInDirCommand("pnpm", "functions", "build"), {
      command: "pnpm",
      args: ["--dir", "functions", "run", "build"],
    });
  });

  it("formats user-facing install and run hints", () => {
    assert.equal(formatInstallHint("pnpm"), "pnpm install");
    assert.equal(formatRunHint("npm", "start"), "npm run start");
    assert.equal(formatRunHint("yarn", "start"), "yarn start");
    assert.equal(formatRunHint("bun", "start"), "bun run start");
  });

  it("resolves package manager by priority", async () => {
    const installed = { npm: "10.0.0", yarn: "1.22.0", pnpm: "9.0.0" };

    assert.equal(
      await resolvePackageManager({ preferred: "pnpm", installed }),
      "pnpm",
    );
    assert.equal(
      await resolvePackageManager({
        project: "npm",
        global: "yarn",
        installed,
      }),
      "npm",
    );
    assert.equal(
      await resolvePackageManager({
        global: "bun",
        installed: { bun: "1.0.0" },
      }),
      "bun",
    );
    assert.equal(await resolvePackageManager({ installed }), "yarn");

    await assert.rejects(
      () => resolvePackageManager({ preferred: "bun", installed }),
      (error: unknown) => {
        assert.ok(error instanceof RadianceError);
        assert.match((error as RadianceError).message, /bun is configured/);
        return true;
      },
    );
  });
});
