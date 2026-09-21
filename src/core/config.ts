import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

import { PackageManagerSchema } from "./package-manager.js";
import { configDir, configFile } from "./paths.js";

export const DEFAULT_TEMPLATES_REPO =
  "https://github.com/useradiance/radiance-templates.git";

const ProviderSchema = z.enum(["ollama", "openai", "anthropic", "cursor"]);
export type ProviderId = z.infer<typeof ProviderSchema>;

export const GlobalConfigSchema = z.object({
  templatesRepo: z.string().default(DEFAULT_TEMPLATES_REPO),
  /** Local checkout used instead of the cache — for developing the catalogue itself. */
  templatesPath: z.string().optional(),
  /** `latest` follows releases; a version string pins the cache. */
  templatesChannel: z.string().default("latest"),
  provider: ProviderSchema.default("anthropic"),
  model: z.string().optional(),
  ollamaHost: z.string().default("http://localhost:11434"),
  /** Default package manager for `radiance init` when `--pm` is omitted. */
  packageManager: PackageManagerSchema.optional(),
  gitAutoCommit: z.boolean().default(false),
  verify: z.boolean().default(true),
  maxFixIterations: z.number().int().min(0).max(5).default(2),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.1",
  ollama: "qwen2.5-coder:14b",
  cursor: "composer-2.5",
};

export async function loadConfig(): Promise<GlobalConfig> {
  let raw: unknown = {};

  try {
    raw = JSON.parse(await readFile(configFile(), "utf8"));
  } catch {
    // No config yet — defaults apply.
  }

  const config = GlobalConfigSchema.parse(raw);

  // Environment wins so CI and the templates repo's own development loop can override.
  const templatesPath =
    process.env.RADIANCE_TEMPLATES_PATH ?? config.templatesPath;
  return { ...config, ...(templatesPath ? { templatesPath } : {}) };
}

export async function saveConfig(config: GlobalConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configFile(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveModel(config: GlobalConfig): string {
  return config.model ?? DEFAULT_MODELS[config.provider];
}
