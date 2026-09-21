/**
 * Deterministic ThemeColors expansion from a primary (+ optional bg/accent).
 * Used when the user pastes hex values during init without an LLM.
 */

export type ThemeColors = {
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceMuted: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textInverted: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
  secondary: string;
  secondaryText: string;
  success: string;
  warning: string;
  danger: string;
  dangerText: string;
  overlay: string;
  skeleton: string;
};

export type ThemePackData = {
  id: string;
  label: string;
  description?: string;
  light: ThemeColors;
  dark: ThemeColors;
};

export type HexSeed = {
  primary: string;
  background?: string;
  accent?: string;
};

type Rgb = { r: number; g: number; b: number };

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeHex(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(HEX_RE);
  if (!match?.[1]) return null;
  let raw = match[1].toLowerCase();
  if (raw.length === 3) {
    raw = raw
      .split("")
      .map((ch) => `${ch}${ch}`)
      .join("");
  }
  return `#${raw}`;
}

export function assertHex(input: string, label: string): string {
  const hex = normalizeHex(input);
  if (!hex) {
    throw new Error(
      `Invalid ${label} color "${input}" — use a hex like #2563eb`,
    );
  }
  return hex;
}

function parseRgb(hex: string): Rgb {
  const normalized = normalizeHex(hex)!;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastText(bg: Rgb): string {
  return luminance(bg) > 0.45 ? "#0a0a0c" : "#ffffff";
}

function darken(hex: string, amount: number): string {
  return toHex(mix(parseRgb(hex), { r: 0, g: 0, b: 0 }, amount));
}

function lighten(hex: string, amount: number): string {
  return toHex(mix(parseRgb(hex), { r: 255, g: 255, b: 255 }, amount));
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildLight(
  primary: string,
  background: string,
  accent: string,
): ThemeColors {
  const primaryRgb = parseRgb(primary);
  return {
    background,
    surface: lighten(background, 0.92),
    surfaceElevated: "#ffffff",
    surfaceMuted: mixHex(background, primary, 0.08),
    border: mixHex(background, "#000000", 0.12),
    borderStrong: mixHex(background, "#000000", 0.28),
    text: "#12141a",
    textMuted: mixHex("#12141a", background, 0.45),
    textInverted: contrastText(primaryRgb),
    primary,
    primaryHover: darken(primary, 0.12),
    primaryText: contrastText(primaryRgb),
    secondary: mixHex(background, accent, 0.18),
    secondaryText: "#12141a",
    success: "#15803d",
    warning: "#b45309",
    danger: "#dc2626",
    dangerText: "#ffffff",
    overlay: rgba("#12141a", 0.48),
    skeleton: mixHex(background, "#000000", 0.08),
  };
}

function buildDark(primary: string, accent: string): ThemeColors {
  const bg = "#0b0d12";
  const primaryRgb = parseRgb(primary);
  const lightPrimary = lighten(primary, 0.22);
  return {
    background: bg,
    surface: lighten(bg, 0.06),
    surfaceElevated: lighten(bg, 0.1),
    surfaceMuted: mixHex(bg, primary, 0.14),
    border: mixHex(bg, "#ffffff", 0.14),
    borderStrong: mixHex(bg, "#ffffff", 0.28),
    text: "#f3f5f8",
    textMuted: mixHex("#f3f5f8", bg, 0.42),
    textInverted: contrastText(parseRgb(lightPrimary)),
    primary: lightPrimary,
    primaryHover: lighten(primary, 0.35),
    primaryText: contrastText(parseRgb(lightPrimary)),
    secondary: mixHex(bg, accent, 0.22),
    secondaryText: "#f3f5f8",
    success: "#4ade80",
    warning: "#fbbf24",
    danger: "#f87171",
    dangerText: "#1a0808",
    overlay: rgba("#000000", 0.62),
    skeleton: mixHex(bg, "#ffffff", 0.08),
  };
}

function mixHex(a: string, b: string, t: number): string {
  return toHex(mix(parseRgb(a), parseRgb(b), t));
}

/** Expand a hex seed into a full light+dark ThemePack. */
export function expandThemeFromHex(
  seed: HexSeed,
  label = "Custom",
): ThemePackData {
  const primary = assertHex(seed.primary, "primary");
  const background = seed.background
    ? assertHex(seed.background, "background")
    : lighten(primary, 0.92);
  const accent = seed.accent ? assertHex(seed.accent, "accent") : primary;

  return {
    id: "custom",
    label,
    description: `Custom palette from ${primary}`,
    light: buildLight(primary, background, accent),
    dark: buildDark(primary, accent),
  };
}

/** Map free-text vibes onto a built-in pack when no LLM is available. */
export function mapVibeToBuiltin(description: string): BuiltinGuess {
  const lower = description.toLowerCase();
  if (/\b(ocean|teal|cyan|sea|maritime|aqua)\b/.test(lower)) {
    return { pack: "ocean", reason: "Matched oceanic / teal language" };
  }
  if (/\b(hearth|terracotta|cream|marketplace|hospitality)\b/.test(lower)) {
    return { pack: "hearth", reason: "Matched hearth / terracotta language" };
  }
  if (/\b(bloom|mauve|salon|spa|appointment)\b/.test(lower)) {
    return { pack: "bloom", reason: "Matched bloom / mauve language" };
  }
  if (/\b(flare|sunset|event|ticket|orange)\b/.test(lower)) {
    return { pack: "flare", reason: "Matched flare / event language" };
  }
  if (/\b(paper|ivory|olive|magazine|reader)\b/.test(lower)) {
    return { pack: "paper", reason: "Matched paper / reader language" };
  }
  if (/\b(grove|forest|local|neighbourhood|neighborhood)\b/.test(lower)) {
    return { pack: "grove", reason: "Matched grove / local language" };
  }
  if (/\b(citrus|gold|lime|habit|streak)\b/.test(lower)) {
    return { pack: "citrus", reason: "Matched citrus / habit language" };
  }
  if (/\b(violet|purple|forum|community|discord)\b/.test(lower)) {
    return { pack: "violet", reason: "Matched violet / community language" };
  }
  if (/\b(ink|editorial|indigo)\b/.test(lower)) {
    return { pack: "ink", reason: "Matched editorial / indigo language" };
  }
  if (/\b(contrast|a11y|accessib|high[- ]?contrast|outdoor)\b/.test(lower)) {
    return { pack: "contrast", reason: "Matched high-contrast language" };
  }
  if (/\b(coral|rose|pink|brand|consumer|social)\b/.test(lower)) {
    return { pack: "branded", reason: "Matched branded / coral language" };
  }
  if (/\b(neutral|graphite|blue|calm|product)\b/.test(lower)) {
    return { pack: "neutral", reason: "Matched neutral / product language" };
  }
  return { pack: "neutral", reason: "No strong vibe match — using neutral" };
}

export type BuiltinGuess = {
  pack:
    | "neutral"
    | "contrast"
    | "branded"
    | "ocean"
    | "ink"
    | "hearth"
    | "bloom"
    | "flare"
    | "paper"
    | "grove"
    | "violet"
    | "citrus";
  reason: string;
};

const COLOR_KEYS: (keyof ThemeColors)[] = [
  "background",
  "surface",
  "surfaceElevated",
  "surfaceMuted",
  "border",
  "borderStrong",
  "text",
  "textMuted",
  "textInverted",
  "primary",
  "primaryHover",
  "primaryText",
  "secondary",
  "secondaryText",
  "success",
  "warning",
  "danger",
  "dangerText",
  "overlay",
  "skeleton",
];

export function isThemeColors(value: unknown): value is ThemeColors {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return COLOR_KEYS.every((key) => typeof record[key] === "string");
}

export function serializeThemePackFile(pack: ThemePackData): string {
  const description = pack.description
    ? `\n  description: ${JSON.stringify(pack.description)},`
    : "";
  return `import type { ThemePack } from '@/lib/theme/tokens';

/** Generated during \`radiance init\` from your theme description or colors. */
export const customPack: ThemePack = {
  id: 'custom',
  label: ${JSON.stringify(pack.label)},${description}
  light: ${JSON.stringify(pack.light, null, 2).replace(/\n/g, "\n  ")},
  dark: ${JSON.stringify(pack.dark, null, 2).replace(/\n/g, "\n  ")},
};
`;
}

/** Register `custom` in config.ts via markers + import. */
export function registerCustomThemePack(configSource: string): string {
  let next = configSource;
  const importLine = "import { customPack } from '@/lib/theme/packs/custom';";
  if (!next.includes(importLine)) {
    const lines = next.split("\n");
    let lastImport = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*import\s/.test(lines[i] ?? "")) lastImport = i;
    }
    if (lastImport === -1) {
      next = `${importLine}\n${next}`;
    } else {
      lines.splice(lastImport + 1, 0, importLine);
      next = lines.join("\n");
    }
  }

  const entry = "custom: customPack,";
  if (next.includes("custom: customPack")) return next;

  const start = next.indexOf("// radiance:theme-packs:start");
  const end = next.indexOf("// radiance:theme-packs:end");
  if (start === -1 || end === -1 || end < start) {
    // Fallback: inject before closing brace of themePacks.
    return next.replace(
      /export const themePacks: Record<string, ThemePack> = \{([\s\S]*?)\};/,
      (_match, body: string) =>
        `export const themePacks: Record<string, ThemePack> = {${body.trimEnd()}\n  ${entry}\n};`,
    );
  }

  const before = next.slice(0, end);
  const after = next.slice(end);
  if (before.includes(entry)) return next;
  return `${before}  ${entry}\n  ${after}`;
}
