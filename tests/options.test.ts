import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectOptionEffects,
  optionBooleans,
  optionIncludes,
  parseOptionFlags,
  validateOptionValue,
} from "../src/core/options.js";
import {
  ModuleManifestSchema,
  type ModuleManifest,
} from "../src/core/registry.js";
import { RadianceError } from "../src/core/logger.js";

const authManifest = (): ModuleManifest =>
  ModuleManifestSchema.parse({
    id: "auth",
    version: "0.1.0",
    title: "Authentication",
    description: "Auth",
    options: {
      providers: {
        type: "multi",
        choices: ["email", "google", "apple"],
        default: ["email", "google", "apple"],
        min: 1,
      },
    },
    optionBindings: {
      providers: {
        email: { firebase: { authProviders: ["password"] } },
        google: {
          dependencies: { "expo-auth-session": "~57.0.6" },
          env: { EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: "web client" },
          firebase: { authProviders: ["google.com"] },
          files: "variants/google",
        },
        apple: {
          dependencies: { "expo-apple-authentication": "~57.0.1" },
          firebase: { authProviders: ["apple.com"] },
          files: "variants/apple",
        },
      },
    },
  });

describe("option flags", () => {
  it("parses scoped and unscoped flags", () => {
    assert.deepEqual(
      parseOptionFlags(["providers=email,google", "auth.providers=apple"]),
      [
        { key: "providers", raw: "email,google" },
        { moduleId: "auth", key: "providers", raw: "apple" },
      ],
    );
  });

  it("rejects malformed flags", () => {
    assert.throws(() => parseOptionFlags(["providers"]), RadianceError);
  });
});

describe("option validation", () => {
  it("accepts a valid multi selection", () => {
    const def = authManifest().options.providers!;
    validateOptionValue("providers", def, ["email", "google"]);
  });

  it("rejects unknown choices and empty multi selections", () => {
    const def = authManifest().options.providers!;
    assert.throws(
      () => validateOptionValue("providers", def, ["sms"]),
      RadianceError,
    );
    assert.throws(
      () => validateOptionValue("providers", def, []),
      RadianceError,
    );
  });
});

describe("option bindings", () => {
  it("collects only the selected providers’ effects", () => {
    const effects = collectOptionEffects(authManifest(), {
      providers: ["email", "google"],
    });

    assert.deepEqual(effects.authProviders, ["password", "google.com"]);
    assert.equal(effects.dependencies["expo-auth-session"], "~57.0.6");
    assert.equal(effects.dependencies["expo-apple-authentication"], undefined);
    assert.deepEqual(effects.files, ["variants/google"]);
    assert.ok(effects.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID);
  });

  it("builds true/false placeholders for every choice", () => {
    const placeholders = optionBooleans(authManifest(), {
      providers: ["email"],
    });

    assert.equal(placeholders["option.providers.email"], "true");
    assert.equal(placeholders["option.providers.google"], "false");
    assert.equal(placeholders["option.providers.apple"], "false");
    assert.equal(
      optionIncludes({ providers: ["email"] }, "providers", "email"),
      true,
    );
    assert.equal(
      optionIncludes({ providers: ["email"] }, "providers", "google"),
      false,
    );
  });
});
