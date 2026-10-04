import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  TIMINGS_FILE_ENV,
  recordCount,
  reportUsage,
  resetTimings,
  timed,
  timingsReport,
  type TimingsReport,
} from "../src/core/timings.js";
import { withLlmTimings, type LlmClient } from "../src/harness/llm.js";

/**
 * `RADIANCE_TIMINGS_FILE` is how the hosted service finds out where a run's
 * minutes go, so the shape it reads — step paths, LLM attribution, counters —
 * is a contract, and so is writing nothing at all when the variable is unset.
 */

const scratch = mkdtempSync(join(tmpdir(), "radiance-timings-"));
// Test files run in their own process, so this reaches no other test file.
process.env[TIMINGS_FILE_ENV] = join(scratch, "in-process.json");

after(() => {
  // Unset before exit, so the exit hook this process installed writes nothing.
  delete process.env[TIMINGS_FILE_ENV];
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => resetTimings());

describe("timed", () => {
  it("records nested steps by path, parents first", async () => {
    const value = await timed("prompt", async () => {
      await timed("verify", async () => {
        await timed("typecheck", async () => delay(2));
      });
      await timed("commit", async () => undefined);
      return 42;
    });

    assert.equal(value, 42);
    const steps = timingsReport().steps;
    assert.deepEqual(
      steps.map((step) => step.name),
      ["prompt", "prompt/verify", "prompt/verify/typecheck", "prompt/commit"],
    );
    assert.ok(steps.every((step) => step.ok));
    const [prompt, verify] = steps;
    assert.ok(prompt!.ms >= verify!.ms);
    assert.ok(verify!.startMs >= prompt!.startMs);
  });

  it("keeps concurrent siblings on their own paths", async () => {
    await timed("translate", () =>
      Promise.all(
        ["fr", "de"].map((locale) =>
          timed(locale, async () => {
            await delay(locale === "fr" ? 5 : 1);
            await timed("batch", async () => undefined);
          }),
        ),
      ),
    );

    assert.deepEqual(
      timingsReport()
        .steps.map((step) => step.name)
        .sort(),
      [
        "translate",
        "translate/de",
        "translate/de/batch",
        "translate/fr",
        "translate/fr/batch",
      ],
    );
  });

  it("records ok: false and rethrows the same error", async () => {
    const boom = new Error("boom");
    await assert.rejects(
      timed("outer", () =>
        timed("inner", async () => {
          throw boom;
        }),
      ),
      (error) => error === boom,
    );

    const steps = timingsReport().steps;
    assert.deepEqual(
      steps.map((step) => [step.name, step.ok]),
      [
        ["outer", false],
        ["outer/inner", false],
      ],
    );
  });
});

describe("recordCount", () => {
  it("sums counters by name", () => {
    recordCount("translate.fromMemory", 2);
    recordCount("translate.fromMemory", 3);
    recordCount("verify.rounds", 0);

    assert.deepEqual(timingsReport().counts, {
      "translate.fromMemory": 5,
      "verify.rounds": 0,
    });
  });
});

describe("withLlmTimings", () => {
  /** Echoes its prompt; "slow" reports usage early and finishes last. */
  function fakeClient(provider: LlmClient["provider"] = "anthropic") {
    const client: LlmClient = {
      provider,
      model: "fake-model",
      async complete(messages) {
        const prompt = messages.map((message) => message.content).join("");
        if (prompt === "fail") throw new Error("provider down");
        if (provider === "anthropic") {
          reportUsage(
            prompt === "slow"
              ? { inputTokens: 100, outputTokens: 10 }
              : { inputTokens: 200, outputTokens: 20 },
          );
        }
        await delay(prompt === "slow" ? 20 : 1);
        return `reply:${prompt}`;
      },
    };
    return withLlmTimings(client);
  }

  it("attributes concurrent calls to their own step and usage", async () => {
    const client = fakeClient();

    await Promise.all([
      timed("plan", () =>
        client.complete([{ role: "user", content: "slow" }], {
          json: true,
          maxTokens: 1000,
        }),
      ),
      timed("i18n-sweep", () =>
        client.complete([
          { role: "system", content: "sys" },
          { role: "user", content: "fast" },
        ]),
      ),
    ]);

    const calls = timingsReport().llm;
    const plan = calls.find((call) => call.step === "plan");
    const sweep = calls.find((call) => call.step === "i18n-sweep");

    assert.deepEqual(
      { ...plan, ms: 0 },
      {
        step: "plan",
        provider: "anthropic",
        model: "fake-model",
        ms: 0,
        promptChars: 4,
        replyChars: "reply:slow".length,
        maxTokens: 1000,
        json: true,
        ok: true,
        inputTokens: 100,
        outputTokens: 10,
      },
    );
    assert.equal(sweep?.promptChars, 7);
    assert.equal(sweep?.maxTokens, null);
    assert.equal(sweep?.json, false);
    assert.equal(sweep?.inputTokens, 200);
    assert.equal(sweep?.outputTokens, 20);
    assert.ok(plan!.ms >= sweep!.ms);
  });

  it("uses '-' outside a step, omits usage a provider does not report, and records failures", async () => {
    const ollama = fakeClient("ollama");
    await ollama.complete([{ role: "user", content: "hi" }]);
    await assert.rejects(
      fakeClient().complete([{ role: "user", content: "fail" }]),
      /provider down/,
    );

    const [plain, failed] = timingsReport().llm;
    assert.equal(plain?.step, "-");
    assert.equal(plain?.ok, true);
    assert.equal("inputTokens" in plain!, false);
    assert.equal("outputTokens" in plain!, false);
    assert.equal(failed?.ok, false);
    assert.equal(failed?.replyChars, 0);
  });
});

/*
 * The exit hook is exercised in a child process: it is the process's exit
 * that writes the file, and a run that throws must write it too.
 */
describe("the timings file", () => {
  const timingsModule = fileURLToPath(
    new URL("../src/core/timings.js", import.meta.url),
  );
  const script = `
    const t = await import(${JSON.stringify(timingsModule)});
    t.setTimingsCommand("prompt");
    await t.timed("prompt", () => t.timed("context", async () => {}));
    t.recordCount("verify.rounds", 2);
    await t.timed("verify", async () => { throw new Error("tsc exploded"); });
  `;

  function run(cwd: string, env: NodeJS.ProcessEnv) {
    const childEnv = { ...process.env, ...env };
    if (!env[TIMINGS_FILE_ENV]) delete childEnv[TIMINGS_FILE_ENV];
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      env: childEnv,
      encoding: "utf8",
    });
  }

  it("is written on exit, into a new directory, even when the command throws", () => {
    const cwd = mkdtempSync(join(scratch, "child-"));
    const file = join(cwd, "nested", "dir", "timings.json");

    const child = run(cwd, { [TIMINGS_FILE_ENV]: file });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /tsc exploded/);

    const report = JSON.parse(readFileSync(file, "utf8")) as TimingsReport;
    assert.equal(report.version, 1);
    assert.equal(report.command, "prompt");
    assert.equal(typeof report.totalMs, "number");
    assert.deepEqual(
      report.steps.map((step) => [step.name, step.ok]),
      [
        ["prompt", true],
        ["prompt/context", true],
        ["verify", false],
      ],
    );
    assert.deepEqual(report.llm, []);
    assert.deepEqual(report.counts, { "verify.rounds": 2 });
  });

  it("is not written, and nothing is recorded, when the variable is unset", async () => {
    const cwd = mkdtempSync(join(scratch, "child-"));
    const child = run(cwd, {});
    assert.notEqual(child.status, 0);
    assert.deepEqual(readdirSync(cwd), []);

    // In-process too: with the variable unset, steps and counters are dropped.
    const previous = process.env[TIMINGS_FILE_ENV];
    delete process.env[TIMINGS_FILE_ENV];
    try {
      assert.equal(await timed("quiet", async () => "value"), "value");
      recordCount("quiet", 1);
      const report = timingsReport();
      assert.deepEqual(report.steps, []);
      assert.deepEqual(report.counts, {});
    } finally {
      process.env[TIMINGS_FILE_ENV] = previous;
    }
    assert.equal(existsSync(join(scratch, "in-process.json")), false);
  });
});
