import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Agent, CursorAgentError } from "@cursor/sdk";
import OpenAI from "openai";

import {
  resolveModel,
  type GlobalConfig,
  type ProviderId,
} from "../core/config.js";
import { RadianceError } from "../core/logger.js";
import {
  ENV_KEY_BY_PROVIDER,
  resolveApiKey,
  type CloudProviderId,
} from "../core/secrets.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompleteOptions = {
  /** Ask the provider for a single JSON object. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
};

export type LlmClient = {
  readonly provider: ProviderId;
  readonly model: string;
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>;
};

const DEFAULT_MAX_TOKENS = 8192;
const CURSOR_RIPGREP_ENV = "CURSOR_RIPGREP_PATH";

function splitSystem(messages: ChatMessage[]): {
  system: string;
  rest: { role: "user" | "assistant"; content: string }[];
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const rest = messages
    .filter(
      (message): message is ChatMessage & { role: "user" | "assistant" } =>
        message.role !== "system",
    )
    .map((message) => ({ role: message.role, content: message.content }));

  return { system, rest };
}

function requireApiKey(provider: CloudProviderId): string {
  const resolved = resolveApiKey(provider);
  if (!resolved) {
    const envName = ENV_KEY_BY_PROVIDER[provider];
    throw new RadianceError(
      `${envName} is not set`,
      [
        `\`radiance prompt\` needs it to reach ${provider}.`,
        `Store it with \`radiance config set-key ${provider}\`, export ${envName}, or switch providers with \`radiance config set provider ollama\`.`,
      ].join(" "),
    );
  }
  return resolved.value;
}

/** Cursor local agents need an rg binary to initialize ignore mappings. */
function ensureCursorRipgrepPath(): void {
  const configured = process.env[CURSOR_RIPGREP_ENV];
  if (configured && isAbsolute(configured)) return;

  const systemRg = resolveSystemRipgrepPath();
  if (systemRg) {
    process.env[CURSOR_RIPGREP_ENV] = systemRg;
    return;
  }

  const bundledRg = resolveBundledCursorRipgrepPath();
  if (bundledRg) {
    process.env[CURSOR_RIPGREP_ENV] = bundledRg;
  }
}

