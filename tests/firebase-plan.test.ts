import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  applyPlanEmulatorEnv,
  parsePlanFlag,
  storageRulesFileForPlan,
} from "../src/commands/setup-firebase.js";
import {
  cloudProvisionTargets,
  deployTargetsForChangedPaths,
  firebaseDeploy,
  isRetryableFirebaseDeployFailure,
} from "../src/core/firebase-provision.js";
import { RadianceError } from "../src/core/logger.js";

const emulatorProductsUrl = pathToFileURL(
  join(
    process.cwd(),
    "..",
    "radiance-templates",
    "scaffold",
    "expo-app",
    "scripts",
    "emulator-products.mjs",
  ),
).href;

describe("parsePlanFlag", () => {
  it("accepts free/paid and legacy spark/blaze aliases", () => {
    assert.equal(parsePlanFlag("free"), "free");
    assert.equal(parsePlanFlag("paid"), "paid");
    assert.equal(parsePlanFlag("spark"), "free");
    assert.equal(parsePlanFlag("blaze"), "paid");
    assert.equal(parsePlanFlag(undefined), undefined);
  });
});

describe("storageRulesFileForPlan", () => {
  it("uses emulator rules on free when the storage module installed them", () => {
    assert.equal(
      storageRulesFileForPlan("free", {
        emulatorRules: true,
        cloudRules: true,
      }),
      "storage.emulator.rules",
    );
  });

  it("falls back to scaffold storage.rules when emulator rules are absent", () => {
    assert.equal(
      storageRulesFileForPlan("free", {
        emulatorRules: false,
        cloudRules: true,
      }),
      "storage.rules",
    );
  });

  it("returns null when neither rules file exists", () => {
    assert.equal(
      storageRulesFileForPlan("paid", {
        emulatorRules: false,
        cloudRules: false,
      }),
      null,
    );
  });
});

describe("applyPlanEmulatorEnv", () => {
  const base = [
    "EXPO_PUBLIC_USE_FIREBASE_EMULATORS=false",
    "EXPO_PUBLIC_EMULATOR_AUTH=true",
    "EXPO_PUBLIC_EMULATOR_FIRESTORE=true",
    "EXPO_PUBLIC_EMULATOR_FUNCTIONS=true",
    "EXPO_PUBLIC_EMULATOR_STORAGE=true",
    "",
  ].join("\n");

  it("enables storage+functions emulators on free while keeping auth/firestore on cloud", () => {
    const next = applyPlanEmulatorEnv(base, "free");
    assert.match(next, /^EXPO_PUBLIC_USE_FIREBASE_EMULATORS=true$/m);
    assert.match(next, /^EXPO_PUBLIC_EMULATOR_AUTH=false$/m);
    assert.match(next, /^EXPO_PUBLIC_EMULATOR_FIRESTORE=false$/m);
    assert.match(next, /^EXPO_PUBLIC_EMULATOR_FUNCTIONS=true$/m);
    assert.match(next, /^EXPO_PUBLIC_EMULATOR_STORAGE=true$/m);
  });

  it("turns the master emulator switch off on paid", () => {
    const next = applyPlanEmulatorEnv(base, "paid");
    assert.match(next, /^EXPO_PUBLIC_USE_FIREBASE_EMULATORS=false$/m);
  });
});

describe("scaffold resolveEmulatorProducts", () => {
  it("matches free-plan env: storage+functions only", async () => {
    const { parseEnvFile, resolveEmulatorProducts } = await import(
      emulatorProductsUrl
    );
    const freeEnv = applyPlanEmulatorEnv(
      [
        "EXPO_PUBLIC_USE_FIREBASE_EMULATORS=false",
        "EXPO_PUBLIC_EMULATOR_AUTH=true",
        "EXPO_PUBLIC_EMULATOR_FIRESTORE=true",
        "EXPO_PUBLIC_EMULATOR_FUNCTIONS=true",
        "EXPO_PUBLIC_EMULATOR_STORAGE=true",
        "",
      ].join("\n"),
      "free",
    );
    const products = resolveEmulatorProducts(parseEnvFile(freeEnv));
    assert.deepEqual(products, ["functions", "storage"]);
  });

  it("returns no products when the master switch is off", async () => {
    const { resolveEmulatorProducts } = await import(emulatorProductsUrl);
    assert.deepEqual(
      resolveEmulatorProducts({
        EXPO_PUBLIC_USE_FIREBASE_EMULATORS: "false",
        EXPO_PUBLIC_EMULATOR_STORAGE: "true",
      }),
      [],
    );
  });

  it("reports missing Storage rules files so start can skip the emulator", async () => {
    const { storageEmulatorRulesExist } = await import(emulatorProductsUrl);
    const missing = await mkdtemp(join(tmpdir(), "radiance-storage-rules-"));
    assert.equal(
      storageEmulatorRulesExist(missing, {
        storage: { rules: "storage.emulator.rules" },
      }),
      false,
    );
    await writeFile(
      join(missing, "storage.rules"),
      'rules_version = "2";\n',
    );
    assert.equal(
      storageEmulatorRulesExist(missing, { storage: { rules: "storage.rules" } }),
      true,
    );
  });

  it("reads ports from firebase.json when present", async () => {
    const { resolveEmulatorPorts } = await import(emulatorProductsUrl);
    assert.deepEqual(
      resolveEmulatorPorts(
        { emulators: { storage: { port: 9199 }, functions: { port: 5001 } } },
        ["storage", "functions"],
      ),
      { storage: 9199, functions: 5001 },
    );
  });
});

