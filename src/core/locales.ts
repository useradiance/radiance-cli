import { insertAtMarker, insertImport } from "./apply/markers.js";
import type { Workspace } from "./apply/workspace.js";

const I18N_PATH = "lib/i18n.tsx";
const EN_LOCALE_PATH = "locales/en.json";

/** Clone English strings into missing locale files and register them in i18n. */
export async function materializeLocales(
  workspace: Workspace,
  locales: string[],
): Promise<string[]> {
  const unique = [
    ...new Set(locales.map((code) => code.trim()).filter(Boolean)),
  ];
  if (unique.length === 0) return [];

  const enRaw = await workspace.read(EN_LOCALE_PATH);
  if (!enRaw) {
    workspace.note(
      "warn",
      "locales/en.json missing — skipping locale materialization",
      "i18n",
    );
    return [];
  }

  // Pretty-print clone so non-en files are editable.
  let enJson: unknown;
  try {
    enJson = JSON.parse(enRaw);
  } catch {
    workspace.note("warn", "locales/en.json is not valid JSON", "i18n");
    return [];
  }
  const cloned = `${JSON.stringify(enJson, null, 2)}\n`;

  const created: string[] = [];
  for (const code of unique) {
    if (code === "en") continue;
    const path = `locales/${code}.json`;
    if (await workspace.exists(path)) continue;
    await workspace.write(path, cloned, "i18n:locales");
    created.push(code);
  }

  const i18n = await workspace.read(I18N_PATH);
  if (!i18n) {
    workspace.note(
      "warn",
      `${I18N_PATH} missing — locale files created but not registered`,
      "i18n",
    );
    return created;
  }

  let next = i18n;
  for (const code of unique) {
    if (code === "en") continue;
    const importLine = `import ${localeImportName(code)} from '@/locales/${code}.json';`;
    next = insertImport(next, importLine);
    const resourceLine = `${code}: { translation: ${localeImportName(code)} },`;
    next = insertAtMarker(next, "locales", resourceLine);
  }

  if (next !== i18n) {
    await workspace.write(I18N_PATH, next, "i18n:locales");
  }

  return created;
}

/** Safe TS identifier for a locale import (e.g. zh-CN → zhCN). */
export function localeImportName(code: string): string {
  const cleaned = code.replace(/[^a-zA-Z0-9]+/g, "_");
  const parts = cleaned.split("_").filter(Boolean);
  if (parts.length === 0) return "locale";
  return parts
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("");
}
