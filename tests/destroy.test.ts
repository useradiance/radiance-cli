import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  clearFirebaseEnvValues,
  coerceDestroyTargets,
  DESTROY_SELECT_ALL,
  expandDestroySelection,
  placeholderFirebaserc,
  restoreEasProjectIds,
  targetsFromFlags,
} from "../src/commands/destroy.js";
import {
  assertSafeToDeleteDirectory,
  isPlaceholderProjectId,
  resolveLinkedFirebaseProjectId,
} from "../src/core/firebase-cli.js";

describe("coerceDestroyTargets", () => {
  it("drops hosting/functions/firestore when firebase-project is selected", () => {
    assert.deepEqual(
      coerceDestroyTargets([
        "hosting",
        "firebase-project",
        "unlink",
        "functions",
        "local",
      ]),
      ["firebase-project", "unlink", "local"],
    );
  });

  it("preserves stable order without firebase-project", () => {
    assert.deepEqual(
      coerceDestroyTargets(["local", "unlink", "firestore", "hosting"]),
      ["hosting", "firestore", "unlink", "local"],
    );
  });
});

describe("expandDestroySelection", () => {
  const available = [
    "firebase-project",
    "hosting",
    "functions",
    "firestore",
    "unlink",
    "local",
  ] as const;

  it("expands Select all to every available target (coerced)", () => {
    assert.deepEqual(
      expandDestroySelection([DESTROY_SELECT_ALL], [...available]),
      ["firebase-project", "unlink", "local"],
    );
  });

  it("expands Select all even when mixed with other checks", () => {
    assert.deepEqual(
      expandDestroySelection([DESTROY_SELECT_ALL, "local"], [...available]),
      ["firebase-project", "unlink", "local"],
    );
  });

  it("ignores Select all sentinel when not chosen", () => {
    assert.deepEqual(
      expandDestroySelection(["hosting", "unlink"], [...available]),
      ["hosting", "unlink"],
    );
  });
});

describe("targetsFromFlags", () => {
  it("maps flags through coerceDestroyTargets", () => {
    assert.deepEqual(
      targetsFromFlags({
        firebaseProject: true,
        hosting: true,
        unlink: true,
        local: true,
      }),
      ["firebase-project", "unlink", "local"],
    );
  });

  it("returns empty when no flags are set", () => {
    assert.deepEqual(targetsFromFlags({}), []);
  });
});

describe("clearFirebaseEnvValues", () => {
  it("clears Firebase keys and keeps other lines", () => {
    const input = [
      "EXPO_PUBLIC_FIREBASE_API_KEY=abc",
      "EXPO_PUBLIC_FIREBASE_PROJECT_ID=my-app",
      "FIREBASE_ANDROID_APP_ID=1:1:android:x",
      "FIREBASE_IOS_APP_ID=1:1:ios:y",
      "EXPO_PUBLIC_USE_FIREBASE_EMULATORS=true",
      "OTHER=1",
      "",
    ].join("\n");

    const out = clearFirebaseEnvValues(input);
    assert.match(out, /^EXPO_PUBLIC_FIREBASE_API_KEY=$/m);
    assert.match(out, /^EXPO_PUBLIC_FIREBASE_PROJECT_ID=$/m);
    assert.match(out, /^FIREBASE_ANDROID_APP_ID=$/m);
    assert.match(out, /^FIREBASE_IOS_APP_ID=$/m);
    assert.match(out, /^EXPO_PUBLIC_USE_FIREBASE_EMULATORS=true$/m);
    assert.match(out, /^OTHER=1$/m);
  });
});

describe("restoreEasProjectIds", () => {
  it("restores staging and prod placeholders from profile context", () => {
    const input = `{
  "build": {
    "development": {
      "env": {
        "EXPO_PUBLIC_FIREBASE_PROJECT_ID": "demo-abc1"
      }
    },
    "production": {
      "env": {
        "EXPO_PUBLIC_FIREBASE_PROJECT_ID": "demo-abc1"
      }
    }
  }
}
`;
    const out = restoreEasProjectIds(input, "demo-abc1");
    assert.match(out, /development[\s\S]*radiance-staging-placeholder/);
    assert.match(out, /production[\s\S]*radiance-prod-placeholder/);
    assert.equal(out.includes("demo-abc1"), false);
  });
});

describe("placeholderFirebaserc", () => {
  it("matches scaffold placeholders", () => {
    const parsed = JSON.parse(placeholderFirebaserc()) as {
      projects: Record<string, string>;
    };
    assert.equal(parsed.projects.default, "radiance-staging-placeholder");
    assert.equal(parsed.projects.prod, "radiance-prod-placeholder");
  });
});

describe("isPlaceholderProjectId", () => {
  it("detects scaffold placeholders", () => {
    assert.equal(isPlaceholderProjectId("radiance-staging-placeholder"), true);
    assert.equal(isPlaceholderProjectId("my-real-app"), false);
  });
});

describe("resolveLinkedFirebaseProjectId", () => {
  it("reads default alias from .firebaserc", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-destroy-"));
    await writeFile(
      join(root, ".firebaserc"),
      JSON.stringify({ projects: { default: "demo-linked" } }),
      "utf8",
    );
    assert.equal(await resolveLinkedFirebaseProjectId(root), "demo-linked");
  });

  it("ignores placeholders and falls back to .env", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-destroy-"));
    await writeFile(
      join(root, ".firebaserc"),
      JSON.stringify({
        projects: {
          default: "radiance-staging-placeholder",
          staging: "radiance-staging-placeholder",
          prod: "radiance-prod-placeholder",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(root, ".env"),
      "EXPO_PUBLIC_FIREBASE_PROJECT_ID=from-env\n",
      "utf8",
    );
    assert.equal(await resolveLinkedFirebaseProjectId(root), "from-env");
  });

  it("returns null when nothing is linked", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-destroy-"));
    await mkdir(root, { recursive: true });
    assert.equal(await resolveLinkedFirebaseProjectId(root), null);
  });
});

describe("assertSafeToDeleteDirectory", () => {
  it("refuses home and root", async () => {
    const { homedir } = await import("node:os");
    assert.throws(() => assertSafeToDeleteDirectory("/"), /Refusing/);
    assert.throws(() => assertSafeToDeleteDirectory(homedir()), /Refusing/);
  });
});
