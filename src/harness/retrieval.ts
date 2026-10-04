import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Registry } from "../core/registry.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "that",
  "this",
  "it",
  "is",
  "be",
  "can",
  "should",
  "add",
  "make",
  "let",
  "users",
  "user",
  "app",
  "screen",
  "page",
  "want",
  "need",
  "please",
  "my",
  "me",
  "i",
  "we",
  "so",
  "when",
  "then",
  "their",
  "them",
  "from",
  "each",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function singular(token: string): string {
  return token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
}

const SYNONYMS: Record<string, string[]> = {
  pay: ["stripe", "checkout", "payments"],
  payment: ["stripe", "checkout"],
  payments: ["stripe"],
  checkout: ["stripe"],
  photo: ["storage", "image"],
  picture: ["storage", "image"],
  image: ["storage"],
  avatar: ["storage"],
  upload: ["storage"],
  message: ["chat", "messaging"],
  messages: ["chat"],
  dm: ["chat"],
  inbox: ["chat"],
  map: ["maps"],
  maps: ["maps"],
  location: ["maps", "places"],
  nearby: ["places", "maps"],
  ticket: ["stripe"],
  tickets: ["stripe"],
  subscribe: ["subscriptions"],
  subscription: ["subscriptions"],
  billing: ["subscriptions", "stripe"],
  iap: ["iap"],
  purchase: ["iap", "stripe"],
  landing: ["landing"],
  marketing: ["landing"],
  homepage: ["landing"],
  onboarding: ["onboarding-flow"],
  welcome: ["onboarding-flow"],
  walkthrough: ["onboarding-flow"],
  cart: ["cart"],
  basket: ["cart"],
  admin: ["admin", "roles"],
  seed: ["demo-data"],
  demo: ["demo-data"],
};

function expandTokens(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const alias of SYNONYMS[token] ?? []) {
      expanded.add(alias);
    }
  }
  return [...expanded];
}

function overlap(tokens: string[], haystack: string): number {
  const text = haystack.toLowerCase();
  let score = 0;

  for (const token of new Set(tokens.map(singular))) {
    if (text.includes(token)) score += 1;
  }

  return score;
}

export type ModuleMatch = {
  id: string;
  score: number;
  installed: boolean;
  why: string;
};

/**
 * Ranks catalogue modules against a request.
 *
 * This is the template-first half of the harness: before any code is generated we check
 * whether a maintained, tested module already does the job.
 */
export function matchModules(
  registry: Registry,
  request: string,
  installed: Set<string>,
): ModuleMatch[] {
  const tokens = expandTokens(tokenize(request));

  return registry.modules
    .map((module) => {
      const capabilityScore =
        overlap(tokens, module.capabilities.join(" ")) * 3;
      const titleScore = overlap(tokens, `${module.id} ${module.title}`) * 2;
      const descriptionScore = overlap(tokens, module.description);
      const score = capabilityScore + titleScore + descriptionScore;

      const matched = module.capabilities.filter((capability) =>
        tokens.some((token) =>
          capability.toLowerCase().includes(singular(token)),
        ),
      );

      return {
        id: module.id,
        score,
        installed: installed.has(module.id),
        why:
          matched.length > 0
            ? `matches ${matched.slice(0, 3).join(", ")}`
            : module.title,
      };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);
}

export type StarterMatch = {
  /** Starter id, or `null` for the bare scaffold. */
  id: string | null;
  score: number;
  why: string;
};

const BARE_CAPABILITIES = [
  "scaffold",
  "bare",
  "blank",
  "empty",
  "scratch",
  "tooling",
  "minimal",
  "custom",
];

/**
 * Ranks catalogue starters (plus bare scaffold) against a natural-language request.
 */
export function matchStarters(
  registry: Registry,
  request: string,
): StarterMatch[] {
  const tokens = tokenize(request);

  const starterMatches: StarterMatch[] = registry.starters.map((starter) => {
    const capabilityScore = overlap(tokens, starter.capabilities.join(" ")) * 3;
    const titleScore = overlap(tokens, `${starter.id} ${starter.title}`) * 2;
    const descriptionScore = overlap(tokens, starter.description);
    const score = capabilityScore + titleScore + descriptionScore;

    const matched = starter.capabilities.filter((capability) =>
      tokens.some((token) =>
        capability.toLowerCase().includes(singular(token)),
      ),
    );

    return {
      id: starter.id,
      score,
      why:
        matched.length > 0
          ? `matches ${matched.slice(0, 3).join(", ")}`
          : starter.title,
    };
  });

  const bareScore = overlap(tokens, BARE_CAPABILITIES.join(" ")) * 3;
  const bare: StarterMatch = {
    id: null,
    score: bareScore,
    why:
      bareScore > 0 ? "matches bare / from-scratch tooling" : "Bare scaffold",
  };

  return [...starterMatches, bare]
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);
}

