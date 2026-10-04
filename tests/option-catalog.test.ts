import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadOptionCatalog } from "../src/harness/init-interview.js";
import {
  applyFlagOverrides,
  sanitizePlanOptions,
} from "../src/harness/init-slots.js";

/**
 * The catalogue `--prompt` validates options against.
 *
 * It was hard-coded to navigation, auth, firestore and theme, so on the
 * `--prompt` path every other module's `--option` was dropped without a word:
 * `--option search.backend=algolia` produced Firestore search.
 */
const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "radiance-catalog-"));
  roots.push(root);
  const modules = [
    {
      id: "search",
      options: {
        backend: {
          type: "single",
          choices: ["firestore", "algolia"],
          default: "firestore",
        },
      },
    },
    {
      id: "theme",
      options: {
        pack: {
          type: "single",
          choices: ["neutral", "ocean"],
          default: "neutral",
        },
      },
    },
    { id: "chat", options: {} },
  ];
  for (const module of modules) {
    await mkdir(join(root, "modules", module.id), { recursive: true });
    await writeFile(
      join(root, "modules", module.id, "module.json"),
      JSON.stringify({
        id: module.id,
        version: "0.1.0",
        title: module.id,
        description: module.id,
        options: module.options,
      }),
    );
  }
  return {
    root,
    version: "test",
    local: true,
    registry: {
      version: "test",
      modules: modules.map((module) => ({
        id: module.id,
        path: `modules/${module.id}`,
        version: "0.1.0",
        title: module.id,
        description: module.id,
        requires: [],
        conflicts: [],
        capabilities: [],
      })),
      starters: [],
    },
  } as never;
}

describe("loadOptionCatalog", () => {
  it("includes every module that declares options, not a fixed few", async () => {
    const catalog = await loadOptionCatalog(await fixture());
    assert.ok(catalog["search.backend"], "search.backend missing");
    assert.ok(catalog["theme.pack"], "theme.pack missing");
  });

  it("keeps a user's --option for such a module through sanitising", async () => {
    const source = await fixture();
    const catalog = await loadOptionCatalog(source);
    const plan = sanitizePlanOptions(
      applyFlagOverrides(
        { options: {} } as never,
        { option: ["search.backend=algolia"] } as never,
        (source as { registry: never }).registry,
      ),
      catalog,
    );
    assert.equal(plan.options["search.backend"], "algolia");
  });
});
