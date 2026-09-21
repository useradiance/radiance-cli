import type { Registry } from "../core/registry.js";
import { matchModules } from "./retrieval.js";
import {
  modulesForPlan,
  type InitPlan,
  type ProjectPlanHint,
} from "./init-slots.js";

/** Modules that need a paid (billed) Firebase project to run in the cloud. */
export const PAID_CLOUD_MODULES = new Set(["storage", "functions", "stripe"]);

const GEO_PATTERN =
  /\b(nearby|near\s+me|geograph(?:ic|y)?|geolocat|location|locations|map|maps|close\s+to|locally|local\s+to|distance|lat(?:itude)?|lng|lon(?:gitude)?|gps|radius|proximity)\b/i;

const COMMENT_PATTERN = /\bcomments?\b/i;
const PHOTO_PATTERN =
  /\b(photos?|images?|pictures?|avatars?|uploads?|media)\b/i;

export type PromptDelta = {
  /** Catalogue modules to install beyond the starter. */
  extraModules: string[];
  /** Product gaps the starter does not cover — feed the follow-up prompt. */
  promptGaps: string[];
  /** Billing posture implied by modules / utterance. */
  suggestedPlan: ProjectPlanHint;
  /** Concrete residual request for `radiance prompt`. */
  followUpPrompt?: string;
};

/**
 * Diff the user's opening description against what the chosen starter already ships.
 * Used after starter selection (and again when merging LLM extract) so we add modules
 * and residual work instead of stopping at the template.
 */
export function computePromptDelta(
  utterance: string,
  plan: InitPlan,
  registry: Registry,
): PromptDelta {
  const included = new Set([
    ...modulesForPlan(plan, registry),
    ...(plan.extraModules ?? []),
  ]);

  const extraModules = new Set<string>(plan.extraModules ?? []);
  const promptGaps: string[] = [...(plan.promptGaps ?? [])];

  const matches = matchModules(registry, utterance, included);
  for (const match of matches) {
    if (match.installed) continue;
    if (match.score < 3) continue;
    // Foundation / always-pulled-by-starters — only add when match is strong and missing.
    if (included.has(match.id)) continue;
    extraModules.add(match.id);
  }

  if (GEO_PATTERN.test(utterance)) {
    if (
      !included.has("maps") &&
      registry.modules.some((module) => module.id === "maps")
    ) {
      extraModules.add("maps");
    }
    pushGap(
      promptGaps,
      "Let people discover or filter shared photos by geographic proximity (nearby feed / map)",
    );
  }

  if (COMMENT_PATTERN.test(utterance)) {
    // social-app ships likes but not comments today.
    pushGap(promptGaps, "Comments on posts (threaded under each photo/post)");
  }

  if (PHOTO_PATTERN.test(utterance) && !included.has("storage")) {
    if (registry.modules.some((module) => module.id === "storage")) {
      extraModules.add("storage");
    }
  }

  // Drop anything the starter (or scaffold) already includes.
  const starterModules = new Set(modulesForPlan(plan, registry));
  const resolvedExtra = [...extraModules].filter((id) => {
    if (starterModules.has(id)) return false;
    return registry.modules.some((module) => module.id === id);
  });

  const finalModules = new Set([...starterModules, ...resolvedExtra]);
  const suggestedPlan = suggestPlan(utterance, finalModules);

  const baseFollowUp =
    plan.followUpPrompt?.trim() ||
    (promptGaps.length > 0
      ? buildFollowUpPrompt(utterance, plan, promptGaps)
      : undefined);

  const followUpPrompt = withVisualTune(baseFollowUp, utterance, plan);

  return {
    extraModules: resolvedExtra.sort(),
    promptGaps,
    suggestedPlan,
    followUpPrompt,
  };
}

export function suggestPlan(
  utterance: string,
  moduleIds: Iterable<string>,
): ProjectPlanHint {
  for (const id of moduleIds) {
    if (PAID_CLOUD_MODULES.has(id)) return "paid";
  }
  if (PHOTO_PATTERN.test(utterance)) return "paid";
  if (
    /\b(stripe|payment|checkout|subscription|cloud\s+function)\b/i.test(
      utterance,
    )
  ) {
    return "paid";
  }
  return "free";
}

function pushGap(gaps: string[], gap: string): void {
  const key = gap.toLowerCase();
  if (gaps.some((existing) => existing.toLowerCase() === key)) return;
  gaps.push(gap);
}

function buildFollowUpPrompt(
  utterance: string,
  plan: InitPlan,
  gaps: string[],
): string {
  const starter =
    plan.starterId === null
      ? "bare scaffold"
      : (plan.starterId ?? "the chosen starter");
  const gapLines = gaps.map((gap) => `- ${gap}`).join("\n");

  const lines = [
    `Original request: ${utterance.trim()}`,
    `Base: ${starter} is already installed. Implement only the remaining gaps:`,
    gapLines,
    "Reuse catalogue modules where possible. Prefer Firestore paths that match existing posts/likes patterns (e.g. posts/{postId}/comments/{commentId}). Persist storage paths, not download URLs. Keep security rules tight to the signed-in owner/author.",
  ];

  return lines.join("\n");
}

function withVisualTune(
  followUp: string | undefined,
  utterance: string,
  plan: InitPlan,
): string | undefined {
  if (!followUp) return undefined;
  if (/do not redesign the starter/i.test(followUp)) return followUp;
  const visualTune = visualTuneClause(utterance, plan);
  if (!visualTune) return followUp;
  return `${followUp}\n${visualTune}`;
}

/** Detect a look/feel signal so follow-ups stay feature-first with one light visual tune. */
function visualTuneClause(
  utterance: string,
  plan: InitPlan,
): string | undefined {
  const vibe = plan.themeDescription?.trim() || extractVibeHint(utterance);
  if (!vibe) return undefined;

  return `Edit theme pack/tokens first to match "${vibe.slice(0, 80)}", then lightly tune primary tabs/home hierarchy and copy; do not redesign the starter or add features for polish.`;
}

const VIBE_PATTERN =
  /\b(premium|calm|bold|minimal|playful|elegant|dark|bright|warm|cool|maritime|teal|cinematic|brutal|soft|vivid|moody|clean|like\s+[A-Z][\w]+)\b/i;

function extractVibeHint(utterance: string): string | undefined {
  const likeMatch = utterance.match(/\blike\s+([A-Z][\w]+(?:\s+[A-Z][\w]+)?)/);
  if (likeMatch?.[1]) return `like ${likeMatch[1]}`;
  const match = utterance.match(VIBE_PATTERN);
  return match?.[1]?.toLowerCase();
}

/** Merge a computed delta into the plan without clobbering explicit values. */
export function applyPromptDelta(plan: InitPlan, delta: PromptDelta): InitPlan {
  const extra = new Set([...(plan.extraModules ?? []), ...delta.extraModules]);
  const gaps = [...(plan.promptGaps ?? [])];
  for (const gap of delta.promptGaps) pushGap(gaps, gap);

  return {
    ...plan,
    extraModules: [...extra].sort(),
    promptGaps: gaps,
    suggestedPlan: plan.suggestedPlan ?? delta.suggestedPlan,
    followUpPrompt: plan.followUpPrompt?.trim() || delta.followUpPrompt,
  };
}
