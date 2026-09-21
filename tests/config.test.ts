import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GlobalConfigSchema } from "../src/core/config.js";

describe("config packageManager", () => {
  it("accepts packageManager in the schema", () => {
    const parsed = GlobalConfigSchema.parse({ packageManager: "yarn" });
    assert.equal(parsed.packageManager, "yarn");
  });

  it("rejects unknown package managers", () => {
    const result = GlobalConfigSchema.safeParse({ packageManager: "cargo" });
    assert.equal(result.success, false);
  });
});
