import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasMarker,
  insertAtMarker,
  insertImport,
  registerProvider,
  stripModuleTag,
  unregisterProvider,
} from "../src/core/apply/markers.js";
import {
  appendEnvExample,
  deepMerge,
  mergeIndexes,
  mergeLocales,
  mergePackageJson,
} from "../src/core/apply/merge.js";
import { remapStarterOverlayPath } from "../src/core/apply/engine.js";
import { Workspace } from "../src/core/apply/workspace.js";

const providersFile = [
  "// radiance:providers:imports:start",
  "// radiance:providers:imports:end",
  "",
  "const providers = [",
  "  // radiance:providers:list:start",
  "  // radiance:providers:list:end",
  "];",
].join("\n");

describe("markers", () => {
  it("inserts a block before the end marker", () => {
    const result = insertAtMarker(
      providersFile,
      "providers:list",
      "ThemeProvider,",
    );

    assert.match(
      result,
      /ThemeProvider,\n {2}\/\/ radiance:providers:list:end/,
    );
  });

  it("is idempotent for an identical block", () => {
    const once = insertAtMarker(
      providersFile,
      "providers:list",
      "ThemeProvider,",
    );
    const twice = insertAtMarker(once, "providers:list", "ThemeProvider,");

    assert.equal(once, twice);
  });

  it("leaves content alone when the marker is missing", () => {
    const content = "export const nothing = true;\n";

    assert.equal(insertAtMarker(content, "providers:list", "X,"), content);
  });

  it("replaces a tagged block instead of duplicating it", () => {
    const rules = ["// radiance:rules:start", "// radiance:rules:end"].join(
      "\n",
    );

    const first = insertAtMarker(rules, "rules", "match /a {}", {
      tag: "auth",
    });
    const second = insertAtMarker(first, "rules", "match /b {}", {
      tag: "auth",
    });

    assert.equal(second.match(/radiance:module:auth:start/g)?.length, 1);
    assert.ok(second.includes("match /b {}"));
    assert.ok(!second.includes("match /a {}"));
  });

  it("turns literal \\\\n in a catalogue block into real line breaks", () => {
    const functionsIndex = [
      "// radiance:functions:start",
      "// radiance:functions:end",
    ].join("\n");

    const result = insertAtMarker(
      functionsIndex,
      "functions",
      "export { a } from './a';\\nexport { b } from './b';",
      { tag: "subscriptions" },
    );

    assert.ok(result.includes("export { a } from './a';\n"));
    assert.ok(result.includes("export { b } from './b';\n"));
    assert.ok(!result.includes("\\nexport"));
  });

  it("keeps blocks from different modules side by side", () => {
    const rules = ["// radiance:rules:start", "// radiance:rules:end"].join(
      "\n",
    );

    const withAuth = insertAtMarker(rules, "rules", "match /users {}", {
      tag: "auth",
    });
    const withBoth = insertAtMarker(withAuth, "rules", "match /posts {}", {
      tag: "social",
    });

    assert.ok(withBoth.includes("match /users {}"));
    assert.ok(withBoth.includes("match /posts {}"));
  });

  it("adds imports after the last import and skips duplicates", () => {
    const file = "import { a } from 'a';\n\nexport const x = a;\n";
    const once = insertImport(file, "import { b } from 'b';");

    assert.match(once, /import \{ a \} from 'a';\nimport \{ b \} from 'b';/);
    assert.equal(insertImport(once, "import { b } from 'b';"), once);
  });

  it("registers a provider in both marker regions", () => {
    const result = registerProvider(providersFile, {
      import: "import { ThemeProvider } from '@/lib/theme';",
      component: "ThemeProvider",
    });

    assert.ok(result.includes("import { ThemeProvider } from '@/lib/theme';"));
    assert.ok(result.includes("ThemeProvider,"));
    assert.ok(hasMarker(result, "providers:list"));
  });

  it("strips tagged module blocks and unregisters providers", () => {
    const tagged = registerProvider(
      providersFile,
      {
        import: "import { ThemeProvider } from '@/lib/theme';",
        component: "ThemeProvider",
      },
      "theme",
    );
    assert.ok(tagged.includes("radiance:module:theme:start"));

    const stripped = stripModuleTag(tagged, "theme");
    assert.ok(!stripped.includes("ThemeProvider,"));

    const cleared = unregisterProvider(
      tagged,
      {
        import: "import { ThemeProvider } from '@/lib/theme';",
        component: "ThemeProvider",
      },
      "theme",
    );
    assert.ok(!cleared.includes("ThemeProvider"));
  });

  it("keeps the same module tag in different marker regions", () => {
    const config = [
      "ios: {",
      "  // radiance:ios:start",
      "  // radiance:ios:end",
      "},",
      "plugins: [",
      "  // radiance:plugins:start",
      "  // radiance:plugins:end",
      "],",
    ].join("\n");

    const withIos = insertAtMarker(
      config,
      "ios",
      "config: { googleMapsApiKey: 'k' },",
      { tag: "maps" },
    );
    const withBoth = insertAtMarker(withIos, "plugins", "['expo-location'],", {
      tag: "maps",
    });

    assert.ok(withBoth.includes("googleMapsApiKey"));
    assert.ok(withBoth.includes("expo-location"));
    assert.equal(withBoth.match(/radiance:module:maps:start/g)?.length, 2);
  });
});

