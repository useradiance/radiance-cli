import * as prompts from "@clack/prompts";
import pc from "picocolors";

import {
  GlobalConfigSchema,
  loadConfig,
  saveConfig,
  type GlobalConfig,
} from "../core/config.js";
import { RadianceError, ui } from "../core/logger.js";
import { configFile } from "../core/paths.js";
import {
  apiKeyStatuses,
  CLOUD_PROVIDERS,
  deleteApiKey,
  isCloudProvider,
  setApiKey,
  type CloudProviderId,
} from "../core/secrets.js";

/** User-facing aliases → canonical config keys. */
const KEY_ALIASES: Record<string, keyof GlobalConfig> = {
  pm: "packageManager",
  "package-manager": "packageManager",
  packagemanager: "packageManager",
};

function resolveConfigKey(raw: string): keyof GlobalConfig {
  const trimmed = raw.trim();
  const aliased = KEY_ALIASES[trimmed.toLowerCase()];
  if (aliased) return aliased;

  const shape = GlobalConfigSchema.shape as Record<string, unknown>;
  if (trimmed in shape) return trimmed as keyof GlobalConfig;

  throw new RadianceError(
    `Unknown setting "${raw}"`,
    `Valid keys: ${Object.keys(shape).join(", ")} (aliases: pm → packageManager)`,
  );
}

export async function configShowCommand(): Promise<void> {
  const config = await loadConfig();
  const shape = GlobalConfigSchema.shape as Record<string, unknown>;

  ui.heading("Radiance configuration");
  ui.detail(configFile());
  ui.blank();

  for (const key of Object.keys(shape)) {
    const value = config[key as keyof GlobalConfig];
    const display =
      value === undefined || value === "" ? pc.dim("(unset)") : String(value);
    console.log(`  ${pc.bold(key.padEnd(18))} ${display}`);
  }

  ui.blank();
  ui.heading("API keys");
  ui.detail("Stored in the OS keychain (or env). Values are never printed.");
  for (const { provider, status } of apiKeyStatuses()) {
    const display = status === "(unset)" ? pc.dim(status) : status;
    console.log(`  ${pc.bold(provider.padEnd(18))} ${display}`);
  }

  ui.blank();
  ui.detail("Change a value with `radiance config set <key> <value>`.");
  ui.detail("Store a provider key with `radiance config set-key <provider>`.");
  ui.detail(
    "Example: `radiance config set packageManager yarn` (alias: `pm`).",
  );
}

export async function configSetCommand(
  key: string,
  rawValue: string,
): Promise<void> {
  const resolvedKey = resolveConfigKey(key);
  const current = await loadConfig();
  const value = coerce(rawValue);
  const candidate = { ...current, [resolvedKey]: value };

  const parsed = GlobalConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new RadianceError(
      `"${rawValue}" is not valid for ${resolvedKey}`,
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }

  await saveConfig(parsed.data);
  ui.success(`${resolvedKey} = ${String(parsed.data[resolvedKey])}`);
}

export async function configGetCommand(key: string): Promise<void> {
  const resolvedKey = resolveConfigKey(key);
  const config = await loadConfig();
  const value = config[resolvedKey];
  console.log(value === undefined ? "" : String(value));
}

export async function configSetKeyCommand(
  providerRaw: string,
  value?: string,
): Promise<void> {
  const provider = parseCloudProvider(providerRaw);
  let secret = value?.trim();

  if (!secret) {
    const answered = await prompts.password({
      message: `API key for ${provider}`,
      validate: (input) => (input?.trim() ? undefined : "Key cannot be empty"),
    });
    if (prompts.isCancel(answered)) throw new RadianceError("Cancelled.");
    secret = answered.trim();
  }

  setApiKey(provider, secret);
  ui.success(`${provider} API key stored in the OS keychain`);
  ui.detail(`Env ${providerEnvHint(provider)} still wins when set.`);
}

export async function configUnsetKeyCommand(
  providerRaw: string,
): Promise<void> {
  const provider = parseCloudProvider(providerRaw);
  const removed = deleteApiKey(provider);
  if (removed) {
    ui.success(`${provider} API key removed from the OS keychain`);
  } else {
    ui.info(`No ${provider} key found in the OS keychain`);
  }
  ui.detail(`Env ${providerEnvHint(provider)} is unchanged.`);
}

function parseCloudProvider(raw: string): CloudProviderId {
  const id = raw.trim().toLowerCase();
  if (!isCloudProvider(id)) {
    throw new RadianceError(
      `Unknown provider "${raw}"`,
      `Choose ${CLOUD_PROVIDERS.join(", ")}. Ollama needs no key.`,
    );
  }
  return id;
}

function providerEnvHint(provider: CloudProviderId): string {
  return {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    cursor: "CURSOR_API_KEY",
  }[provider];
}

function coerce(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  // Keep package manager names and similar tokens as strings (avoid Number("")).
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
