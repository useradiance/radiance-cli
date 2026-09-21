import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appendEnvExample } from "../src/core/apply/merge.js";
import { Workspace } from "../src/core/apply/workspace.js";
import {
  applyEnvValues,
  collectModuleEnv,
  collectModuleParams,
  collectModuleSecrets,
  envDescriptions,
  FUNCTIONS_ENV,
  FUNCTIONS_ENV_EXAMPLE,
  FUNCTIONS_SECRET_LOCAL,
  noteMissingSecrets,
  noteMissingRequiredEnv,
  noteSuspiciousClientEnv,
  parseEnvValues,
  upsertFunctionsFile,
} from "../src/core/env.js";
import {
  looksLikeServerSecret,
  ModuleManifestSchema,
  normalizeEnvEntry,
} from "../src/core/registry.js";

describe("env declarations", () => {
  it("normalizes string entries as non-prompting", () => {
    assert.deepEqual(normalizeEnvEntry("A description"), {
      description: "A description",
      required: false,
      prompt: false,
    });
  });

  it("defaults prompt to required when omitted", () => {
    assert.deepEqual(
      normalizeEnvEntry({ description: "Maps key", required: true }),
      { description: "Maps key", required: true, prompt: true },
    );
  });

  it("honors prompt: false on required keys (provisioned later)", () => {
    assert.deepEqual(
      normalizeEnvEntry({
        description: "web client",
        required: true,
        prompt: false,
      }),
      { description: "web client", required: true, prompt: false },
    );
  });

  it("parses object env on the module manifest", () => {
    const manifest = ModuleManifestSchema.parse({
      id: "maps",
      version: "0.1.1",
      title: "Maps",
      description: "Maps",
      env: {
        EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: {
          description: "Google Maps API key",
          required: true,
        },
        EXPO_PUBLIC_GOOGLE_MAPS_MAP_ID: "Optional map id",
      },
    });

    const mapsKey = normalizeEnvEntry(
      manifest.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? "missing",
    );
    assert.equal(mapsKey.description, "Google Maps API key");
    assert.equal(mapsKey.required, true);
    assert.equal(mapsKey.prompt, true);
    assert.equal(
      manifest.env.EXPO_PUBLIC_GOOGLE_MAPS_MAP_ID,
      "Optional map id",
    );
  });

  it("collects option-bound env as normalized defs", () => {
    const manifest = ModuleManifestSchema.parse({
      id: "auth",
      version: "0.1.0",
      title: "Auth",
      description: "Auth",
      options: {
        providers: {
          type: "multi",
          choices: ["email", "google"],
          default: ["email"],
          min: 1,
        },
      },
      optionBindings: {
        providers: {
          google: {
            env: {
              EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: {
                description: "web client",
                required: true,
                prompt: false,
              },
            },
          },
        },
      },
    });

    const env = collectModuleEnv(manifest, { providers: ["google"] });
    assert.deepEqual(env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, {
      description: "web client",
      required: true,
      prompt: false,
    });
  });

  it("does not warn on required keys that are not prompted (provisioned later)", () => {
    const workspace = new Workspace("/nowhere");
    noteMissingRequiredEnv(
      workspace,
      "auth",
      {
        EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: {
          description: "written by setup firebase",
          required: true,
          prompt: false,
        },
        EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: {
          description: "maps key",
          required: true,
          prompt: true,
        },
      },
      {},
    );

    const notes = workspace.getNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.message, /EXPO_PUBLIC_GOOGLE_MAPS_API_KEY/);
  });
});

