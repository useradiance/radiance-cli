import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import semver from "semver";

import { listCachedVersions, readCacheState } from "../core/cache.js";
import { loadConfig, resolveModel } from "../core/config.js";
import { ui } from "../core/logger.js";
import {
  PACKAGE_MANAGERS,
  commandVersion,
  detectFromLockfile,
  detectInstalled,
  formatInstallHint,
  type PackageManager,
} from "../core/package-manager.js";
import { findProjectRoot, readProjectConfig } from "../core/project.js";
import {
  CLOUD_PROVIDERS,
  ENV_KEY_BY_PROVIDER,
  hasApiKey,
  isCloudProvider,
  resolveApiKey,
} from "../core/secrets.js";

type CheckStatus = "ok" | "warn" | "fail";

type Check = {
  label: string;
  status: CheckStatus;
  detail: string;
};

const SYMBOLS: Record<CheckStatus, string> = {
  ok: pc.green("✓"),
  warn: pc.yellow("!"),
  fail: pc.red("✗"),
};

export async function doctorCommand(): Promise<void> {
  const config = await loadConfig();
  const checks: Check[] = [];

  const node = process.versions.node;
  checks.push({
    label: "Node",
    status: semver.gte(node, "22.13.0") ? "ok" : "fail",
    detail: semver.gte(node, "22.13.0")
      ? node
      : `${node} — Expo SDK 57 needs 22.13 or newer`,
  });

  checks.push(...(await packageManagerChecks(config.packageManager)));

  const gitVersion = await commandVersion("git", ["--version"]);
  checks.push({
    label: "git",
    status: gitVersion ? "ok" : "warn",
    detail: gitVersion ?? "not found — needed to download template releases",
  });

  const firebaseVersion = await commandVersion("firebase", ["--version"]);
  checks.push({
    label: "firebase-tools",
    status: firebaseVersion ? "ok" : "warn",
    detail:
      firebaseVersion ??
      "not found — only needed for deploys and emulators (`npm i -g firebase-tools`)",
  });

  const easVersion = await commandVersion("eas", ["--version"]);
  checks.push({
    label: "eas-cli",
    status: easVersion ? "ok" : "warn",
    detail:
      easVersion ??
      "not found — needed for mobile builds (`npm i -g eas-cli`, then `eas login`)",
  });

  checks.push(await llmCheck(config));
  checks.push(...(await templateChecks(config)));
  checks.push(...(await projectChecks()));

  ui.heading("radiance doctor");
  for (const check of checks) {
    console.log(
      `  ${SYMBOLS[check.status]} ${check.label.padEnd(18)} ${pc.dim(check.detail)}`,
    );
  }

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;

  ui.blank();
  if (failures > 0) {
    ui.error(`${failures} blocking issue${failures === 1 ? "" : "s"} to fix.`);
    process.exitCode = 1;
  } else if (warnings > 0) {
    ui.info(
      `${warnings} optional item${warnings === 1 ? "" : "s"} not configured.`,
    );
  } else {
    ui.success("Everything checks out.");
  }
}

async function packageManagerChecks(
  preferred: PackageManager | undefined,
): Promise<Check[]> {
  const installed = await detectInstalled();
  const present = PACKAGE_MANAGERS.filter((pm) => installed[pm]);
  const missing = PACKAGE_MANAGERS.filter((pm) => !installed[pm]);

  if (present.length === 0) {
    return [
      {
        label: "package managers",
        status: "fail",
        detail: `none found — install one of: ${PACKAGE_MANAGERS.join(", ")}`,
      },
    ];
  }

  if (preferred && !installed[preferred]) {
    return [
      {
        label: "package managers",
        status: "fail",
        detail: `default ${preferred} not installed (have ${present.join(", ")}; missing ${missing.join(", ")})`,
      },
    ];
  }

  const installedDetail = present
    .map((pm) => `${pm} ${installed[pm]}${preferred === pm ? "*" : ""}`)
    .join(", ");
  const missingDetail =
    missing.length > 0 ? ` · missing ${missing.join(", ")}` : "";
  const defaultDetail = preferred
    ? ""
    : " · set default with `radiance config set packageManager <name>`";

  return [
    {
      label: "package managers",
      status: "ok",
      detail: `${installedDetail}${missingDetail}${defaultDetail}`,
    },
  ];
}