export type FileMatch = {
  path: string;
  score: number;
};

/**
 * Picks the project files most likely to matter for a request, so the model edits in the
 * style of the code that is already there instead of inventing a parallel one.
 */
export async function matchFiles(
  root: string,
  files: string[],
  request: string,
  limit = 8,
): Promise<FileMatch[]> {
  const tokens = [...new Set(tokenize(request).map(singular))];
  if (tokens.length === 0) return [];

  const matches: FileMatch[] = [];

  for (const path of files) {
    let score = overlap(tokens, path) * 4;

    const contents = await readFile(join(root, path), "utf8").catch(() => "");
    if (contents) {
      const lower = contents.toLowerCase();
      for (const token of tokens) {
        const occurrences = lower.split(token).length - 1;
        if (occurrences > 0) score += Math.min(occurrences, 4);
      }
    }

    if (score > 0) matches.push({ path, score });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Files that show how this project is put together. Included in every edit so generated
 * code matches the conventions the templates established.
 *
 * API-surface anchors (maps, StateView, firestore hooks) come first so they survive the
 * reference-snippet budget — inventing those shapes is the #1 cause of repair rounds.
 */
export function anchorFiles(files: string[]): string[] {
  const anchors = [
    "lib/maps.ts",
    "hooks/useCollection.ts",
    "hooks/useDocument.ts",
    "hooks/useStorageUrl.ts",
    "components/ui/StateView.tsx",
    "components/StateView.tsx",
    "components/ui/IconButton.tsx",
    "components/UploadButton.tsx",
    "lib/storage.ts",
    "lib/theme/tokens.ts",
    "lib/registry/tabs.ts",
    "lib/registry/providers.tsx",
    "lib/theme/index.tsx",
    "locales/en.json",
  ];

  return anchors.filter((anchor) => files.includes(anchor));
}

/**
 * Paths whose exports are extracted as ground-truth type contracts for every edit.
 * Subset of anchors plus domain helpers that models commonly invent wrong shapes for.
 */
export function contractSourceFiles(files: string[]): string[] {
  /*
   * Which files the model is shown the API surface of.
   *
   * This used to be a fixed list of 13 paths, which did not include
   * `components/ui/ListRow.tsx` — while the prompts tell the model to prefer
   * `components/ui/*` over inventing chrome. So it was instructed to use
   * components whose props it had never been shown, and it guessed: every
   * observed repair round in testing was the same class of error, a made-up
   * prop on a real component. Each cost a ~20s LLM round trip, and when the
   * repair also guessed wrong the run shipped code that does not compile.
   *
   * Derived from the project now, in priority order, so a component added to
   * the catalogue is covered without anyone remembering to add it here.
   */
  const ui = files.filter((path) => /^components\/ui\/[^/]+\.tsx?$/.test(path));
  const hooks = files.filter((path) => /^hooks\/[^/]+\.tsx?$/.test(path));
  const shared = files.filter((path) => /^components\/[^/]+\.tsx?$/.test(path));
  const themeAndRegistry = files.filter((path) =>
    /^lib\/(theme|registry)\/[^/]+\.tsx?$/.test(path),
  );
  const libRoot = files.filter((path) => /^lib\/[^/]+\.tsx?$/.test(path));

  return [
    ...new Set([...ui, ...hooks, ...shared, ...themeAndRegistry, ...libRoot]),
  ];
}
