import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ensurePromptStarter,
  GENERIC_STARTER,
} from "../src/harness/init-interview.js";

type Plan = Parameters<typeof ensurePromptStarter>[0];
type Registry = Parameters<typeof ensurePromptStarter>[1];

const registry = {
  starters: [
    {
      id: "habits",
      title: "Habits",
      description: "Daily habit tracking with streaks.",
      capabilities: ["habits", "streaks"],
      modules: [],
    },
    {
      id: GENERIC_STARTER,
      title: "Productivity",
      description: "Projects and tasks with comments.",
      capabilities: ["projects", "tasks"],
      modules: [],
    },
  ],
  modules: [],
} as unknown as Registry;

const plan = (starterId: string | null | undefined) =>
  ({ starterId, options: {} }) as unknown as Plan;

describe("ensurePromptStarter", () => {
  it("never leaves a description on the bare scaffold", () => {
    const next = ensurePromptStarter(
      plan(null),
      registry,
      "a recipe box for my dinners",
    );
    assert.equal(next.starterId, GENERIC_STARTER);
  });

  it("prefers the closest keyword match over the generic default", () => {
    const next = ensurePromptStarter(
      plan(undefined),
      registry,
      "track my reading streaks",
    );
    assert.equal(next.starterId, "habits");
  });

  it("keeps a starter that was already chosen", () => {
    const next = ensurePromptStarter(
      plan("habits"),
      registry,
      "projects and tasks",
    );
    assert.equal(next.starterId, "habits");
  });
});
