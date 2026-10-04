import {
  renderCatalogue,
  renderSnippets,
  renderTree,
  type FileSnippet,
  type ProjectContext,
} from "./context.js";
import type { PlannedFile } from "./plan.js";

/**
 * The rules every generated change has to follow.
 *
 * These mirror the patterns the templates already use, which is what keeps hand-written and
 * generated code indistinguishable a few prompts later.
 */
export const CONSTITUTION = `You are Radiance, a code generator for Expo + Firebase apps.

Stack: Expo SDK 57, expo-router, React Native, TypeScript (strict), Firebase JS SDK, Zustand.

Non-negotiable rules:
1. Prefer the catalogue. If an existing Radiance module provides a capability, install it
   instead of writing that capability by hand.
2. Follow the project's existing patterns. Read the files you are given and reuse their
   imports, helpers and file layout rather than introducing new libraries or conventions.
3. Every user-visible string goes through i18n: \`const { t } = useTranslation()\` and a key
   added to locales/en.json. Never hardcode display text in a component.
4. Style with the theme: \`useTheme()\` and \`createStyles\` from lib/theme, and tokens for
   colour, spacing, radius and typography. No hex literals, no magic numbers.
5. Visual quality — match polished starters/theme primitives; do not invent a new design
   system:
   - Commit to one named tone from the request or theme pack; do not average styles.
   - One clear primary action per screen; use Text variants (display/title/body) for hierarchy.
   - Prefer elevating shared UI (\`components/ui/*\`, theme tokens) before one-off screen styles.
   - Prefer \`List\`/\`Grid\` over raw FlatList; \`Skeleton\` for layout-faithful loading;
     \`Avatar\`, \`IconButton\`, \`SectionHeader\`, \`Card\`, \`SwitchRow\`, \`CheckboxRow\`,
     \`Progress\`, \`Chip\`, \`Onboarding\`/\`PageDots\`, \`Dialog\`, \`Sheet\`, \`Select\`,
     \`Badge\`, \`MediaImage\`, \`Segmented\`, \`Fab\`, and \`toast()\` when those files exist.
   - Real domain copy via i18n — no "Feature 1", lorem, or placeholder labels.
   - Loading must mirror final layout (skeletons), not only a centered spinner; empty/error
     via StateView.
   - Avoid AI-cliché palettes (purple-on-white, cream+terracotta) and card soup with no hierarchy.
   - When restyling for a vibe: edit theme pack/tokens first, then at most 1–2 primary screens.
6. Data access goes through the existing hooks (useCollection, useDocument) and helpers in
   lib/. Writes that a user waits on are optimistic where the project already does that.
7. Screens handle loading, empty and error states — use the StateView component.
8. Firestore access needs matching security rules. If you add a collection, add rules.
9. TypeScript must compile: no \`any\`, no unused imports, explicit prop types.
10. Never edit inside \`radiance:*\` markers, package.json, or files under functions/ unless the
    plan says so. Never touch node_modules, .expo or generated output.
11. Match the navigation shell already in the project:
    - tabs → screens under \`app/(app)/(tabs)/\`, detail routes as siblings under \`app/(app)/\`
    - drawer → screens under \`app/(app)/(drawer)/\`, detail routes as siblings under \`app/(app)/\`
    - stack → screens directly under \`app/(app)/\`
    Never invent a \`(tabs)\` path when the project uses drawer or stack.
12. Pass a null key to \`useDocument\` / \`useCollection\` when a route param is missing so the
    subscription is skipped (e.g. \`id ? \`posts:\${id}\` : null\`). Never call \`doc(db, col, '')\`.
13. API shapes that models invent wrong — use these exact names:
    - \`IconButton\` takes Ionicons \`name\` (alias \`icon\` also works). Never invent other props.
    - \`UploadResult\` is \`{ path, storagePath, downloadUrl }\` — \`path\` and \`storagePath\` are
      the same storage object path. Persist that path in Firestore, not \`downloadUrl\`.
    - For document screens prefer typed helpers (\`postRef\`, \`productRef\`, \`postLikeRef\`)
      when they exist; pass them to \`useDocument<T>\` rather than inventing converters.

You always answer with a single JSON object and no prose around it.`;