async function llmCheck(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<Check> {
  const model = resolveModel(config);

  if (config.provider === "ollama") {
    try {
      const response = await fetch(`${config.ollamaHost}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return {
          label: "LLM provider",
          status: "warn",
          detail: `ollama at ${config.ollamaHost} did not respond`,
        };
      }

      const payload = (await response.json()) as {
        models?: { name?: string; model?: string }[];
      };
      const installed = (payload.models ?? [])
        .map((entry) => entry.name ?? entry.model)
        .filter((name): name is string => Boolean(name));

      const exact = installed.includes(model);
      const tagMatch = installed.some(
        (name) =>
          name === model ||
          name.startsWith(`${model}:`) ||
          model.startsWith(`${name}:`),
      );

      if (exact || tagMatch) {
        return {
          label: "LLM provider",
          status: "ok",
          detail: `ollama ${model}`,
        };
      }

      const available = installed.length > 0 ? installed.join(", ") : "(none)";
      return {
        label: "LLM provider",
        status: "warn",
        detail: `ollama model "${model}" not installed — have: ${available}. \`radiance config set model <name>\` or \`ollama pull ${model}\``,
      };
    } catch {
      return {
        label: "LLM provider",
        status: "warn",
        detail: `ollama not reachable at ${config.ollamaHost}`,
      };
    }
  }

  if (!isCloudProvider(config.provider)) {
    return {
      label: "LLM provider",
      status: "warn",
      detail: `unknown provider "${config.provider}"`,
    };
  }

  const envKey = ENV_KEY_BY_PROVIDER[config.provider];
  const resolved = resolveApiKey(config.provider);

  if (resolved) {
    const via = resolved.source === "env" ? "env" : "keychain";
    return {
      label: "LLM provider",
      status: "ok",
      detail: `${config.provider} ${model} (${via})`,
    };
  }

  const other = CLOUD_PROVIDERS.find(
    (provider) => provider !== config.provider && hasApiKey(provider),
  );

  // No cloud keys at all — don't single out the default Anthropic key.
  if (!other) {
    return {
      label: "LLM provider",
      status: "warn",
      detail:
        "no LLM configured — `radiance config set-key <provider>`, export ANTHROPIC_API_KEY / OPENAI_API_KEY / CURSOR_API_KEY, or `radiance config set provider ollama`",
    };
  }

  // Configured provider's key is missing, but another provider's key is present.
  const otherSource = resolveApiKey(other)?.source ?? "keychain";
  return {
    label: "LLM provider",
    status: "warn",
    detail: `${envKey} not set (${other} is via ${otherSource}) — \`radiance config set-key ${config.provider}\`, or \`radiance config set provider ${other}\``,
  };
}

async function templateChecks(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<Check[]> {
  if (config.templatesPath) {
    const valid = existsSync(join(config.templatesPath, "registry.json"));
    return [
      {
        label: "templates",
        status: valid ? "ok" : "fail",
        detail: valid
          ? `local checkout ${config.templatesPath}`
          : `${config.templatesPath} has no registry.json`,
      },
    ];
  }

  const state = await readCacheState();
  const cached = await listCachedVersions();

  return [
    {
      label: "templates cache",
      status: state.activeVersion ? "ok" : "warn",
      detail: state.activeVersion
        ? `active ${state.activeVersion}${cached.length > 1 ? ` (${cached.length} cached)` : ""}`
        : "empty — will download on first use",
    },
  ];
}

async function projectChecks(): Promise<Check[]> {
  const root = findProjectRoot();
  if (!root) {
    return [
      {
        label: "project",
        status: "warn",
        detail: "not inside a Radiance project",
      },
    ];
  }

  const project = await readProjectConfig(root);
  const checks: Check[] = [
    {
      label: "project",
      status: "ok",
      detail: `${project.name} · ${project.template ?? "scaffold"} · ${project.features.length} modules`,
    },
  ];

  const detected = detectFromLockfile(root);
  const projectPm = project.packageManager ?? detected;
  if (projectPm) {
    checks.push({
      label: "project pm",
      status: "ok",
      detail: project.packageManager
        ? project.packageManager
        : `${detected} (from lockfile)`,
    });
  }

  const state = await readCacheState();
  if (state.activeVersion && state.activeVersion !== project.registryVersion) {
    checks.push({
      label: "template pin",
      status: "warn",
      detail: `project on ${project.registryVersion}, cache on ${state.activeVersion} — \`radiance update --project\``,
    });
  }

  const hasEnv = existsSync(join(root, ".env"));
  checks.push({
    label: "firebase config",
    status: hasEnv ? "ok" : "warn",
    detail: hasEnv
      ? ".env present"
      : "no .env — run `radiance setup firebase` (or copy .env.example)",
  });

  if (project.plan) {
    checks.push({
      label: "plan",
      status: "ok",
      detail:
        project.plan === "paid"
          ? "paid — cloud Storage & Functions allowed"
          : "free — Storage & Functions via emulators only",
    });
  } else if (hasEnv) {
    checks.push({
      label: "plan",
      status: "warn",
      detail: "not set — run `radiance setup firebase` to choose free or paid",
    });
  }

  const hasModules = existsSync(join(root, "node_modules"));
  const installHint = formatInstallHint(projectPm ?? "npm");
  checks.push({
    label: "dependencies",
    status: hasModules ? "ok" : "warn",
    detail: hasModules ? "installed" : `run \`${installHint}\``,
  });

  return checks;
}
