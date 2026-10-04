import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Workspace } from "../src/core/apply/workspace.js";
import {
  MAX_BATCH_CHARS,
  MAX_BATCH_STRINGS,
  acceptTranslation,
  translateLocaleFiles,
} from "../src/core/translate-locales.js";
import {
  TRANSLATION_MEMORY_ENV,
  loadTranslationMemory,
  resolveTranslationMemoryDir,
  saveTranslationMemory,
  sourceHash,
} from "../src/core/translation-memory.js";
import type { ChatMessage, LlmClient } from "../src/harness/llm.js";

/**
 * Translation used to be one call per locale for the whole catalogue. It is
 * now batched, remembered and checked; these pin the parts a caller relies
 * on: the output has English's exact shape, remembered strings cost no call,
 * and a bad or failed answer leaves English rather than a broken string.
 */

const scratch = mkdtempSync(join(tmpdir(), "radiance-translate-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function tempDir(label: string): string {
  counter += 1;
  const dir = join(scratch, `${label}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A project directory holding `locales/en.json`. */
function project(en: unknown): string {
  const root = tempDir("project");
  mkdirSync(join(root, "locales"));
  writeFileSync(join(root, "locales", "en.json"), JSON.stringify(en, null, 2));
  return root;
}

type Call = { locale: string; batch: Record<string, string> };

/**
 * A model that answers each id with `[<locale>] <source>` (placeholders
 * intact), unless `answer` says otherwise. `answer` may throw, or return a
 * raw reply string to send instead of JSON.
 */
function fakeClient(
  options: {
    answer?: (
      source: string,
      locale: string,
      call: number,
    ) => string | undefined;
    reply?: (call: number) => string | undefined;
    fail?: (call: number) => boolean;
    /** Awaited before the call answers. */
    during?: (call: number, locale: string) => Promise<void>;
    delayMs?: number;
  } = {},
) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const client: LlmClient = {
    provider: "anthropic",
    model: "fake",
    async complete(messages: ChatMessage[]) {
      const prompt = messages.find((message) => message.role === "user")!;
      const locale = /locale "([^"]+)"/.exec(prompt.content)![1]!;
      const payloadStart = prompt.content.indexOf("\n\n{\n");
      const batch = JSON.parse(
        prompt.content.slice(payloadStart + 2),
      ) as Record<string, string>;
      const call = calls.length;
      calls.push({ locale, batch });

      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await delay(options.delayMs ?? 0);
        await options.during?.(call, locale);
        if (options.fail?.(call)) throw new Error("provider down");
        const raw = options.reply?.(call);
        if (raw !== undefined) return raw;
        const out: Record<string, string> = {};
        for (const [id, source] of Object.entries(batch)) {
          out[id] =
            options.answer?.(source, locale, call) ?? `[${locale}] ${source}`;
        }
        return JSON.stringify(out);
      } finally {
        inFlight -= 1;
      }
    },
  };

  return {
    client,
    calls,
    maxInFlight: () => maxInFlight,
  };
}

function readLocale(root: string, locale: string): string {
  return readFileSync(join(root, "locales", `${locale}.json`), "utf8");
}

async function translate(
  root: string,
  locales: string[],
  client: LlmClient,
  memoryDir: string,
  concurrency?: number,
) {
  const workspace = new Workspace(root);
  const stats = await translateLocaleFiles(workspace, locales, client, {
    memoryDir,
    ...(concurrency ? { concurrency } : {}),
  });
  for (const change of workspace.changes()) {
    writeFileSync(join(root, change.path), change.contents ?? "");
  }
  return stats;
}

describe("translateLocaleFiles", () => {
  it("rebuilds English's exact shape and key order, copying non-string leaves", async () => {
    const en = {
      zeta: "Comes first",
      app: {
        title: "Hello",
        count: 3,
        enabled: true,
        missing: null,
        tips: ["Tip one", "Tip two", 7],
        blank: "",
      },
      alpha: "Welcome {{name}}",
      again: "Hello",
    };
    const root = project(en);
    const fake = fakeClient();

    const stats = await translate(
      root,
      ["en", "fr"],
      fake.client,
      tempDir("tm"),
    );

    const expected = {
      zeta: "[fr] Comes first",
      app: {
        title: "[fr] Hello",
        count: 3,
        enabled: true,
        missing: null,
        tips: ["[fr] Tip one", "[fr] Tip two", 7],
        blank: "",
      },
      alpha: "[fr] Welcome {{name}}",
      again: "[fr] Hello",
    };
    // Compared as text so key order counts, not just key sets.
    assert.equal(
      readLocale(root, "fr"),
      `${JSON.stringify(expected, null, 2)}\n`,
    );
    assert.deepEqual(stats, [
      { locale: "fr", strings: 6, fromMemory: 0, translated: 6, fellBack: 0 },
    ]);
    // "Hello" appears twice but is sent once.
    assert.equal(fake.calls.length, 1);
    assert.equal(Object.keys(fake.calls[0]!.batch).length, 5);
  });

  it("drops keys the model adds and ignores the order it answers in", async () => {
    const root = project({ b: "Bee", a: "Ay" });
    const fake = fakeClient({
      reply: () => JSON.stringify({ extra: "Nope", 1: "Ah", 0: "Bi" }),
    });

    await translate(root, ["de"], fake.client, tempDir("tm"));

    assert.equal(
      readLocale(root, "de"),
      `${JSON.stringify({ b: "Bi", a: "Ah" }, null, 2)}\n`,
    );
  });

  it("reuses the translation memory without calling the model", async () => {
    const en = {
      greeting: "Hello",
      nested: { save: "Save", total: "{{count}} items" },
    };
    const memoryDir = tempDir("tm");

    const first = fakeClient();
    await translate(project(en), ["fr", "de"], first.client, memoryDir);
    assert.equal(first.calls.length, 2);

    const memory = JSON.parse(readFileSync(join(memoryDir, "fr.json"), "utf8"));
    assert.deepEqual(memory, {
      version: 1,
      entries: {
        [sourceHash("Hello")]: "[fr] Hello",
        [sourceHash("Save")]: "[fr] Save",
        [sourceHash("{{count}} items")]: "[fr] {{count}} items",
      },
    });

    const root = project(en);
    const second = fakeClient();
    const stats = await translate(root, ["fr", "de"], second.client, memoryDir);

    assert.equal(second.calls.length, 0);
    assert.deepEqual(stats, [
      { locale: "fr", strings: 3, fromMemory: 3, translated: 0, fellBack: 0 },
      { locale: "de", strings: 3, fromMemory: 3, translated: 0, fellBack: 0 },
    ]);
    assert.equal(JSON.parse(readLocale(root, "de")).nested.save, "[de] Save");
  });

  it("sends only the misses, in batches within the string and character limits", async () => {
    const memoryDir = tempDir("tm");
    const en: Record<string, string> = {};
    for (let index = 0; index < 130; index += 1)
      en[`short${index}`] = `Short ${index}`;
    // 1,000-character strings: six fit under the character limit, not seven.
    for (let index = 0; index < 13; index += 1) {
      en[`long${index}`] = `${index}`.padEnd(1000, "x");
    }
    await saveTranslationMemory(memoryDir, "fr", {
      version: 1,
      entries: { [sourceHash("Short 0")]: "Court 0" },
    });

    const fake = fakeClient();
    const stats = await translate(project(en), ["fr"], fake.client, memoryDir);

    const sizes = fake.calls.map((call) => Object.keys(call.batch).length);
    // 129 short misses fill two batches of 60; the last nine share a batch
    // with the first five long strings (81 + 5,000 characters, and a sixth
    // would pass 6,000); then six long strings exactly reach it, then two.
    assert.deepEqual(sizes, [60, 60, 14, 6, 2]);
    for (const call of fake.calls) {
      const sources = Object.values(call.batch);
      assert.ok(sources.length <= MAX_BATCH_STRINGS);
      const chars = sources.reduce((sum, source) => sum + source.length, 0);
      assert.ok(sources.length === 1 || chars <= MAX_BATCH_CHARS);
      assert.equal(sources.includes("Short 0"), false);
    }
    assert.deepEqual(stats, [
      {
        locale: "fr",
        strings: 143,
        fromMemory: 1,
        translated: 142,
        fellBack: 0,
      },
    ]);
  });

  it("runs batches concurrently across locales, within the limit", async () => {
    const en: Record<string, string> = {};
    for (let index = 0; index < 150; index += 1)
      en[`k${index}`] = `String ${index}`;
    const fake = fakeClient({ delayMs: 15 });

    await translate(
      project(en),
      ["fr", "de", "es"],
      fake.client,
      tempDir("tm"),
      2,
    );

    assert.equal(fake.calls.length, 9);
    assert.equal(fake.maxInFlight(), 2);
  });

  it("keeps English, and remembers nothing, when placeholders do not survive", async () => {
    const memoryDir = tempDir("tm");
    const root = project({
      welcome: "Welcome {{name}}",
      link: "<0>Click</0> here",
      nest: "See $t(common.terms)",
      plain: "Plain",
    });
    const fake = fakeClient({
      answer: (source) =>
        ({
          "Welcome {{name}}": "Bienvenue",
          "<0>Click</0> here": "<0>Cliquez</0> ici",
          "See $t(common.terms)": "Voir les conditions",
          Plain: "",
        })[source],
    });

    const stats = await translate(root, ["fr"], fake.client, memoryDir);

    assert.deepEqual(JSON.parse(readLocale(root, "fr")), {
      welcome: "Welcome {{name}}",
      link: "<0>Cliquez</0> ici",
      nest: "See $t(common.terms)",
      plain: "Plain",
    });
    assert.deepEqual(stats, [
      { locale: "fr", strings: 4, fromMemory: 0, translated: 1, fellBack: 3 },
    ]);
    const memory = await loadTranslationMemory(memoryDir, "fr");
    assert.deepEqual(memory.entries, {
      [sourceHash("<0>Click</0> here")]: "<0>Cliquez</0> ici",
    });
  });

  it("retries a failed batch once", async () => {
    const root = project({ a: "One", b: "Two" });
    const fake = fakeClient({
      reply: (call) => (call === 0 ? "not json" : undefined),
    });

    const stats = await translate(root, ["fr"], fake.client, tempDir("tm"));

    assert.equal(fake.calls.length, 2);
    assert.deepEqual(stats[0]?.translated, 2);
    assert.equal(JSON.parse(readLocale(root, "fr")).a, "[fr] One");
  });

  it("falls back to English when the retry fails too", async () => {
    const memoryDir = tempDir("tm");
    const root = project({ a: "One", b: "Two" });
    const fake = fakeClient({ fail: () => true });

    const stats = await translate(root, ["fr"], fake.client, memoryDir);

    assert.equal(fake.calls.length, 2);
    assert.deepEqual(stats, [
      { locale: "fr", strings: 2, fromMemory: 0, translated: 0, fellBack: 2 },
    ]);
    assert.deepEqual(JSON.parse(readLocale(root, "fr")), {
      a: "One",
      b: "Two",
    });
    assert.deepEqual(readdirSync(memoryDir), []);
  });

  it("keeps memory entries another process saved while this one translated", async () => {
    const memoryDir = tempDir("tm");
    await saveTranslationMemory(memoryDir, "fr", {
      version: 1,
      entries: { [sourceHash("Known")]: "Connu" },
    });
    const fake = fakeClient({
      // Stands in for a second build saving to the shared memory mid-run,
      // after this run loaded it — including a newer take on a loaded entry.
      during: (_call, locale) =>
        saveTranslationMemory(memoryDir, locale, {
          version: 1,
          entries: { elsewhere: "Ailleurs", [sourceHash("Known")]: "Su" },
        }),
    });

    await translate(
      project({ a: "One", b: "Known" }),
      ["fr"],
      fake.client,
      memoryDir,
    );

    const memory = await loadTranslationMemory(memoryDir, "fr");
    assert.deepEqual(memory.entries, {
      [sourceHash("Known")]: "Su",
      elsewhere: "Ailleurs",
      [sourceHash("One")]: "[fr] One",
    });
  });
});

describe("acceptTranslation", () => {
  it("accepts a translation carrying the same placeholders, in any order and spacing", () => {
    assert.equal(
      acceptTranslation("{{a}} and {{b}}", "{{ b }} et {{a}}"),
      "{{ b }} et {{a}}",
    );
    assert.equal(
      acceptTranslation("Tap <1/> to go", "Touchez <1 /> pour aller"),
      "Touchez <1 /> pour aller",
    );
  });

  it("rejects missing or extra placeholders, tags and nesting references", () => {
    assert.equal(acceptTranslation("{{count}} items", "articles"), null);
    assert.equal(acceptTranslation("Items", "{{count}} articles"), null);
    assert.equal(acceptTranslation("{{n}} {{n}}", "{{n}}"), null);
    assert.equal(acceptTranslation("<0>Go</0>", "<0>Aller"), null);
    assert.equal(acceptTranslation("$t(a.b) now", "maintenant"), null);
  });

  it("rejects anything but a non-empty string", () => {
    assert.equal(acceptTranslation("Hi", ""), null);
    assert.equal(acceptTranslation("Hi", "   "), null);
    assert.equal(acceptTranslation("Hi", 42), null);
    assert.equal(acceptTranslation("Hi", undefined), null);
  });
});

describe("translation memory", () => {
  it("merges with what is on disk at save time, this run winning a clash", async () => {
    const dir = tempDir("tm");
    const mine = await loadTranslationMemory(dir, "fr");
    await saveTranslationMemory(dir, "fr", {
      version: 1,
      entries: { theirs: "Leur", shared: "Old" },
    });

    mine.entries.mine = "Moi";
    mine.entries.shared = "New";
    await saveTranslationMemory(dir, "fr", mine);

    assert.deepEqual(JSON.parse(readFileSync(join(dir, "fr.json"), "utf8")), {
      version: 1,
      entries: { theirs: "Leur", shared: "New", mine: "Moi" },
    });
    // Written through a temporary file that is renamed away.
    assert.deepEqual(readdirSync(dir), ["fr.json"]);
  });

  it("loads a missing or corrupt file as empty", async () => {
    const dir = tempDir("tm");
    assert.deepEqual(await loadTranslationMemory(dir, "fr"), {
      version: 1,
      entries: {},
    });
    writeFileSync(join(dir, "de.json"), "{ not json");
    assert.deepEqual((await loadTranslationMemory(dir, "de")).entries, {});
    writeFileSync(
      join(dir, "es.json"),
      JSON.stringify({ version: 1, entries: { ok: "Sí", bad: 3 } }),
    );
    assert.deepEqual((await loadTranslationMemory(dir, "es")).entries, {
      ok: "Sí",
    });
  });

  it("hashes the English source to 32 hex characters", () => {
    assert.match(sourceHash("Hello"), /^[0-9a-f]{32}$/);
    assert.equal(sourceHash("Hello"), sourceHash("Hello"));
    assert.notEqual(sourceHash("Hello"), sourceHash("Hello "));
  });

  it("resolves the directory from the option, then the environment, then the cache", () => {
    const saved = {
      memory: process.env[TRANSLATION_MEMORY_ENV],
      cache: process.env.RADIANCE_CACHE_DIR,
    };
    try {
      process.env[TRANSLATION_MEMORY_ENV] = "/from/env";
      process.env.RADIANCE_CACHE_DIR = "/cache";
      assert.equal(resolveTranslationMemoryDir("/explicit"), "/explicit");
      assert.equal(resolveTranslationMemoryDir(), "/from/env");
      delete process.env[TRANSLATION_MEMORY_ENV];
      assert.equal(
        resolveTranslationMemoryDir(),
        join("/cache", "translation-memory"),
      );
    } finally {
      for (const [key, value] of [
        [TRANSLATION_MEMORY_ENV, saved.memory],
        ["RADIANCE_CACHE_DIR", saved.cache],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
