import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySdkConfigToEnv } from "../src/commands/setup-firebase.js";
import {
  ensureGoogleApiEnabled,
  extractJsonObject,
  isApiNotEnabledError,
  isValidProjectId,
  suggestProjectId,
} from "../src/core/firebase-cli.js";

describe("extractJsonObject", () => {
  it("parses clean JSON", () => {
    assert.deepEqual(extractJsonObject('{"status":"success","result":1}'), {
      status: "success",
      result: 1,
    });
  });

  it("ignores trailing firebase-tools banners", () => {
    const raw = `{"status":"success","result":{"a":"b\\"c"}}\n┌──┐\n│ banner │\n└──┘\n`;
    assert.deepEqual(extractJsonObject(raw), {
      status: "success",
      result: { a: 'b"c' },
    });
  });
});

describe("project id helpers", () => {
  it("validates ids", () => {
    assert.equal(isValidProjectId("my-app-1a2b"), true);
    assert.equal(isValidProjectId("My-App"), false);
    assert.equal(isValidProjectId("ab"), false);
    assert.equal(isValidProjectId("1abcde"), false);
  });

  it("suggests a plausible id from an app name", () => {
    const id = suggestProjectId("Bare App!");
    assert.equal(isValidProjectId(id), true);
    assert.match(id, /^bare-app-/);
  });
});

describe("applySdkConfigToEnv", () => {
  it("fills EXPO_PUBLIC_FIREBASE_* keys from sdk config", () => {
    const example = [
      "EXPO_PUBLIC_FIREBASE_API_KEY=",
      "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=",
      "EXPO_PUBLIC_FIREBASE_PROJECT_ID=",
      "EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=",
      "EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=",
      "EXPO_PUBLIC_FIREBASE_APP_ID=",
      "EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID=",
      "EXPO_PUBLIC_USE_FIREBASE_EMULATORS=false",
      "",
    ].join("\n");

    const out = applySdkConfigToEnv(example, {
      apiKey: "k",
      authDomain: "p.firebaseapp.com",
      projectId: "p",
      storageBucket: "p.appspot.com",
      messagingSenderId: "1",
      appId: "1:1:web:abc",
      measurementId: "G-X",
    });

    assert.match(out, /^EXPO_PUBLIC_FIREBASE_API_KEY=k$/m);
    assert.match(out, /^EXPO_PUBLIC_FIREBASE_PROJECT_ID=p$/m);
    assert.match(out, /^EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID=G-X$/m);
    assert.match(out, /^EXPO_PUBLIC_USE_FIREBASE_EMULATORS=false$/m);
  });
});

describe("isApiNotEnabledError", () => {
  it("matches the fresh-project Firestore enablement error", () => {
    assert.equal(
      isApiNotEnabledError(
        "HTTP Error: 403, Cloud Firestore API has not been used in project bare-app-k00w before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=bare-app-k00w",
      ),
      true,
    );
  });

  it("does not match unrelated create failures", () => {
    assert.equal(
      isApiNotEnabledError("Error: Missing required flag --location"),
      false,
    );
  });
});

describe("ensureGoogleApiEnabled", () => {
  it("returns already-enabled when Service Usage reports ENABLED", async () => {
    const calls: string[] = [];
    const result = await ensureGoogleApiEnabled(
      "proj-1",
      "firestore.googleapis.com",
      {
        getAccessToken: async () => "token",
        sleep: async () => {
          throw new Error("should not sleep");
        },
        fetchImpl: async (input) => {
          calls.push(String(input));
          return new Response(JSON.stringify({ state: "ENABLED" }), {
            status: 200,
          });
        },
      },
    );
    assert.equal(result, "already-enabled");
    assert.equal(calls.length, 1);
    assert.match(
      calls[0]!,
      /\/v1\/projects\/proj-1\/services\/firestore\.googleapis\.com$/,
    );
  });

  it("enables then polls until ENABLED", async () => {
    const waits: number[] = [];
    let checks = 0;
    const result = await ensureGoogleApiEnabled(
      "proj-2",
      "firestore.googleapis.com",
      {
        getAccessToken: async () => "token",
        pollIntervalMs: 10,
        maxPolls: 5,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith(":enable")) {
            assert.equal(init?.method, "POST");
            return new Response("{}", { status: 200 });
          }
          checks += 1;
          // 1 = initial miss, 2 = first post-enable poll miss, 3 = enabled
          return new Response(
            JSON.stringify({ state: checks >= 3 ? "ENABLED" : "DISABLED" }),
            {
              status: 200,
            },
          );
        },
      },
    );
    assert.equal(result, "enabled");
    assert.deepEqual(waits, [10]);
    assert.equal(checks, 3);
  });
});

import {
  authChoicesToProviderIds,
  buildAuthProvidersConfig,
  unsupportedAuthProviders,
} from "../src/core/firebase-auth.js";

describe("auth provider mapping", () => {
  it("maps radiance choices to identity toolkit ids", () => {
    assert.deepEqual(
      authChoicesToProviderIds(["email", "google", "anonymous"]),
      ["password", "google.com", "anonymous"],
    );
  });

  it("builds firebase.json auth.providers for CLI deploy", () => {
    assert.deepEqual(
      buildAuthProvidersConfig(["password", "anonymous", "google.com"], {
        displayName: "Demo",
        supportEmail: "dev@example.com",
      }),
      {
        providers: {
          emailPassword: true,
          anonymous: true,
          googleSignIn: {
            oAuthBrandDisplayName: "Demo",
            supportEmail: "dev@example.com",
          },
        },
      },
    );
  });

  it("omits googleSignIn until a support email is available", () => {
    const config = buildAuthProvidersConfig(["password", "google.com"], {
      displayName: "Demo",
    });
    assert.deepEqual(config, { providers: { emailPassword: true } });
  });

  it("flags apple as unsupported by firebase deploy --only auth", () => {
    assert.deepEqual(unsupportedAuthProviders(["password", "apple.com"]), [
      "apple.com",
    ]);
  });
});
