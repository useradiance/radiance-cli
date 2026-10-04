import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { flagsForModule } from "../src/core/install.js";
import { parseOptionFlags } from "../src/core/options.js";
import {
  ModuleManifestSchema,
  type ModuleManifest,
} from "../src/core/registry.js";

/**
 * Which modules an unqualified `--option key=value` is allowed to reach.
 *
 * This decided, silently and wrongly, that `radiance init --demo --theme-pack
 * ocean` should ignore the theme pack: `initMode` was inferred as "no modules
 * were named", and `--demo` names `demo-data`. The result was a project in the
 * theme module's default palette with no error and no warning anywhere — and
 * since the hosted platform always passes `--demo`, that was every project it
 * had ever built.
 */
const themeManifest = (): ModuleManifest =>
  ModuleManifestSchema.parse({
    id: "theme",
    version: "0.1.0",
    title: "Theming",
    description: "Design tokens",
    options: {
      pack: {
        type: "single",
        choices: ["neutral", "ocean"],
        default: "neutral",
      },
    },
  });

describe("flagsForModule", () => {
  const flags = parseOptionFlags(["pack=ocean"]);
  const theme = themeManifest();

  it("reaches a starter module during init, even when other modules were named", () => {
    // `theme` comes from the starter, so it is never "explicitly requested";
    // `--demo` puts demo-data in moduleIds. Both were true of every hosted
    // create, and together they used to drop the flag.
    const scoped = flagsForModule(flags, "theme", theme, false, true);
    assert.deepEqual(scoped, [{ key: "pack", raw: "ocean" }]);
  });

  it("does not reach an unrequested module outside init", () => {
    // `radiance add search --option backend=algolia` must not also retune the
    // theme just because theme happens to declare a `pack` option.
    assert.deepEqual(flagsForModule(flags, "theme", theme, false, false), []);
  });

  it("reaches an explicitly requested module outside init", () => {
    assert.deepEqual(flagsForModule(flags, "theme", theme, true, false), [
      { key: "pack", raw: "ocean" },
    ]);
  });

  it("ignores a flag for an option the module does not declare", () => {
    const other = parseOptionFlags(["backend=algolia"]);
    assert.deepEqual(flagsForModule(other, "theme", theme, true, true), []);
  });

  it("honours a module-qualified flag regardless of scope", () => {
    const qualified = parseOptionFlags(["theme.pack=ocean"]);
    assert.deepEqual(flagsForModule(qualified, "theme", theme, false, false), [
      { moduleId: "theme", key: "pack", raw: "ocean" },
    ]);
    assert.deepEqual(
      flagsForModule(qualified, "search", theme, false, true),
      [],
    );
  });
});
