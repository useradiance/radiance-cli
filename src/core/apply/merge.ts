type Json = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Recursive merge where `source` wins on scalars and arrays are concatenated without dupes. */
export function deepMerge<T extends Json>(target: T, source: Json): T {
  const result: Json = { ...target };

  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];

    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      const merged = [...existing];
      for (const item of value) {
        const serialized = JSON.stringify(item);
        if (
          !merged.some((candidate) => JSON.stringify(candidate) === serialized)
        ) {
          merged.push(item);
        }
      }
      result[key] = merged;
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

export type LocaleMergeResult = {
  merged: Json;
  /** Keys the incoming file wanted to change; the project's value is kept. */
  conflicts: string[];
};

/**
 * Merges translation resources.
 *
 * Existing values always win: a user who reworded a string should not have it reverted by
 * reinstalling a module.
 */
export function mergeLocales(
  existing: Json,
  incoming: Json,
  prefix = "",
): LocaleMergeResult {
  const merged: Json = { ...existing };
  const conflicts: string[] = [];

  for (const [key, value] of Object.entries(incoming)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const current = merged[key];

    if (isPlainObject(value)) {
      const nested = mergeLocales(
        isPlainObject(current) ? current : {},
        value,
        path,
      );
      merged[key] = nested.merged;
      conflicts.push(...nested.conflicts);
    } else if (current === undefined) {
      merged[key] = value;
    } else if (current !== value) {
      conflicts.push(path);
    }
  }

  return { merged, conflicts };
}

export type PackageMergeInput = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

export type PackageMergeResult = {
  merged: Json;
  /** Packages already present at a different version — left alone, reported to the user. */
  versionConflicts: { name: string; existing: string; requested: string }[];
};

export function mergePackageJson(
  existing: Json,
  input: PackageMergeInput,
): PackageMergeResult {
  const merged: Json = { ...existing };
  const versionConflicts: PackageMergeResult["versionConflicts"] = [];

  for (const field of ["dependencies", "devDependencies"] as const) {
    const incoming = input[field];
    if (!incoming || Object.keys(incoming).length === 0) continue;

    const current = isPlainObject(merged[field])
      ? { ...(merged[field] as Json) }
      : {};

    for (const [name, version] of Object.entries(incoming)) {
      const existingVersion = current[name];
      if (typeof existingVersion === "string" && existingVersion !== version) {
        versionConflicts.push({
          name,
          existing: existingVersion,
          requested: version,
        });
        continue;
      }
      current[name] = version;
    }

    merged[field] = sortKeys(current);
  }

  if (input.scripts && Object.keys(input.scripts).length > 0) {
    const current = isPlainObject(merged.scripts)
      ? { ...(merged.scripts as Json) }
      : {};
    for (const [name, script] of Object.entries(input.scripts)) {
      if (current[name] === undefined) current[name] = script;
    }
    merged.scripts = current;
  }

  return { merged, versionConflicts };
}

function sortKeys(value: Json): Json {
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  );
}

type FirestoreIndexes = {
  indexes?: unknown[];
  fieldOverrides?: unknown[];
};

/** Union of composite indexes, deduplicated by content. */
export function mergeIndexes(
  existing: FirestoreIndexes,
  incoming: FirestoreIndexes,
): Json {
  return deepMerge(
    {
      indexes: existing.indexes ?? [],
      fieldOverrides: existing.fieldOverrides ?? [],
    },
    {
      indexes: incoming.indexes ?? [],
      fieldOverrides: incoming.fieldOverrides ?? [],
    },
  );
}

export function parseJson<T extends Json>(
  contents: string | null,
  fallback: T,
): T {
  if (!contents) return fallback;
  try {
    return JSON.parse(contents) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Appends a module's variables to `.env.example`, once. */
export function appendEnvExample(
  existing: string,
  moduleId: string,
  entries: Record<string, string | { description: string }>,
): string {
  const descriptions = Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.description,
    ]),
  );
  const keys = Object.keys(descriptions).filter(
    (key) => !existing.includes(`${key}=`),
  );
  if (keys.length === 0) return existing;

  const block = [
    "",
    `# ${moduleId}`,
    ...keys.map((key) => `# ${descriptions[key]}\n${key}=`),
  ].join("\n");

  return `${existing.trimEnd()}\n${block}\n`;
}