describe("secrets and params", () => {
  it("parses secrets and params on the module manifest", () => {
    const manifest = ModuleManifestSchema.parse({
      id: "email",
      version: "0.1.0",
      title: "Email",
      description: "Email",
      secrets: {
        RESEND_API_KEY: {
          description: "Resend API key",
          required: true,
        },
      },
      params: {
        EMAIL_FROM: {
          description: "From address",
          required: true,
        },
      },
    });

    assert.deepEqual(collectModuleSecrets(manifest, {}), {
      RESEND_API_KEY: {
        description: "Resend API key",
        required: true,
        prompt: true,
      },
    });
    assert.deepEqual(collectModuleParams(manifest, {}), {
      EMAIL_FROM: {
        description: "From address",
        required: true,
        prompt: true,
      },
    });
  });

  it("rejects EXPO_PUBLIC_ keys on secrets and params", () => {
    assert.throws(
      () =>
        ModuleManifestSchema.parse({
          id: "bad",
          version: "0.1.0",
          title: "Bad",
          description: "Bad",
          secrets: {
            EXPO_PUBLIC_SECRET: { description: "nope", required: true },
          },
        }),
      /EXPO_PUBLIC_/,
    );

    assert.throws(
      () =>
        ModuleManifestSchema.parse({
          id: "bad",
          version: "0.1.0",
          title: "Bad",
          description: "Bad",
          params: {
            EXPO_PUBLIC_FROM: { description: "nope", required: true },
          },
        }),
      /EXPO_PUBLIC_/,
    );
  });

  it("merges option-bound secrets and params", () => {
    const manifest = ModuleManifestSchema.parse({
      id: "payments",
      version: "0.1.0",
      title: "Payments",
      description: "Payments",
      secrets: {
        STRIPE_SECRET_KEY: {
          description: "base secret",
          required: true,
        },
      },
      options: {
        provider: {
          type: "single",
          choices: ["stripe", "other"],
          default: "stripe",
        },
      },
      optionBindings: {
        provider: {
          stripe: {
            secrets: {
              STRIPE_WEBHOOK_SECRET: {
                description: "webhook",
                required: true,
              },
            },
            params: {
              STRIPE_PRICE_PRO: {
                description: "price id",
                required: false,
              },
            },
          },
        },
      },
    });

    const secrets = collectModuleSecrets(manifest, { provider: "stripe" });
    const params = collectModuleParams(manifest, { provider: "stripe" });

    assert.ok(secrets.STRIPE_SECRET_KEY);
    assert.ok(secrets.STRIPE_WEBHOOK_SECRET);
    assert.deepEqual(params.STRIPE_PRICE_PRO, {
      description: "price id",
      required: false,
      prompt: false,
    });
  });

  it("detects client env keys that look like server secrets", () => {
    assert.equal(looksLikeServerSecret("STRIPE_SECRET_KEY"), true);
    assert.equal(looksLikeServerSecret("RESEND_API_KEY"), true);
    assert.equal(looksLikeServerSecret("EXPO_PUBLIC_STRIPE_SECRET"), true);
    assert.equal(
      looksLikeServerSecret("EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY"),
      false,
    );
    assert.equal(looksLikeServerSecret("EXPO_PUBLIC_ALGOLIA_SEARCH_KEY"), false);
    assert.equal(looksLikeServerSecret("EXPO_PUBLIC_GOOGLE_MAPS_API_KEY"), false);
    assert.equal(looksLikeServerSecret("EXPO_PUBLIC_REVENUECAT_API_KEY"), false);
    assert.equal(looksLikeServerSecret("EXPO_PUBLIC_IOS_STORE_URL"), false);
  });

  it("notes suspicious client env keys", () => {
    const workspace = new Workspace("/nowhere");
    noteSuspiciousClientEnv(workspace, "stripe", {
      STRIPE_SECRET_KEY: {
        description: "should not be here",
        required: true,
        prompt: true,
      },
      EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: {
        description: "ok",
        required: true,
        prompt: true,
      },
    });

    const notes = workspace.getNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.message, /STRIPE_SECRET_KEY/);
  });

  it("notes production secrets:set even when local secret is set", () => {
    const workspace = new Workspace("/nowhere");
    noteMissingSecrets(
      workspace,
      "email",
      {
        RESEND_API_KEY: {
          description: "Resend",
          required: true,
          prompt: true,
        },
      },
      { RESEND_API_KEY: "re_test" },
    );

    const notes = workspace.getNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.message, /functions:secrets:set RESEND_API_KEY/);
  });
});

describe("functions config files", () => {
  it("appends params to functions/.env.example, not root .env.example", async () => {
    const workspace = new Workspace("/nowhere");
    const params = {
      EMAIL_FROM: { description: "From address", required: true, prompt: true },
    };

    await workspace.write(
      FUNCTIONS_ENV_EXAMPLE,
      appendEnvExample("", "email", params),
      "email",
    );
    await workspace.write(
      ".env.example",
      appendEnvExample("", "stripe", {
        EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: "publishable",
      }),
      "stripe",
    );

    const functionsExample = await workspace.read(FUNCTIONS_ENV_EXAMPLE);
    const rootExample = await workspace.read(".env.example");

    assert.ok(functionsExample?.includes("EMAIL_FROM="));
    assert.ok(!functionsExample?.includes("EXPO_PUBLIC_"));
    assert.ok(rootExample?.includes("EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY="));
    assert.ok(!rootExample?.includes("EMAIL_FROM"));
    assert.ok(!rootExample?.includes("RESEND_API_KEY"));
  });

  it("writes secrets to .secret.local without touching root .env", async () => {
    const workspace = new Workspace("/nowhere");
    await upsertFunctionsFile(
      workspace,
      FUNCTIONS_SECRET_LOCAL,
      { RESEND_API_KEY: "re_test" },
      "email",
    );
    await upsertFunctionsFile(
      workspace,
      FUNCTIONS_ENV,
      { EMAIL_FROM: "hi@example.com" },
      "email",
    );

    assert.match(
      (await workspace.read(FUNCTIONS_SECRET_LOCAL)) ?? "",
      /^RESEND_API_KEY=re_test$/m,
    );
    assert.match(
      (await workspace.read(FUNCTIONS_ENV)) ?? "",
      /^EMAIL_FROM=hi@example.com$/m,
    );
    assert.equal(await workspace.read(".env"), null);
    assert.equal(await workspace.read(".env.example"), null);
  });
});

describe("dotenv helpers", () => {
  it("parses and upserts env values", () => {
    const parsed = parseEnvValues("# comment\nFOO=bar\nBAZ=\n");
    assert.deepEqual(parsed, { FOO: "bar", BAZ: "" });

    const updated = applyEnvValues("FOO=bar\n", { FOO: "baz", NEW: "1" });
    assert.match(updated, /^FOO=baz$/m);
    assert.match(updated, /^NEW=1$/m);
  });

  it("extracts descriptions for .env.example", () => {
    assert.deepEqual(
      envDescriptions({
        A: "plain",
        B: { description: "object", required: true, prompt: true },
      }),
      { A: "plain", B: "object" },
    );
  });
});