describe("merge", () => {
  it("keeps translations the user has reworded", () => {
    const { merged, conflicts } = mergeLocales(
      { auth: { signIn: "Log in", title: "Welcome" } },
      { auth: { signIn: "Sign in", signUp: "Sign up" } },
    );

    assert.deepEqual(merged, {
      auth: { signIn: "Log in", title: "Welcome", signUp: "Sign up" },
    });
    assert.deepEqual(conflicts, ["auth.signIn"]);
  });

  it("reports dependency version conflicts without overwriting", () => {
    const { merged, versionConflicts } = mergePackageJson(
      {
        dependencies: { firebase: "^12.0.0" },
        scripts: { start: "expo start" },
      },
      {
        dependencies: { firebase: "^12.17.1", zustand: "^5.0.14" },
        scripts: { start: "other", lint: "eslint ." },
      },
    );

    assert.deepEqual(versionConflicts, [
      { name: "firebase", existing: "^12.0.0", requested: "^12.17.1" },
    ]);
    assert.deepEqual(merged.dependencies, {
      firebase: "^12.0.0",
      zustand: "^5.0.14",
    });
    // Existing scripts win; new ones are added.
    assert.deepEqual(merged.scripts, { start: "expo start", lint: "eslint ." });
  });

  it("merges objects deeply and arrays without duplicates", () => {
    const merged = deepMerge(
      { emulators: { auth: { port: 9099 } }, targets: ["a"] },
      { emulators: { firestore: { port: 8080 } }, targets: ["a", "b"] },
    );

    assert.deepEqual(merged, {
      emulators: { auth: { port: 9099 }, firestore: { port: 8080 } },
      targets: ["a", "b"],
    });
  });

  it("unions firestore indexes by content", () => {
    const index = { collectionGroup: "posts", fields: [] };
    const merged = mergeIndexes({ indexes: [index] }, { indexes: [index] });

    assert.deepEqual(merged, { indexes: [index], fieldOverrides: [] });
  });

  it("appends env variables once", () => {
    const first = appendEnvExample("EXISTING=\n", "app-check", {
      EXPO_PUBLIC_RECAPTCHA_KEY: "reCAPTCHA v3 site key",
    });

    assert.ok(first.includes("# app-check"));
    assert.ok(first.includes("EXPO_PUBLIC_RECAPTCHA_KEY="));
    assert.equal(
      appendEnvExample(first, "app-check", {
        EXPO_PUBLIC_RECAPTCHA_KEY: "reCAPTCHA v3 site key",
      }),
      first,
    );
  });
});

describe("workspace", () => {
  it("only reports edits that differ from disk", async () => {
    const workspace = new Workspace("/nowhere");

    await workspace.write("a.ts", "export const a = 1;\n", "test");
    const changes = workspace.changes();

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, "create");
    assert.deepEqual(changes[0]?.sources, ["test"]);
  });

  it("reads back staged content within a run", async () => {
    const workspace = new Workspace("/nowhere");

    await workspace.write("a.ts", "first", "one");
    await workspace.write(
      "a.ts",
      `${await workspace.read("a.ts")} + second`,
      "two",
    );

    assert.equal(await workspace.read("a.ts"), "first + second");
    assert.deepEqual(workspace.changes()[0]?.sources, ["one", "two"]);
  });

  it("ignores a delete for a file that was never there", async () => {
    const workspace = new Workspace("/nowhere");

    await workspace.remove("gone.ts", "test");

    assert.deepEqual(workspace.changes(), []);
  });
});

describe("remapStarterOverlayPath", () => {
  it("leaves tabs-shell paths unchanged", () => {
    assert.equal(
      remapStarterOverlayPath("app/(app)/(tabs)/index.tsx", "tabs"),
      "app/(app)/(tabs)/index.tsx",
    );
    assert.equal(
      remapStarterOverlayPath("app/(app)/(tabs)/index.tsx", undefined),
      "app/(app)/(tabs)/index.tsx",
    );
  });

  it("moves (tabs) screens into (drawer) for the drawer shell", () => {
    assert.equal(
      remapStarterOverlayPath("app/(app)/(tabs)/new-post.tsx", "drawer"),
      "app/(app)/(drawer)/new-post.tsx",
    );
  });

  it("flattens (tabs) screens for the stack shell", () => {
    assert.equal(
      remapStarterOverlayPath("app/(app)/(tabs)/profile.tsx", "stack"),
      "app/(app)/profile.tsx",
    );
  });

  it("does not rewrite non-tab overlay paths", () => {
    assert.equal(
      remapStarterOverlayPath("app/(app)/post/[postId].tsx", "drawer"),
      "app/(app)/post/[postId].tsx",
    );
    assert.equal(
      remapStarterOverlayPath("lib/registry/tabs.ts", "drawer"),
      "lib/registry/tabs.ts",
    );
  });
});