export function planPrompt(
  context: ProjectContext,
  request: string,
  matches: { id: string; score: number; installed: boolean; why: string }[],
  snippets: FileSnippet[],
): string {
  const installed = new Set(
    context.project.features.map((feature) => feature.id),
  );

  const candidates = matches
    .slice(0, 6)
    .map(
      (match) =>
        `- ${match.id} (${match.installed ? "installed" : "not installed"}): ${match.why}`,
    )
    .join("\n");

  return `# Request

${request}

# Project

Name: ${context.project.name}
Starter: ${context.project.template ?? "bare scaffold"}
Theme pack: ${context.project.themePack}
Locale: ${context.project.defaultLocale}

# Installed modules

${[...installed].join(", ") || "none"}

# Module catalogue

${renderCatalogue(context.source, installed)}

# Catalogue modules that look relevant

${candidates || "none"}

# Project files

${renderTree(context.files)}

# Relevant existing code

${renderSnippets(snippets)}

# Your task

Plan the largest coherent change that still fits the constraints and produces a user-visible
result (or a clear fix). Prefer catalogue modules first; any capability a module provides must
come from the module, not from generated code. Then plan the remaining files up to the limit.

Prefer reusing existing screens and \`components/ui/*\` (List, Grid, Skeleton, Avatar, Card,
SectionHeader, IconButton, SwitchRow, CheckboxRow, Onboarding) over inventing new chrome or
raw FlatList. If the request is UI-facing, put in \`summary\` / each file \`intent\`: the named
tone (or theme pack / product reference), the one primary action on screen, and what must feel
intentional on first open. For vibe/restyle work: plan theme pack/token edits first, then at
most 1–2 screens. Do not invent feature sprawl just to "make it pretty".

If this plan cannot fully satisfy the original request, list what you deliberately leave out in
\`deferred\` and write a self-contained \`followUpPrompt\` that assumes this plan already landed
(suitable as the next \`radiance prompt\` argument). If the request is fully covered, set
\`deferred\` to [] and \`followUpPrompt\` to null.

Answer with JSON:

{
  "summary": "one sentence, present tense, what the user will get",
  "modules": ["module ids to install, in the order they should be installed"],
  "files": [
    {
      "path": "app/(app)/(tabs)/notes.tsx",
      "action": "create" | "modify",
      "intent": "what this file must do, in enough detail to write it without guessing",
      "typeContracts": "exact TypeScript signatures of every hook, component, and type this file will import from other project files — copied verbatim from the relevant code snippets you were given. Include return types of hooks, prop types of components, and any enum/union values for status fields. Omit if you have no snippet evidence for a symbol."
    }
  ],
  "locales": ["translation keys you will add, e.g. notes.title"],
  "rules": "firestore rules that need to change, or null",
  "risks": ["anything the user should check before accepting"],
  "deferred": ["short items this plan does not implement"],
  "followUpPrompt": "concrete residual request for the next radiance prompt, or null"
}

Constraints:
- At most 8 files.
- Only list a file under "files" if you will actually write it. Files a module installs must
  not appear there.
- Use paths relative to the project root, matching the existing layout.
- If the request is already satisfied by an installed module, return an empty "files" array
  and explain that in "summary".
- For typeContracts: copy signatures directly from the snippets you received. Do not invent
  or guess shapes. If you have no snippet evidence for a symbol the file will import, omit it
  from typeContracts rather than guessing. Set typeContracts to null if the file only uses
  well-known React Native / Expo APIs with no project-local imports.
- When restyling, prefer editing shared theme / UI primitives plus 1–3 screens over rewriting
  every route.
- followUpPrompt must be self-contained and must not repeat work this plan already covers.`;
}

