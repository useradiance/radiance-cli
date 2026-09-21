import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assertRequiredConfig,
  missingRequiredKeys,
  requirementsFromFeatures,
} from "../src/core/config-gate.js";
import { RadianceError } from "../src/core/logger.js";
import type { ProjectConfig } from "../src/core/project.js";
import { ModuleManifestSchema } from "../src/core/registry.js";

const emptyProject = (): ProjectConfig => ({
  name: "Test",
  template: null,
  templateVersion: null,
  registryVersion: "0.0.0",
  scaffold: { id: "expo-app", version: "0.0.0" },
  themePack: "neutral",
  defaultLocale: "en",
  locales: ["en"],
  bundleId: "com.test.app",
  scheme: "test",
  features: [],
  harness: {},
});

describe("requirementsFromFeatures", () => {
  it("collects required env, params, and secrets (deduped)", () => {
    const email = ModuleManifestSchema.parse({
      id: "email",
      version: "0.1.0",
      title: "Email",
      description: "Email",
      secrets: {
        RESEND_API_KEY: { description: "Resend", required: true },
      },
      params: {
        EMAIL_FROM: { description: "From", required: true },
      },
    });
    const stripe = ModuleManifestSchema.parse({
      id: "stripe",
      version: "0.1.0",
      title: "Stripe",
      description: "Stripe",
      env: {
        EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: {
          description: "pk",
          required: true,
        },
      },
      secrets: {
        STRIPE_SECRET_KEY: { description: "sk", required: true },
        STRIPE_WEBHOOK_SECRET: { description: "whsec", required: true },
      },
    });
    const subscriptions = ModuleManifestSchema.parse({
      id: "subscriptions",
      version: "0.1.0",
      title: "Subs",
      description: "Subs",
      secrets: {
        STRIPE_SECRET_KEY: { description: "sk again", required: true },
      },
    });

    const required = requirementsFromFeatures([
      { id: "email", manifest: email, options: {} },
      { id: "stripe", manifest: stripe, options: {} },
      { id: "subscriptions", manifest: subscriptions, options: {} },
    ]);

    assert.deepEqual(
      required.env.map((item) => item.key),
      ["EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY"],
    );
    assert.deepEqual(
      required.params.map((item) => item.key),
      ["EMAIL_FROM"],
    );
    assert.deepEqual(
      required.secrets.map((item) => item.key).sort(),
      ["RESEND_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"].sort(),
    );
  });
});

describe("missingRequiredKeys", () => {
  it("treats blank values as missing", () => {
    const missing = missingRequiredKeys(
      [
        {
          key: "A",
          moduleId: "m",
          description: "a",
          kind: "env",
        },
        {
          key: "B",
          moduleId: "m",
          description: "b",
          kind: "env",
        },
      ],
      { A: "ok", B: "  " },
    );
    assert.deepEqual(
      missing.map((item) => item.key),
      ["B"],
    );
  });
});

describe("assertRequiredConfig", () => {
  it("passes when injected requirements are satisfied", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-gate-ok-"));
    await writeFile(
      join(root, ".env"),
      "EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test\n",
      "utf8",
    );
    await mkdir(join(root, "functions"), { recursive: true });
    await writeFile(
      join(root, "functions", ".env"),
      "EMAIL_FROM=hi@example.com\n",
      "utf8",
    );
    await writeFile(
      join(root, "functions", ".secret.local"),
      "RESEND_API_KEY=re_test\n",
      "utf8",
    );

    await assertRequiredConfig(root, emptyProject(), {
      clientEnv: true,
      params: true,
      secrets: "local",
      requirements: {
        env: [
          {
            key: "EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY",
            moduleId: "stripe",
            description: "pk",
            kind: "env",
          },
        ],
        params: [
          {
            key: "EMAIL_FROM",
            moduleId: "email",
            description: "from",
            kind: "param",
          },
        ],
        secrets: [
          {
            key: "RESEND_API_KEY",
            moduleId: "email",
            description: "key",
            kind: "secret",
          },
        ],
      },
    });
  });

  it("fails when client env is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-gate-env-"));
    await assert.rejects(
      () =>
        assertRequiredConfig(root, emptyProject(), {
          clientEnv: true,
          params: false,
          secrets: false,
          requirements: {
            env: [
              {
                key: "EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY",
                moduleId: "stripe",
                description: "pk",
                kind: "env",
              },
            ],
            params: [],
            secrets: [],
          },
        }),
      (error: unknown) =>
        error instanceof RadianceError &&
        error.message.includes("incomplete") &&
        Boolean(error.hint?.includes("EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY")),
    );
  });

  it("fails when local secrets are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-gate-sec-"));
    await mkdir(join(root, "functions"), { recursive: true });
    await assert.rejects(
      () =>
        assertRequiredConfig(root, emptyProject(), {
          clientEnv: false,
          params: false,
          secrets: "local",
          requirements: {
            env: [],
            params: [],
            secrets: [
              {
                key: "STRIPE_SECRET_KEY",
                moduleId: "stripe",
                description: "sk",
                kind: "secret",
              },
            ],
          },
        }),
      (error: unknown) =>
        error instanceof RadianceError &&
        Boolean(error.hint?.includes("STRIPE_SECRET_KEY")),
    );
  });
});
