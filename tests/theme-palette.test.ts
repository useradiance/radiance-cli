import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { localeImportName } from "../src/core/locales.js";
import {
  assertHex,
  expandThemeFromHex,
  mapVibeToBuiltin,
  normalizeHex,
  registerCustomThemePack,
  serializeThemePackFile,
} from "../src/harness/theme-palette.js";

describe("theme palette", () => {
  it("normalizes short and long hex", () => {
    assert.equal(normalizeHex("#abc"), "#aabbcc");
    assert.equal(normalizeHex("2563eb"), "#2563eb");
    assert.equal(normalizeHex("nope"), null);
  });

  it("expands a primary hex into light and dark packs", () => {
    const pack = expandThemeFromHex({
      primary: "#0d9488",
      background: "#f0f9fa",
    });
    assert.equal(pack.id, "custom");
    assert.equal(pack.light.primary, "#0d9488");
    assert.ok(pack.dark.primary.startsWith("#"));
    assert.ok(pack.light.background);
    assert.ok(pack.dark.text);
  });

  it("maps vibes onto built-ins", () => {
    assert.equal(mapVibeToBuiltin("calm ocean teal maritime").pack, "ocean");
    assert.equal(
      mapVibeToBuiltin("high contrast outdoor a11y").pack,
      "contrast",
    );
    assert.equal(mapVibeToBuiltin("editorial ink indigo").pack, "ink");
  });

  it("serializes and registers a custom pack", () => {
    const pack = expandThemeFromHex({ primary: "#e11d48" }, "Rose");
    const file = serializeThemePackFile(pack);
    assert.match(file, /export const customPack/);
    assert.match(file, /id: 'custom'/);

    const config = `import { neutralPack } from '@/lib/theme/packs/neutral';
import type { ThemePack } from '@/lib/theme/tokens';

export const themePacks: Record<string, ThemePack> = {
  neutral: neutralPack,
  // radiance:theme-packs:start
  // radiance:theme-packs:end
};
`;
    const next = registerCustomThemePack(config);
    assert.match(next, /customPack/);
    assert.match(next, /custom: customPack/);
  });

  it("rejects invalid hex", () => {
    assert.throws(() => assertHex("red", "primary"));
  });
});

describe("locale helpers", () => {
  it("builds safe import identifiers", () => {
    assert.equal(localeImportName("en"), "en");
    assert.equal(localeImportName("zh-CN"), "zhCn");
    assert.equal(localeImportName("pt-BR"), "ptBr");
  });
});
