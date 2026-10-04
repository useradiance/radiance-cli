import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { followUpRunOptions, repairRounds } from "../src/commands/prompt.js";

/**
 * A chained follow-up is the second half of one request, so it runs the way
 * the first half did. It used to drop `--provider`, and on a machine with only
 * a Cursor key the follow-up failed trying to reach the default provider.
 */
describe("followUpRunOptions", () => {
  it("carries the provider, model, effort and verify choice", () => {
    assert.deepEqual(
      followUpRunOptions({
        yes: true,
        followUp: true,
        provider: "cursor",
        model: "m-1",
        effort: "fast",
        verify: false,
      }),
      { provider: "cursor", model: "m-1", effort: "fast", verify: false },
    );
  });

  it("does not let a follow-up chain another one", () => {
    const next = followUpRunOptions({ followUp: true, provider: "cursor" });
    assert.equal("followUp" in next, false);
  });

  it("adds nothing that was not set", () => {
    assert.deepEqual(followUpRunOptions({ yes: true }), {});
  });
});

describe("repairRounds", () => {
  it("uses the configured rounds without the flag", () => {
    assert.equal(repairRounds(undefined, 2), 2);
  });

  it("takes the flag, including 0 for no repairs at all", () => {
    assert.equal(repairRounds("1", 2), 1);
    assert.equal(repairRounds("0", 2), 0);
    assert.equal(repairRounds(3, 2), 3);
  });

  it("refuses anything that is not 0-5, rather than reading it as zero", () => {
    for (const bad of ["-1", "6", "1.5", "one", ""]) {
      assert.throws(() => repairRounds(bad, 2), /--max-repairs/, bad);
    }
  });

  it("is carried into a chained follow-up", () => {
    assert.equal(followUpRunOptions({ maxRepairs: "1" }).maxRepairs, "1");
  });
});
