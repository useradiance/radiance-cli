import type { Workspace } from "../core/apply/workspace.js";
import { RadianceError, ui } from "../core/logger.js";
import { extractJson, type LlmClient } from "../harness/llm.js";

/** Translate cloned locale files from English using the LLM. */
export async function translateLocaleFiles(
  workspace: Workspace,
  locales: string[],
  client: LlmClient,
): Promise<void> {
  const targets = [...new Set(locales)].filter((code) => code !== "en");
  if (targets.length === 0) return;

  const enRaw = await workspace.read("locales/en.json");
  if (!enRaw) {
    ui.warn("Skipping locale translation — locales/en.json missing");
    return;
  }

  let enJson: unknown;
  try {
    enJson = JSON.parse(enRaw);
  } catch {
    ui.warn("Skipping locale translation — locales/en.json is not valid JSON");
    return;
  }

  for (const code of targets) {
    ui.detail(`Translating locales/${code}.json…`);
    try {
      const translated = await translateOne(client, enJson, code);
      await workspace.write(
        `locales/${code}.json`,
        `${JSON.stringify(translated, null, 2)}\n`,
        "i18n:translate",
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Translation failed";
      ui.warn(`Could not translate ${code}: ${message}`);
      if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
    }
  }
}

async function translateOne(
  client: LlmClient,
  enJson: unknown,
  locale: string,
): Promise<unknown> {
  const raw = await client.complete(
    [
      {
        role: "system",
        content:
          "You translate app UI string catalogues. Preserve JSON keys and structure exactly. Reply with JSON only.",
      },
      {
        role: "user",
        content: `Translate every string value in this JSON catalogue into locale "${locale}".
Keep the exact same nested object keys. Do not add or remove keys.
Return only the translated JSON object.

${JSON.stringify(enJson, null, 2)}`,
      },
    ],
    { json: true, temperature: 0.2, maxTokens: 8192 },
  );

  const parsed = extractJson<unknown>(raw);
  // Soft check: top-level keys should match.
  if (
    enJson &&
    typeof enJson === "object" &&
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(enJson) &&
    !Array.isArray(parsed)
  ) {
    const expected = Object.keys(enJson as object)
      .sort()
      .join(",");
    const got = Object.keys(parsed as object)
      .sort()
      .join(",");
    if (expected && got && expected !== got) {
      throw new RadianceError(
        `Translated ${locale} JSON has different top-level keys`,
        "Leaving the English clone in place for that locale.",
      );
    }
  }

  return parsed;
}