export function editPrompt(
  context: ProjectContext,
  request: string,
  plan: { summary: string; locales: string[] },
  file: PlannedFile,
  current: string | null,
  references: FileSnippet[],
  projectContracts: string | null = null,
): string {
  const contracts = mergeContractSections(projectContracts, file.typeContracts);
  const contractsSection = contracts
    ? `\n# Type contracts\n\nThese are the exact TypeScript signatures of project-local symbols.\nDo NOT invent alternative shapes — use these verbatim (hook returns, props, token keys).\n\n${contracts}\n`
    : "";

  return `# Request

${request}

# Plan

${plan.summary}
Translation keys for this change: ${plan.locales.join(", ") || "none"}
${contractsSection}
# Constitution

${context.constitution || "(not available)"}

# Reference files from this project

${renderSnippets(references)}

# File to write

Path: ${file.path}
Action: ${file.action}
Intent: ${file.intent}

${
  current === null
    ? "This file does not exist yet."
    : `Current contents:\n\n\`\`\`\n${current}\n\`\`\``
}

# Your task

Write the complete final contents of ${file.path}.

Return the whole file, not a patch. Keep everything in the current file that is unrelated to
this change, including comments and \`radiance:*\` marker regions. Match the imports, naming and
formatting of the reference files. Where type contracts are given, use those exact shapes.
For UI screens/components: match starter visual quality — extend shared theme / \`components/ui\`
primitives first; do not decorate with one-off colours or spacing.

Answer with JSON:

{ "contents": "the entire file", "notes": "anything the user should know, or null" }`;
}

export function batchEditPrompt(
  context: ProjectContext,
  request: string,
  plan: { summary: string; locales: string[] },
  files: Array<{ file: PlannedFile; current: string | null }>,
  references: FileSnippet[],
  projectContracts: string | null = null,
): string {
  const filesSection = files
    .map(({ file, current }, i) => {
      const contracts = mergeContractSections(null, file.typeContracts);
      const contractsBlock = contracts
        ? `Planner type contracts for this file:\n${contracts}\n\n`
        : "";

      const contentsBlock =
        current === null
          ? "This file does not exist yet."
          : `Current contents:\n\n\`\`\`\n${current}\n\`\`\``;

      return `## File ${i + 1}: ${file.path}

Action: ${file.action}
Intent: ${file.intent}

${contractsBlock}${contentsBlock}`;
    })
    .join("\n\n---\n\n");

  const projectContractsSection = projectContracts
    ? `\n# Project API contracts\n\nThese are extracted from the project's own source. Do NOT invent alternative shapes.\n\n${projectContracts}\n`
    : "";

  return `# Request

${request}

# Plan

${plan.summary}
Translation keys for this change: ${plan.locales.join(", ") || "none"}
${projectContractsSection}
# Constitution

${context.constitution || "(not available)"}

# Reference files from this project

${renderSnippets(references)}

# Files to write

${filesSection}

# Your task

Write the complete final contents of every file listed above.

For each file: return the whole file, not a patch. Keep everything in the current file that is
unrelated to this change, including comments and \`radiance:*\` marker regions. Match the
imports, naming and formatting of the reference files. Where type contracts are given, use
those exact shapes — do not invent alternatives. For UI screens/components: match starter
visual quality — extend shared theme / \`components/ui\` primitives first.

Answer with JSON:

{
  "files": [
    { "path": "exact/path/as/listed", "contents": "the entire file", "notes": "anything the user should know, or null" }
  ]
}

The "files" array must contain one entry for every file listed above, in the same order.`;
}