function resolveSystemRipgrepPath(): string | undefined {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, ["rg"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;

  const candidate = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!candidate || !isAbsolute(candidate)) return undefined;

  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function resolveBundledCursorRipgrepPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
    const sdkEntry = require.resolve("@cursor/sdk");
    const packageDir = dirname(
      require.resolve(`${platformPackage}/package.json`, {
        paths: [dirname(sdkEntry)],
      }),
    );
    const candidate = join(
      packageDir,
      "bin",
      process.platform === "win32" ? "rg.exe" : "rg",
    );
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function anthropicClient(model: string): LlmClient {
  const client = new Anthropic({ apiKey: requireApiKey("anthropic") });

  return {
    provider: "anthropic",
    model,
    async complete(messages, options = {}) {
      const { system, rest } = splitSystem(messages);

      // Prefilling an opening brace is the reliable way to get JSON-only output from Claude.
      const primed = options.json
        ? [...rest, { role: "assistant" as const, content: "{" }]
        : rest;

      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature ?? 0,
        ...(system ? { system } : {}),
        messages: primed,
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      return options.json ? `{${text}` : text;
    },
  };
}

function openAiClient(model: string): LlmClient {
  const client = new OpenAI({ apiKey: requireApiKey("openai") });

  return {
    provider: "openai",
    model,
    async complete(messages, options = {}) {
      const response = await client.chat.completions.create({
        model,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        ...(options.json
          ? { response_format: { type: "json_object" as const } }
          : {}),
      });

      return response.choices[0]?.message?.content ?? "";
    },
  };
}

function ollamaClient(model: string, host: string): LlmClient {
  return {
    provider: "ollama",
    model,
    async complete(messages, options = {}) {
      let response: Response;

      try {
        response = await fetch(`${host}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            ...(options.json ? { format: "json" } : {}),
            options: { temperature: options.temperature ?? 0 },
          }),
        });
      } catch (error) {
        throw new RadianceError(
          `Could not reach Ollama at ${host}`,
          error instanceof Error ? error.message : "Is `ollama serve` running?",
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new RadianceError(
          `Ollama returned ${response.status} for model "${model}"`,
          await ollamaFailureHint(host, model, body),
        );
      }

      const payload = (await response.json()) as {
        message?: { content?: string };
      };
      return payload.message?.content ?? "";
    },
  };
}

/** Flatten chat turns into a single prompt — Cursor Agent.prompt takes one message. */
function flattenMessages(messages: ChatMessage[], json: boolean): string {
  const { system, rest } = splitSystem(messages);
  const parts: string[] = [];

  if (system) {
    parts.push(`System:\n${system}`);
  }

  for (const message of rest) {
    const label = message.role === "assistant" ? "Assistant" : "User";
    parts.push(`${label}:\n${message.content}`);
  }

  if (json) {
    parts.push(
      "Respond with a single JSON object only. No markdown fences, no prose outside the object.",
    );
  }

  return parts.join("\n\n");
}

function cursorClient(model: string): LlmClient {
  const apiKey = requireApiKey("cursor");

  return {
    provider: "cursor",
    model,
    async complete(messages, options = {}) {
      ensureCursorRipgrepPath();
      const prompt = flattenMessages(messages, Boolean(options.json));

      let result;
      try {
        result = await Agent.prompt(prompt, {
          apiKey,
          model: { id: model },
          local: { cwd: process.cwd() },
          tools: [],
        });
      } catch (error) {
        if (error instanceof CursorAgentError) {
          throw new RadianceError(
            `Cursor agent failed to start`,
            error.message,
          );
        }
        throw error;
      }

      if (result.status !== "finished") {
        throw new RadianceError(
          `Cursor run ${result.status}`,
          result.result?.trim() ||
            `Run id ${result.id} ended without a finished result.`,
        );
      }

      return result.result ?? "";
    },
  };
}

type OllamaTags = {
  models?: { name?: string; model?: string }[];
};

/** Lists local Ollama model names (`name` field from `/api/tags`). */
export async function listOllamaModels(host: string): Promise<string[]> {
  const response = await fetch(`${host}/api/tags`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) return [];

  const payload = (await response.json()) as OllamaTags;
  return (payload.models ?? [])
    .map((entry) => entry.name ?? entry.model)
    .filter((name): name is string => Boolean(name));
}

async function ollamaFailureHint(
  host: string,
  model: string,
  body: string,
): Promise<string> {
  const parsed = (() => {
    try {
      return JSON.parse(body) as { error?: string };
    } catch {
      return undefined;
    }
  })();

  const ollamaMessage = parsed?.error?.trim();
  const looksMissing =
    /not found/i.test(ollamaMessage ?? "") ||
    /not found/i.test(body) ||
    body.toLowerCase().includes("model");

  if (looksMissing || /404/.test(String(body))) {
    let available: string[] = [];
    try {
      available = await listOllamaModels(host);
    } catch {
      // Reachability already proved by the chat call; tags are best-effort.
    }

    const installed =
      available.length > 0
        ? `Installed: ${available.join(", ")}.`
        : "Could not list installed models.";

    return [
      ollamaMessage || body.slice(0, 200) || "Model not available to Ollama.",
      installed,
      `Set one with \`radiance config set model <name>\` or pass \`--model ${available[0] ?? "deepseek-r1:14b"}\`.`,
      `Running \`ollama run …\` only loads a session — the API still needs the model name Radiance is configured to use.`,
    ].join(" ");
  }

  return (
    ollamaMessage ||
    body.slice(0, 400) ||
    "Check \`ollama serve\` and the model name."
  );
}

export function createClient(
  config: GlobalConfig,
  overrides: Partial<GlobalConfig> = {},
): LlmClient {
  const merged = { ...config, ...overrides };
  const model = resolveModel(merged);

  switch (merged.provider) {
    case "anthropic":
      return anthropicClient(model);
    case "openai":
      return openAiClient(model);
    case "ollama":
      return ollamaClient(model, merged.ollamaHost);
    case "cursor":
      return cursorClient(model);
  }
}

/** Pulls the first JSON object out of a reply, tolerating prose or code fences around it. */
export function extractJson<T>(raw: string): T {
  // Only strip a fence that wraps the *entire* reply. Matching ``` anywhere would clip into
  // string values (e.g. `"contents": "```typescript\n…"`), which is how edits commonly fail.
  const trimmed = raw.trim();
  const wholeFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = (wholeFence?.[1] ?? trimmed).trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new RadianceError(
      "The model did not return JSON",
      [
        `Received ${raw.length} characters with no JSON object.`,
        "",
        "Response preview:",
        previewModelOutput(candidate || raw || "(empty)"),
      ].join("\n"),
    );
  }

  const slice = candidate.slice(start, end + 1);

  try {
    return JSON.parse(slice) as T;
  } catch (error) {
    const parseMessage =
      error instanceof Error ? error.message : "JSON.parse failed";
    throw new RadianceError(
      "The model returned malformed JSON",
      [
        parseMessage,
        `Extracted ${slice.length} characters between the first "{" and last "}".`,
        "",
        "Response preview:",
        previewModelOutput(slice),
      ].join("\n"),
    );
  }
}

/** Truncate model output for inline error hints (full text goes in the dump file). */
export function previewModelOutput(raw: string, limit = 600): string {
  const trimmed = raw.trim().replace(/\r\n/g, "\n");
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n… (${trimmed.length - limit} more characters)`;
}
