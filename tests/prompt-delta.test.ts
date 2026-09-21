import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computePromptDelta } from "../src/harness/prompt-delta.js";
import { emptyPlan } from "../src/harness/init-slots.js";
import type { Registry } from "../src/core/registry.js";

function registry(): Registry {
  return {
    version: "0.0.0",
    scaffold: {
      id: "expo-app",
      path: "scaffold/expo-app",
      version: "0.1.0",
      requiredModules: ["i18n", "theme"],
      capabilities: [],
    },
    starters: [
      {
        id: "social-app",
        path: "starters/social-app",
        version: "0.2.0",
        title: "Social app",
        description:
          "Social feed with accounts, image posts, likes and profiles.",
        modules: [
          "i18n",
          "theme",
          "navigation",
          "firestore",
          "forms",
          "auth",
          "storage",
          "callable-client",
          "functions",
          "analytics",
          "hosting",
        ],
        capabilities: [
          "social-feed",
          "posts",
          "likes",
          "profiles",
          "image-posts",
          "timeline",
        ],
        defaults: { themePack: "branded" },
      },
    ],
    modules: [
      {
        id: "maps",
        path: "modules/maps",
        version: "0.1.0",
        title: "Maps",
        description: "Maps and location helpers",
        side: "app",
        capabilities: ["maps", "location", "geolocation", "nearby"],
        requires: [],
      },
      {
        id: "storage",
        path: "modules/storage",
        version: "0.1.0",
        title: "Storage",
        description: "File uploads",
        side: "app",
        capabilities: ["storage", "image-upload", "photos"],
        requires: ["auth"],
      },
      {
        id: "functions",
        path: "modules/functions",
        version: "0.1.0",
        title: "Functions",
        description: "Cloud Functions",
        side: "functions",
        capabilities: ["cloud-functions"],
        requires: [],
      },
    ],
  } as unknown as Registry;
}

describe("computePromptDelta", () => {
  it("adds maps and paid plan for a geo social photo app", () => {
    const plan = {
      ...emptyPlan(),
      starterId: "social-app",
    };
    const utterance =
      "I want a social media app where people can share photos with people geographically close to them, and those photos can have likes and comments";

    const delta = computePromptDelta(utterance, plan, registry());

    assert.ok(delta.extraModules.includes("maps"));
    assert.equal(delta.suggestedPlan, "paid");
    assert.ok(
      delta.promptGaps.some((gap) => /geograph|nearby|proximity/i.test(gap)),
    );
    assert.ok(delta.promptGaps.some((gap) => /comment/i.test(gap)));
    assert.ok(delta.followUpPrompt);
    assert.match(delta.followUpPrompt!, /comments/i);
  });

  it("does not re-add modules already on the starter", () => {
    const plan = { ...emptyPlan(), starterId: "social-app" };
    const delta = computePromptDelta(
      "a social feed with photo uploads",
      plan,
      registry(),
    );
    assert.equal(delta.extraModules.includes("storage"), false);
    assert.equal(delta.suggestedPlan, "paid");
  });

  it("appends a style-first visual tune when the utterance names a vibe", () => {
    const plan = { ...emptyPlan(), starterId: "social-app" };
    const utterance =
      "A calm premium social photo app with comments and a nearby feed for people close to me";

    const delta = computePromptDelta(utterance, plan, registry());

    assert.ok(delta.followUpPrompt);
    assert.match(delta.followUpPrompt!, /comments/i);
    assert.match(delta.followUpPrompt!, /Edit theme pack\/tokens first/i);
    assert.match(delta.followUpPrompt!, /calm|premium/i);
    assert.match(delta.followUpPrompt!, /do not redesign the starter/i);
  });

  it("captures a named product reference as the vibe hint", () => {
    const plan = { ...emptyPlan(), starterId: "social-app" };
    const utterance =
      "A social photo app like Linear with comments for people nearby";

    const delta = computePromptDelta(utterance, plan, registry());

    assert.ok(delta.followUpPrompt);
    assert.match(delta.followUpPrompt!, /like Linear/i);
    assert.match(delta.followUpPrompt!, /Edit theme pack\/tokens first/i);
  });

  it("does not invent a polish-only follow-up when there are no product gaps", () => {
    const plan = {
      ...emptyPlan(),
      starterId: "social-app",
      themeDescription: "calm premium teal",
    };
    const delta = computePromptDelta(
      "a simple social feed with likes",
      plan,
      registry(),
    );
    assert.equal(delta.followUpPrompt, undefined);
  });
});