describe("cloudProvisionTargets", () => {
  it("includes storage only on paid when storage.rules exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-plan-"));
    await writeFile(join(root, "firestore.rules"), 'rules_version = "2";\n');
    await writeFile(join(root, "storage.rules"), 'rules_version = "2";\n');

    const authJson = { auth: { providers: { emailPassword: true } } };
    assert.deepEqual(cloudProvisionTargets(root, "free", authJson), [
      "firestore",
      "auth",
    ]);
    assert.deepEqual(cloudProvisionTargets(root, "paid", authJson), [
      "firestore",
      "storage",
      "auth",
    ]);
  });

  it("omits auth when providers are empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-plan-"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "firestore.rules"), 'rules_version = "2";\n');
    assert.deepEqual(cloudProvisionTargets(root, "free", {}), ["firestore"]);
  });
});

describe("isRetryableFirebaseDeployFailure", () => {
  it("matches the firebaserules 403 from fresh projects", () => {
    const output =
      "Error: Request to https://firebaserules.googleapis.com/v1/projects/bare-app-6kr7:test had HTTP Error: 403, The caller does not have permission";
    assert.equal(isRetryableFirebaseDeployFailure(output), true);
  });

  it("matches API-not-enabled style errors", () => {
    assert.equal(
      isRetryableFirebaseDeployFailure(
        "Cloud Firestore API has not been used in project foo before or it is disabled",
      ),
      true,
    );
  });

  it("matches missing default database 404s on fresh projects", () => {
    assert.equal(
      isRetryableFirebaseDeployFailure(
        "Error: Request to https://firestore.googleapis.com/v1/projects/bare-app-97os/databases/(default)/collectionGroups/-/indexes had HTTP Error: 404, Project 'bare-app-97os' or database '(default)' does not exist.",
      ),
      true,
    );
  });

  it("does not match unrelated failures", () => {
    assert.equal(
      isRetryableFirebaseDeployFailure(
        "Error: Compilation error in firestore.rules",
      ),
      false,
    );
  });
});

describe("firebaseDeploy retries", () => {
  it("does not wait by default before the first attempt", async () => {
    const waits: number[] = [];
    let calls = 0;
    await firebaseDeploy("/tmp", ["firestore"], {
      maxAttempts: 1,
      sleep: async (ms) => {
        waits.push(ms);
      },
      run: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "Deploy complete!", stderr: "" };
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  });

  it("waits when initialDelayMs is set (first-time provision)", async () => {
    const waits: number[] = [];
    let calls = 0;
    await firebaseDeploy("/tmp", ["firestore"], {
      maxAttempts: 1,
      initialDelayMs: 5_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
      run: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "Deploy complete!", stderr: "" };
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(waits, [5_000]);
  });

  it("retries retryable failures then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    await firebaseDeploy("/tmp", ["firestore"], {
      maxAttempts: 3,
      initialDelayMs: 0,
      backoffMs: [10, 20],
      sleep: async (ms) => {
        waits.push(ms);
      },
      run: async () => {
        calls += 1;
        if (calls < 3) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "HTTP Error: 403, The caller does not have permission",
          };
        }
        return { exitCode: 0, stdout: "Deploy complete!", stderr: "" };
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [10, 20]);
  });

  it("does not retry non-retryable failures", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        firebaseDeploy("/tmp", ["firestore"], {
          maxAttempts: 5,
          initialDelayMs: 0,
          sleep: async () => {
            throw new Error("should not sleep");
          },
          run: async () => {
            calls += 1;
            return {
              exitCode: 1,
              stdout: "",
              stderr: "Compilation error in firestore.rules",
            };
          },
        }),
      (error: unknown) =>
        error instanceof RadianceError &&
        error.message === "firebase deploy failed",
    );
    assert.equal(calls, 1);
  });
});

describe("deployTargetsForChangedPaths", () => {
  it("maps rules and indexes to firestore", () => {
    assert.deepEqual(
      deployTargetsForChangedPaths(
        ["firestore.rules", "app/index.tsx"],
        "free",
      ),
      { targets: ["firestore"], skipped: [] },
    );
    assert.deepEqual(
      deployTargetsForChangedPaths(["firestore.indexes.json"], "paid"),
      { targets: ["firestore"], skipped: [] },
    );
  });

  it("skips paid-only targets on the free plan", () => {
    assert.deepEqual(
      deployTargetsForChangedPaths(
        ["storage.rules", "functions/src/index.ts", "firestore.rules"],
        "free",
      ),
      { targets: ["firestore"], skipped: ["storage", "functions"] },
    );
    assert.deepEqual(
      deployTargetsForChangedPaths(
        ["storage.rules", "functions/src/index.ts"],
        "paid",
      ),
      { targets: ["storage", "functions"], skipped: [] },
    );
  });

  it("ignores unrelated paths", () => {
    assert.deepEqual(
      deployTargetsForChangedPaths(["app/(app)/index.tsx"], "paid"),
      {
        targets: [],
        skipped: [],
      },
    );
  });
});
