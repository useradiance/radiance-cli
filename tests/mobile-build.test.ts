import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveBuildPlatforms } from "../src/commands/build.js";
import { applyNativeAppIdsToEnv } from "../src/commands/setup-firebase.js";
import {
  defaultProfileForMode,
  findNativeBinaries,
  parseEasBuildIds,
  platformFromPath,
  resolveMobileDeploySelection,
} from "../src/core/mobile-build.js";

describe("resolveBuildPlatforms", () => {
  it("defaults to web + android + ios", () => {
    assert.deepEqual(resolveBuildPlatforms({}), ["web", "android", "ios"]);
  });

  it("respects explicit platform flags", () => {
    assert.deepEqual(resolveBuildPlatforms({ web: true }), ["web"]);
    assert.deepEqual(resolveBuildPlatforms({ android: true, ios: true }), [
      "android",
      "ios",
    ]);
  });
});

describe("resolveMobileDeploySelection", () => {
  it("allows backend-only deploy with no mobile flags", () => {
    assert.deepEqual(resolveMobileDeploySelection({}), {
      platforms: [],
      mode: null,
    });
  });

  it("requires a distribution mode when platforms are set", () => {
    const result = resolveMobileDeploySelection({ android: true });
    assert.equal(result.mode, null);
    assert.match(result.error ?? "", /Choose one distribution target/);
  });

  it("requires platforms when a distribution mode is set", () => {
    const result = resolveMobileDeploySelection({ appDistribution: true });
    assert.equal(result.platforms.length, 0);
    assert.match(result.error ?? "", /require `--android`/);
  });

  it("rejects multiple distribution modes", () => {
    const result = resolveMobileDeploySelection({
      android: true,
      appDistribution: true,
      eas: true,
    });
    assert.match(result.error ?? "", /only one of/);
  });

  it("accepts a single mode with platforms", () => {
    assert.deepEqual(
      resolveMobileDeploySelection({ ios: true, android: true, local: true }),
      { platforms: ["android", "ios"], mode: "local" },
    );
  });
});

describe("defaultProfileForMode", () => {
  it("uses production for eas submit unless overridden", () => {
    assert.equal(defaultProfileForMode("eas", true), "production");
    assert.equal(defaultProfileForMode("eas", false), "preview");
    assert.equal(defaultProfileForMode("app-distribution", false), "preview");
    assert.equal(defaultProfileForMode("eas", true, "staging"), "staging");
  });
});

describe("parseEasBuildIds", () => {
  it("parses a single build object", () => {
    assert.deepEqual(
      parseEasBuildIds('{"id":"abc-123","platform":"ANDROID"}'),
      ["abc-123"],
    );
  });

  it("parses an array of builds", () => {
    assert.deepEqual(parseEasBuildIds('[{"id":"a"},{"id":"b"}]'), ["a", "b"]);
  });

  it("returns empty on garbage", () => {
    assert.deepEqual(parseEasBuildIds("not json"), []);
  });
});

describe("platformFromPath", () => {
  it("maps extensions", () => {
    assert.equal(platformFromPath("/x/app.apk"), "android");
    assert.equal(platformFromPath("/x/app.aab"), "android");
    assert.equal(platformFromPath("/x/app.ipa"), "ios");
    assert.equal(platformFromPath("/x/app.zip"), null);
  });
});

describe("findNativeBinaries", () => {
  it("finds binaries in a directory and one nested level", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radiance-arts-"));
    await writeFile(join(dir, "app.apk"), "apk");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "app.ipa"), "ipa");

    const found = await findNativeBinaries(dir);
    const platforms = found.map((a) => a.platform).sort();
    assert.deepEqual(platforms, ["android", "ios"]);
  });
});

describe("applyNativeAppIdsToEnv", () => {
  it("writes FIREBASE_*_APP_ID keys", () => {
    const out = applyNativeAppIdsToEnv("FOO=1\n", {
      android: "1:1:android:abc",
      ios: "1:1:ios:def",
    });
    assert.match(out, /^FIREBASE_ANDROID_APP_ID=1:1:android:abc$/m);
    assert.match(out, /^FIREBASE_IOS_APP_ID=1:1:ios:def$/m);
    assert.match(out, /^FOO=1$/m);
  });
});
