import { Entry } from "@napi-rs/keyring";

import type { ProviderId } from "./config.js";
import { RadianceError } from "./logger.js";

/** Providers that need an API key (Ollama does not). */
export type CloudProviderId = Exclude<ProviderId, "ollama">;

export const CLOUD_PROVIDERS: readonly CloudProviderId[] = [
  "anthropic",
  "openai",
  "cursor",
];

export const ENV_KEY_BY_PROVIDER: Record<CloudProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  cursor: "CURSOR_API_KEY",
};

const SERVICE = "radiance-cli";

export function isCloudProvider(id: string): id is CloudProviderId {
  return (CLOUD_PROVIDERS as readonly string[]).includes(id);
}

function entryFor(provider: CloudProviderId): Entry {
  return new Entry(SERVICE, provider);
}

/** Where a resolved key came from (for doctor / config list). */
export type ApiKeySource = "env" | "keychain";

export type ResolvedApiKey = {
  value: string;
  source: ApiKeySource;
};

/**
 * Resolve an API key: environment variable wins, then OS keychain.
 * Returns undefined when neither is set (keychain miss is not an error).
 */
export function resolveApiKey(
  provider: CloudProviderId,
): ResolvedApiKey | undefined {
  const envName = ENV_KEY_BY_PROVIDER[provider];
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return { value: fromEnv, source: "env" };

  try {
    const fromKeychain = entryFor(provider).getPassword()?.trim();
    if (fromKeychain) return { value: fromKeychain, source: "keychain" };
  } catch {
    // Missing entry or keychain unavailable — treat as unset.
  }

  return undefined;
}

/** True when env or keychain has a key for this provider (does not read the secret into logs). */
export function hasApiKey(provider: CloudProviderId): boolean {
  return Boolean(resolveApiKey(provider));
}

export function setApiKey(provider: CloudProviderId, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RadianceError(
      "API key cannot be empty",
      `Pass a value or run \`radiance config set-key ${provider}\` and type it when prompted.`,
    );
  }

  try {
    entryFor(provider).setPassword(trimmed);
  } catch (error) {
    throw new RadianceError(
      `Could not store the ${provider} key in the OS keychain`,
      error instanceof Error ? error.message : keychainHint(),
    );
  }
}

export function deleteApiKey(provider: CloudProviderId): boolean {
  try {
    entryFor(provider).deletePassword();
    return true;
  } catch {
    return false;
  }
}

/** Summaries for `radiance config list` — never includes the secret itself. */
export function apiKeyStatuses(): {
  provider: CloudProviderId;
  status: string;
}[] {
  return CLOUD_PROVIDERS.map((provider) => {
    const resolved = resolveApiKey(provider);
    if (!resolved) {
      return { provider, status: "(unset)" };
    }
    if (resolved.source === "env") {
      return { provider, status: `${ENV_KEY_BY_PROVIDER[provider]} (env)` };
    }
    return { provider, status: "keychain" };
  });
}

function keychainHint(): string {
  if (process.platform === "linux") {
    return "Is a Secret Service (libsecret / gnome-keyring / kwallet) available?";
  }
  if (process.platform === "darwin") {
    return "Is the macOS Keychain unlocked?";
  }
  if (process.platform === "win32") {
    return "Is Windows Credential Manager available?";
  }
  return "OS keychain unavailable on this platform.";
}
