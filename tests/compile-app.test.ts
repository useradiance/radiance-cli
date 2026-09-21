import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RadianceError } from "../src/core/logger.js";
import {
  androidSdkRoot,
  defaultCompilePlatforms,
  ensureCompileGoogleServices,
  findIosWorkspace,
  iosSchemeFromWorkspace,
  parsePlatforms,
  resolveCompilePlatforms,
} from "../src/core/compile-app.js";

describe("parsePlatforms", () => {
  it("treats empty as defaults", () => {
    assert.equal(parsePlatforms(undefined), undefined);
    assert.equal(parsePlatforms(""), undefined);
    assert.equal(parsePlatforms("  "), undefined);
  });

  it("parses a comma-separated list", () => {
    assert.deepEqual(parsePlatforms("web,ios"), ["web", "ios"]);
    assert.deepEqual(parsePlatforms(" Android ,WEB "), ["android", "web"]);
  });

  it("rejects unknown names", () => {
    assert.throws(() => parsePlatforms("web,macos"), RadianceError);
  });
});

describe("defaultCompilePlatforms", () => {
  it("always includes web", () => {
    assert.deepEqual(defaultCompilePlatforms({ platform: "linux", env: {} }), [
      "web",
    ]);
  });

  it("adds ios on darwin and android when the SDK is set", () => {
    assert.deepEqual(
      defaultCompilePlatforms({
        platform: "darwin",
        env: { ANDROID_HOME: "/sdk" },
      }),
      ["web", "ios", "android"],
    );
  });
});

describe("resolveCompilePlatforms", () => {
  it("fails forced ios off macOS", () => {
    assert.throws(
      () => resolveCompilePlatforms(["ios"], { platform: "linux", env: {} }),
      /iOS compile requires macOS/,
    );
  });

  it("fails forced android without an SDK", () => {
    assert.throws(
      () =>
        resolveCompilePlatforms(["android"], {
          platform: "darwin",
          env: {},
        }),
      /ANDROID_HOME/,
    );
  });

  it("accepts android when ANDROID_SDK_ROOT is set", () => {
    assert.deepEqual(
      resolveCompilePlatforms(["web", "android"], {
        platform: "linux",
        env: { ANDROID_SDK_ROOT: "/sdk" },
      }),
      ["web", "android"],
    );
  });
});

describe("androidSdkRoot", () => {
  it("prefers ANDROID_HOME", () => {
    assert.equal(
      androidSdkRoot({ ANDROID_HOME: "/home", ANDROID_SDK_ROOT: "/root" }),
      "/home",
    );
  });
});

describe("ensureCompileGoogleServices", () => {
  it("writes stubs using radiance.json bundleId", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-compile-gs-"));
    await writeFile(
      join(root, "radiance.json"),
      JSON.stringify({ bundleId: "com.example.app" }),
    );
    ensureCompileGoogleServices(root);
    const json = JSON.parse(
      readFileSync(join(root, "google-services.json"), "utf8"),
    ) as { client: { client_info: { android_client_info: { package_name: string } } }[] };
    assert.equal(
      json.client[0]?.client_info.android_client_info.package_name,
      "com.example.app",
    );
    assert.match(
      readFileSync(join(root, "GoogleService-Info.plist"), "utf8"),
      /com\.example\.app/,
    );
  });
});

describe("findIosWorkspace", () => {
  it("picks the app workspace, not Pods", async () => {
    const root = await mkdtemp(join(tmpdir(), "radiance-compile-ios-"));
    await mkdir(join(root, "ios", "Pods"), { recursive: true });
    await mkdir(join(root, "ios", "myapp.xcworkspace"));
    await mkdir(join(root, "ios", "Pods.xcworkspace"));
    await writeFile(join(root, "ios", "README"), "x");

    const workspace = findIosWorkspace(root);
    assert.equal(workspace, join(root, "ios", "myapp.xcworkspace"));
    assert.equal(iosSchemeFromWorkspace(workspace!), "myapp");
  });
});