function mergeContractSections(
  project: string | null,
  planner: string | null | undefined,
): string | null {
  const parts = [project, planner].filter(
    (part): part is string =>
      typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function repairPrompt(
  file: { path: string; contents: string },
  errors: string,
  references: FileSnippet[],
  projectContracts: string | null = null,
): string {
  const contractsSection = projectContracts
    ? `\n# Project API contracts\n\nUse these exact shapes when fixing the errors — do not invent alternatives.\n\n${projectContracts}\n`
    : "";

  return `TypeScript failed after your change.

# Errors

${errors}
${contractsSection}
# Reference files

${renderSnippets(references)}

# File to fix

Path: ${file.path}

\`\`\`
${file.contents}
\`\`\`

Fix only what the errors point at. Do not restructure working code, and do not silence errors
with \`any\` or \`@ts-ignore\`.

Answer with JSON:

{ "contents": "the entire corrected file", "notes": "what you changed" }`;
}

export function buildInitExtractPrompt(args: {
  utterance: string;
  planSummary: string;
  missing: string[];
  starters: {
    id: string;
    title: string;
    description: string;
    capabilities: string[];
  }[];
  starterMatches: { id: string | null; score: number; why: string }[];
  allowedOptions: string;
  moduleLines?: string;
}): string {
  const starterLines = args.starters
    .map(
      (starter) =>
        `- ${starter.id}: ${starter.title} — ${starter.description} [${starter.capabilities.join(", ")}]`,
    )
    .join("\n");

  const matchLines = args.starterMatches
    .slice(0, 5)
    .map(
      (match) =>
        `- ${match.id ?? "bare scaffold"} (score ${match.score}): ${match.why}`,
    )
    .join("\n");

  return `You extract structured init settings for a Radiance Expo + Firebase app from the user's words.

Rules:
1. Only fill fields that the utterance clearly evidences. Do not invent required values.
2. A description of an app always gets a catalogue starter: the closest one, even when it fits
   only partly — followUpPrompt adapts it. When nothing is close, use "productivity" (general
   lists, detail screens, per-user data).
3. Use starterId null only when the utterance explicitly asks for an empty project with no
   screens. "From scratch" or an unusual domain is not that — pick the closest starter.
4. themePack must be one of: neutral, contrast, branded, ocean, ink, hearth, bloom, flare, paper, grove, violet, citrus (never invent custom here).
5. packageManager must be one of: npm, yarn, pnpm, bun.
6. options keys must be exactly from the allowed list below (e.g. "navigation.shell", "auth.providers").
7. auth.providers is a string array; other options are usually a single string.
8. Diff the utterance against the chosen starter: list product gaps in promptGaps and
   catalogue module ids to add in extraModules (e.g. maps for geographic/nearby features).
9. suggestedPlan must be "paid" when the app needs cloud Storage, Functions, Stripe, or
   photo uploads; otherwise "free".
10. Put a concrete residual build request into followUpPrompt covering schema and UX gaps
    the starter does not ship (comments, nearby feed, etc.). Feature work first. If the
    utterance names a look/feel/vibe or a product reference (e.g. "like Linear"), put that
    into themeDescription-worthy wording and append ONE short visual-tune sentence:
    edit theme tokens/pack first, then lightly tune primary tabs/home; do not redesign the
    starter or add features for polish.
11. Tone: rationale must be plain, friendly, and short — max ~12 words. Speak to the user
   ("Sounds like a social app — using social-app."). Never say "utterance", "best matches",
   "the user requested", or explain your reasoning step by step.

# Current plan (already filled — do not change these)

${args.planSummary || "(empty)"}

# Still missing (code will ask for these if you leave them empty)

${args.missing.join(", ") || "(none)"}

# Starters

${starterLines}
- bare scaffold: no screens at all — only when explicitly asked for an empty project

# Starter ranking for this utterance

${matchLines || "(no strong match)"}

# Catalogue modules (for extraModules — only ids not already on the starter)

${args.moduleLines || "(none)"}

# Allowed option keys and choices

${args.allowedOptions}

# Utterance

${args.utterance}

Answer with JSON only:

{
  "updates": {
    "name": "directory name if stated, else omit",
    "starterId": "starter id or null for bare, else omit",
    "themePack": "neutral|contrast|branded|ocean|ink|hearth|bloom|flare|paper|grove|violet|citrus, else omit",
    "locale": "BCP-47 code if stated, else omit",
    "packageManager": "npm|yarn|pnpm|bun, else omit",
    "bundleId": "if stated, else omit",
    "options": { "navigation.shell": "tabs|drawer|stack", "auth.providers": ["email"] },
    "firebase": true,
    "extraModules": ["maps"],
    "promptGaps": ["nearby photo feed by location", "comments on posts"],
    "suggestedPlan": "paid"
  },
  "rationale": "Sounds like a social app — using social-app.",
  "followUpPrompt": "Add geo fields on posts, a nearby feed, and comments under posts/{id}/comments. Edit theme tokens/pack first to match a calm premium vibe, then lightly tune home hierarchy/copy; do not redesign the starter."
}

Omit any update key you are not sure about. Empty updates object is fine.
Do NOT set packageManager, themePack, or locale unless the utterance explicitly names them
(e.g. "use yarn", "ocean theme", "locale fr"). Those are asked locally or taken from config.
Good rationale examples: "Going with the storefront starter.", "Bare scaffold — you want to build from scratch."
Bad rationale examples: "The utterance describes…", "The social-app starter best matches these features."`;
}

/** Prompt the model for a full light+dark ThemePack colour map. */
export function buildThemePackPrompt(description: string): string {
  return `Design a cohesive app colour palette from this description:

"""
${description}
"""

Return JSON only with this exact shape (every colour key required as a CSS colour string):

{
  "label": "short pack name",
  "description": "one short sentence",
  "light": {
    "background": "#…",
    "surface": "#…",
    "surfaceElevated": "#…",
    "surfaceMuted": "#…",
    "border": "#…",
    "borderStrong": "#…",
    "text": "#…",
    "textMuted": "#…",
    "textInverted": "#…",
    "primary": "#…",
    "primaryHover": "#…",
    "primaryText": "#…",
    "secondary": "#…",
    "secondaryText": "#…",
    "success": "#…",
    "warning": "#…",
    "danger": "#…",
    "dangerText": "#…",
    "overlay": "rgba(…)",
    "skeleton": "#…"
  },
  "dark": { /* same keys as light */ }
}

Rules:
- Prefer distinctive, production-ready colours — avoid purple-on-white and cream+terracotta clichés unless asked.
- Light and dark must both be readable with clear contrast on primary buttons and body text.
- Use hex for solid colours; rgba only for overlay.`;
}

/** Audit UI files and ensure every user-facing string lives in locales/en.json. */
export function buildI18nSweepPrompt(args: {
  enJson: Record<string, unknown>;
  fileTree: string;
  snippets: string;
}): string {
  return `Audit this Radiance app so every user-facing string is in locales/en.json and accessed via t().

# Current locales/en.json

${JSON.stringify(args.enJson, null, 2)}

# UI files under review

${args.fileTree || "(none)"}

# File contents

${args.snippets || "(none)"}

# Your task

1. Find hardcoded user-visible copy in the files (JSX text, Button/Text titles, placeholders,
   empty/error titles, alerts, section labels). Ignore technical identifiers, test IDs,
   route names, hex colours, and log messages.
2. Add any missing keys to locales/en.json (nested objects, same style as existing keys).
3. Edit files so those strings use \`const { t } = useTranslation()\` and \`t('key.path')\`.
4. Keep existing translation keys and wording unless a hardcoded string must replace a wrong key.
5. Do not invent features or restyle the UI.

Answer with JSON only:

{
  "summary": "one short sentence of what you fixed",
  "en": { /* FULL updated locales/en.json object — include every existing key plus new ones */ },
  "edits": [
    { "path": "app/(app)/(tabs)/index.tsx", "contents": "complete file source" }
  ]
}

Constraints:
- "en" must be the complete catalogue, not a partial patch.
- Only include a file in "edits" when its source must change. Omit unchanged files.
- Edited files must be complete, valid TypeScript/TSX.
- Prefer existing key namespaces (auth.*, feed.*, common.*, …) before inventing new ones.`;
}

/**
 * The fast path's single prompt: plan and write in one response.
 *
 * Deliberately not `planPrompt` + `batchEditPrompt` glued together. Those two
 * hand information across a round trip — the planner writes `typeContracts` so
 * the editor, which never saw the reference files, can avoid guessing at
 * shapes. Here the model has the actual file contents in front of it, so
 * copying signatures into an intermediate JSON field would be asking it to
 * restate what it can already read. The instruction that matters is the one
 * telling it to use what it was given rather than invent.
 */
export function fastEditPrompt(
  context: ProjectContext,
  request: string,
  matches: { id: string; score: number; installed: boolean; why: string }[],
  candidates: Array<{ path: string; contents: string }>,
  projectContracts: string | null = null,
): string {
  const installed = new Set(
    context.project.features.map((feature) => feature.id),
  );

  const catalogueCandidates = matches
    .slice(0, 6)
    .map(
      (match) =>
        `- ${match.id} (${match.installed ? "installed" : "not installed"}): ${match.why}`,
    )
    .join("\n");

  const candidateSection = candidates
    .map(
      (candidate) =>
        `## ${candidate.path}\n\n\`\`\`\n${candidate.contents}\n\`\`\``,
    )
    .join("\n\n---\n\n");

  const projectContractsSection = projectContracts
    ? `\n# Project API contracts\n\nExtracted from the project's own source. Do NOT invent alternative shapes.\n\n${projectContracts}\n`
    : "";

  return `# Request

${request}

# Project

Name: ${context.project.name}
Starter: ${context.project.template ?? "bare scaffold"}
Theme pack: ${context.project.themePack}
Locale: ${context.project.defaultLocale}

# Installed modules

${[...installed].join(", ") || "none"}

# Catalogue modules that look relevant

${catalogueCandidates || "none"}

# Project files

${renderTree(context.files)}
${projectContractsSection}
# Constitution

${context.constitution || "(not available)"}

# Existing files, in full

These are the files most likely to be relevant. Modify the ones you need and use the rest as
reference for imports, naming, formatting and available props. Any symbol you import from
project code must exist in what you were shown here or in the API contracts above — if you
cannot see it, do not import it.

${candidateSection || "(none matched)"}

# Your task

Make the change, in one pass. Decide which files to write and write them completely.

Prefer catalogue modules first: any capability a module provides must come from the module,
not from generated code. List those in "modules" and do not also write their files.

Prefer reusing existing screens and \`components/ui/*\` (List, Grid, Skeleton, Avatar, Card,
SectionHeader, IconButton, SwitchRow, CheckboxRow, Onboarding) over inventing new chrome or
raw FlatList. For UI-facing work, keep the named tone, one clear primary action per screen,
and match the visual quality of the files above.

For each file return the COMPLETE final contents, not a patch. Keep everything in the current
file that is unrelated to this change, including comments and \`radiance:*\` marker regions.
To modify a file you were not shown, do not guess at its contents — leave it out and say so in
"deferred".

If you cannot fully satisfy the request, list what you left out in "deferred" and write a
self-contained "followUpPrompt" that assumes this change already landed. If it is fully
covered, use [] and null.

Answer with JSON:

{
  "summary": "one sentence, present tense, what the user will get",
  "modules": ["module ids to install, in install order"],
  "locales": ["translation keys you added, e.g. notes.title"],
  "files": [
    {
      "path": "app/(app)/(tabs)/notes.tsx",
      "action": "create" | "modify",
      "summary": "one line on this file's role in the change",
      "contents": "the entire file",
      "notes": "anything the user should know, or null"
    }
  ],
  "deferred": ["short items this change does not implement"],
  "followUpPrompt": "concrete residual request for the next radiance prompt, or null"
}

Constraints:
- At most 8 files.
- Use paths relative to the project root, matching the existing layout.
- Do not write package.json, lockfiles, app.json, .env or radiance.json.
- If the request is already satisfied, return an empty "files" array and explain in "summary".`;
}
