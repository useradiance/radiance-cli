import * as prompts from "@clack/prompts";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import pc from "picocolors";

import { applyChanges, reportNotes } from "../core/apply/writer.js";
import { ensureTemplateSource } from "../core/cache.js";
import { loadConfig } from "../core/config.js";
import { applyCustomThemePack } from "../core/custom-theme.js";
import { RadianceError, bindLogSession, ui } from "../core/logger.js";
import { materializeLocales } from "../core/locales.js";
import {
  maybeSweepI18n,
  maybeTranslateLocales,
} from "../core/locale-pipeline.js";
import { offerFollowUpPrompt } from "../harness/follow-up-offer.js";
import { deriveVars, stageInstall } from "../core/install.js";
import { upsertWorkspaceEnv } from "../core/env.js";
import {
  PACKAGE_MANAGERS,
  detectInstalled,
  formatInstallHint,
  formatInstallInDirHint,
  formatRunHint,
  installCommand,
  installInDirCommand,
  parsePackageManager,
  resolvePackageManager,
  type PackageManager,
} from "../core/package-manager.js";
import { writeProjectConfig, type ProjectConfig } from "../core/project.js";
import { timed } from "../core/timings.js";
import { runInitInterview } from "../harness/init-interview.js";
import { planToOptionFlags } from "../harness/init-slots.js";
import { isThemeColors, type ThemePackData } from "../harness/theme-palette.js";
import { setupFirebase, parsePlanFlag } from "./setup-firebase.js";

export type InitOptions = {
  template?: string;
  scaffold?: boolean;
  themePack?: string;
  locale?: string;
  bundleId?: string;
  templateVersion?: string;
  packageManager?: string;
  pm?: string;
  install?: boolean;
  git?: boolean;
  firebase?: boolean;
  plan?: string;
  yes?: boolean;
  option?: string[];
  prompt?: string;
  provider?: string;
  model?: string;
  demo?: boolean;
  /**
   * The name the app shows, when it should differ from its directory.
   *
   * The directory doubles as the display name, which is right at a terminal
   * (`radiance init my-app`) and wrong for anything that picks the directory
   * itself: the hosted platform builds in a temp dir named after an internal
   * id, and every app it generated was titled `app_4e895bmul02ewa`.
   */
  displayName?: string;
  /**
   * Write the resolved plan here as JSON — which starter was chosen, what the
   * description asked for beyond it — for callers that drive `init` without a
   * terminal and need to act on the answer.
   */
  planJson?: string;
  /**
   * Machine-translate every locale other than English after install.
   *
   * Translation was reachable only through the AI interview, which decides it
   * from the description; `--locale en,fr` on its own produced a `fr.json`
   * that was a copy of `en.json`. Needs an LLM, like the interview.
   */
  translateLocales?: boolean;
  /** `--no-i18n-sweep`: leave the hard-coded-copy sweep to a later `radiance translate`. */
  i18nSweep?: boolean;
  /** `--translation-memory <dir>`, for `--translate-locales`. */
  translationMemory?: string;
};

type ResolvedInit = {
  appName: string;
  starterId: string | null;
  packageManager: PackageManager;
  optionFlags: string[];
  themePack: string;
  locale: string;
  locales: string[];
  translateLocales?: boolean;
  customTheme?: ThemePackData;
  bundleId?: string;
  followUpPrompt?: string;
  extraModules?: string[];
  promptGaps?: string[];
  suggestedPlan?: "free" | "paid";
  openingPrompt?: string;
  /** When set, overrides the usual Firebase prompt gating. */
  firebase?: boolean;
};

export async function initCommand(
  nameArg: string | undefined,
  options: InitOptions,
): Promise<void> {
  const config = await loadConfig();
  // Timed steps (`RADIANCE_TIMINGS_FILE`): `templates` can be a download on a
  // cold cache, and `plan` holds the LLM call that reads `--prompt`.
  const source = await timed("templates", () =>
    ensureTemplateSource(
      config,
      options.templateVersion ? { version: options.templateVersion } : {},
    ),
  );

  const resolved = await timed("plan", () =>
    resolveInitSettings(nameArg, options, source, config),
  );

  const root = isAbsolute(resolved.appName)
    ? resolved.appName
    : resolve(process.cwd(), resolved.appName);
  const displayName =
    options.displayName?.trim() ||
    (resolved.appName.split("/").pop() ?? resolved.appName);

  if (options.planJson) {
    await writePlanJson(options.planJson, resolved);
  }

  if (existsSync(root) && (await readdir(root)).length > 0) {
    throw new RadianceError(
      `${root} already exists and is not empty`,
      "Pick a different name or remove the directory first.",
    );
  }

  const starter = resolved.starterId
    ? source.registry.starters.find((entry) => entry.id === resolved.starterId)
    : undefined;

  const vars = deriveVars(displayName, {
    themePack: resolved.themePack,
    defaultLocale: resolved.locale,
    ...(resolved.bundleId ? { bundleId: resolved.bundleId } : {}),
  });

  ui.heading(`Creating ${pc.bold(vars.appName)}`);
  ui.detail(
    `templates ${source.version}${source.local ? " (local checkout)" : ""}`,
  );
  ui.detail(`starter   ${resolved.starterId ?? "none (bare scaffold)"}`);
  if (resolved.extraModules?.length) {
    ui.detail(`extras    ${resolved.extraModules.join(", ")}`);
  }
  ui.detail(`theme     ${vars.themePack}`);
  ui.detail(
    `locales   ${(resolved.locales ?? [resolved.locale]).join(", ")} (default ${resolved.locale})`,
  );
  ui.detail(`pm        ${resolved.packageManager}`);
  if (resolved.suggestedPlan) {
    ui.detail(`plan      ${resolved.suggestedPlan} (suggested)`);
  }

  await mkdir(root, { recursive: true });
  bindLogSession(root);
  ui.trace(`project root ready at ${root}`);

  const extraModules = [...(resolved.extraModules ?? [])];
  if (
    options.demo &&
    !extraModules.includes("demo-data") &&
    source.registry.modules.some((module) => module.id === "demo-data")
  ) {
    extraModules.push("demo-data");
    ui.detail("extras    demo-data (--demo)");
  } else if (
    options.demo &&
    !source.registry.modules.some((module) => module.id === "demo-data")
  ) {
    ui.warn(
      "This catalogue version has no demo-data module — skipping --demo.",
    );
  }
  if (
    (resolved.locales?.length ?? 0) > 1 &&
    !extraModules.includes("locale-picker") &&
    source.registry.modules.some((module) => module.id === "locale-picker")
  ) {
    extraModules.push("locale-picker");
    ui.detail("extras    locale-picker (multi-locale)");
  }

  const staged = await timed("stage", () =>
    stageInstall({
      root,
      source,
      vars,
      scaffold: true,
      starterId: resolved.starterId,
      moduleIds: extraModules,
      installed: [],
      optionFlags: resolved.optionFlags,
      // This is `init`: an unqualified `--option key=value` (which is what
      // `--theme-pack` becomes) may target any module the starter pulls in.
      initMode: true,
      interactiveOptions: false,
      interactiveEnv: !options.yes,
      // Secrets/params may be filled later — build/deploy enforce them.
      interactiveServerConfig: false,
    }),
  );

  if (resolved.customTheme && resolved.themePack === "custom") {
    ui.trace("writing custom theme pack");
    await applyCustomThemePack(staged.workspace, resolved.customTheme);
  }

  const locales = normalizeLocales(resolved.locales, resolved.locale);
  if (locales.length > 0) {
    ui.trace(`materializing locales: ${locales.join(", ")}`);
    await materializeLocales(staged.workspace, locales);
  }

  const projectConfig: ProjectConfig = {
    name: vars.appName,
    template: resolved.starterId,
    templateVersion: starter?.version ?? null,
    registryVersion: source.registry.version,
    scaffold: {
      id: source.registry.scaffold.id,
      version: source.registry.scaffold.version,
    },
    themePack: vars.themePack,
    defaultLocale: vars.defaultLocale,
    locales,
    bundleId: vars.bundleId,
    scheme: vars.scheme,
    packageManager: resolved.packageManager,
    ...(resolved.suggestedPlan ? { plan: resolved.suggestedPlan } : {}),
    ...(options.demo ? { demo: true } : {}),
    features: staged.features,
    harness: {},
  };

  await staged.workspace.write(
    "radiance.json",
    `${JSON.stringify(projectConfig, null, 2)}\n`,
    "radiance",
  );

  if (options.demo) {
    await upsertWorkspaceEnv(
      staged.workspace,
      { EXPO_PUBLIC_SEED_DEMO: "true" },
      "demo-data",
    );
  }

  const changes = staged.workspace.changes();
  ui.trace(`writing ${changes.length} file change(s) to disk`);
  await timed("write", () =>
    applyChanges(root, changes, { confirm: false, dryRun: false }),
  );
  reportNotes(staged.workspace.getNotes());
  await writeProjectConfig(root, projectConfig);

  ui.blank();
  ui.success(`Created ${changes.length} files in ${root}`);

  if (options.git !== false) {
    ui.trace("initialising git repository");
    await timed("git", () => initGit(root));
  } else {
    ui.trace("skipping git init (--no-git)");
  }

  if (options.install !== false) {
    ui.trace(`installing dependencies with ${resolved.packageManager}`);
    await timed("install", () =>
      installDependencies(root, resolved.packageManager),
    );
  } else {
    ui.trace("skipping dependency install (--no-install)");
  }

  const firebaseOptions: InitOptions = {
    ...options,
    ...(resolved.firebase === false ? { firebase: false } : {}),
    ...(resolved.firebase === true ? { firebase: true, yes: false } : {}),
  };

  const linkedFirebase = await maybeSetupFirebase(
    root,
    vars.appName,
    firebaseOptions,
    resolved.suggestedPlan,
  );

  if (resolved.followUpPrompt) {
    const followUp = resolved.followUpPrompt;
    await timed("follow-up", () =>
      maybeRunFollowUp(root, followUp, options.yes === true),
    );
  }

  // Sweep hardcoded UI copy into locales/en.json before translating other locales.
  // `--no-i18n-sweep` defers it to whoever runs `radiance translate` later —
  // a caller that writes more code after `init` would otherwise pay for the
  // sweep twice, and the first pass would miss the strings written after it.
  const needsI18nSweep =
    options.i18nSweep !== false &&
    (resolved.translateLocales === true ||
      locales.some((code) => code !== "en"));
  if (needsI18nSweep) {
    await maybeSweepI18n(root, locales, config, options);
  }

  // Translate locale files after the i18n sweep so every English string is included.
  if (resolved.translateLocales && locales.some((code) => code !== "en")) {
    await maybeTranslateLocales(root, locales, config, options);
  }

  printNextSteps(
    resolved.appName,
    resolved.packageManager,
    options.install === false,
    linkedFirebase,
    resolved.followUpPrompt,
    resolved.suggestedPlan,
    resolved.extraModules,
  );
}

async function resolveInitSettings(
  nameArg: string | undefined,
  options: InitOptions,
  source: Awaited<ReturnType<typeof ensureTemplateSource>>,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<ResolvedInit> {
  const promptFlag = options.prompt?.trim();

  let opening = promptFlag;

  // Interactive front door: offer NL description unless starter flags / `-y` already decide.
  if (!opening && !options.yes && !options.scaffold && !options.template) {
    const answer = await prompts.text({
      message:
        "Describe what you are building (leave blank to browse starters)",
      placeholder: "an online store with Stripe and Google sign-in",
    });
    if (prompts.isCancel(answer)) throw new RadianceError("Cancelled.");
    opening = answer.trim() || undefined;
  }

  if (opening || (options.yes && promptFlag)) {
    const interview = await runInitInterview({
      nameArg,
      flags: {
        ...options,
        name: nameArg,
        prompt: opening ?? promptFlag,
        provider: options.provider,
        model: options.model,
      },
      source,
      config,
      skipOpeningPrompt: true,
    });

    const { plan } = interview;
    const locales = normalizeLocales(plan.locales, plan.locale!);
    const customTheme = coerceCustomTheme(plan.customTheme);
    return {
      appName: plan.name!,
      starterId: plan.starterId ?? null,
      packageManager: parsePackageManager(plan.packageManager!),
      optionFlags: planToOptionFlags(plan),
      themePack: plan.themePack!,
      locale: plan.locale!,
      locales,
      translateLocales:
        options.translateLocales === true || plan.translateLocales,
      ...(customTheme ? { customTheme } : {}),
      bundleId: plan.bundleId,
      followUpPrompt: plan.followUpPrompt,
      extraModules: plan.extraModules,
      promptGaps: plan.promptGaps,
      suggestedPlan: plan.suggestedPlan,
      openingPrompt: plan.openingPrompt,
      firebase: plan.firebase,
    };
  }

  // Classic path: flags, `-y`, or blank description → browse starters.
  const appName = await resolveAppName(nameArg, options);
  const starterId = await resolveStarter(source.registry.starters, options);
  const starter = starterId
    ? source.registry.starters.find((entry) => entry.id === starterId)
    : undefined;

  const packageManager = await resolveInitPackageManager(
    options,
    config.packageManager,
  );
  const optionFlags = [
    ...(options.option ?? []),
    ...(options.themePack
      ? [`pack=${options.themePack}`]
      : starter?.defaults?.themePack
        ? [`pack=${starter.defaults.themePack}`]
        : []),
  ];

  /*
   * `--locale en,fr` means "default en, plus fr" — not a locale called "en,fr".
   *
   * The whole flag value was being used as the default locale, so a
   * comma-separated list produced `defaultLocale: "en,fr"`, a `locales` array
   * containing the literal `"en,fr"`, and a `locales/en,fr.json` file next to
   * the real ones. The default is the first entry.
   */
  const localeFlag = options.locale?.trim();
  const requestedLocales = localeFlag?.includes(",")
    ? localeFlag
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : undefined;
  const locale =
    requestedLocales?.[0] ??
    localeFlag ??
    starter?.defaults?.defaultLocale ??
    "en";
  const locales = normalizeLocales(requestedLocales, locale);

  return {
    appName,
    starterId,
    packageManager,
    optionFlags,
    themePack: options.themePack ?? starter?.defaults?.themePack ?? "neutral",
    locale: locales[0] ?? locale,
    locales,
    translateLocales: options.translateLocales === true,
    bundleId: options.bundleId,
  };
}

function normalizeLocales(
  locales: string[] | undefined,
  defaultLocale: string,
): string[] {
  const list = [...(locales ?? [])].map((code) => code.trim()).filter(Boolean);
  if (defaultLocale.trim()) list.unshift(defaultLocale.trim());
  return [...new Set(list.map((code) => code.toLowerCase()))];
}

function coerceCustomTheme(value: unknown): ThemePackData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!isThemeColors(record.light) || !isThemeColors(record.dark))
    return undefined;
  return {
    id: typeof record.id === "string" ? record.id : "custom",
    label: typeof record.label === "string" ? record.label : "Custom",
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    light: record.light,
    dark: record.dark,
  };
}

async function resolveInitPackageManager(
  options: InitOptions,
  globalDefault: PackageManager | undefined,
): Promise<PackageManager> {
  const fromFlag = options.pm ?? options.packageManager;
  if (fromFlag) {
    const pm = parsePackageManager(fromFlag);
    const installed = await detectInstalled();
    if (!installed[pm]) {
      throw new RadianceError(
        `${pm} is not installed`,
        `Install ${pm}, or pick another with --pm (${PACKAGE_MANAGERS.join(", ")}).`,
      );
    }
    return pm;
  }

  if (options.yes) {
    return resolvePackageManager({ global: globalDefault });
  }

  return promptPackageManager(globalDefault);
}

async function promptPackageManager(
  globalDefault: PackageManager | undefined,
): Promise<PackageManager> {
  const installed = await detectInstalled();
  const available = PACKAGE_MANAGERS.filter((pm) => installed[pm]);

  if (available.length === 0) {
    throw new RadianceError(
      "No Node package manager found",
      `Install one of: ${PACKAGE_MANAGERS.join(", ")}.`,
    );
  }

  const initial =
    (globalDefault && installed[globalDefault] ? globalDefault : undefined) ??
    (await resolvePackageManager({ global: globalDefault, installed }));

  const choice = await prompts.select({
    message: "Package manager",
    options: available.map((pm) => ({
      value: pm,
      label: pm,
      hint: installed[pm],
    })),
    initialValue: initial,
  });

  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
  return choice as PackageManager;
}

async function maybeSetupFirebase(
  root: string,
  appName: string,
  options: InitOptions,
  suggestedPlan?: "free" | "paid",
): Promise<boolean> {
  if (options.yes || options.firebase === false) return false;

  try {
    const want = await prompts.confirm({
      message: "Set up Firebase now? (login, project, write `.env`)",
      initialValue: true,
    });
    if (prompts.isCancel(want) || !want) return false;

    if (suggestedPlan === "paid") {
      ui.warn(
        "Your description needs cloud Storage/Functions — pick the paid plan when asked (or pass --plan paid).",
      );
    }

    return await setupFirebase(root, {
      force: true,
      appName,
      plan: parsePlanFlag(options.plan),
      preferredPlan: suggestedPlan,
    });
  } catch (error) {
    if (error instanceof RadianceError && error.message === "Cancelled.")
      throw error;
    ui.warn(
      error instanceof Error
        ? `Firebase setup skipped: ${error.message}`
        : "Firebase setup skipped.",
    );
    if (error instanceof RadianceError && error.hint) ui.detail(error.hint);
    ui.detail("You can retry with `radiance setup firebase`.");
    return false;
  }
}

async function maybeRunFollowUp(
  root: string,
  followUpPrompt: string,
  yes: boolean,
): Promise<void> {
  await offerFollowUpPrompt(followUpPrompt, {
    yes,
    heading: "Remaining work from your description",
    confirmMessage: "Apply the remaining features now with `radiance prompt`?",
    run: async (next) => {
      const previous = process.cwd();
      try {
        process.chdir(root);
        const { promptCommand } = await import("./prompt.js");
        await promptCommand(next, { yes: true, skipFollowUp: true });
      } finally {
        process.chdir(previous);
      }
    },
  });
}

function printNextSteps(
  name: string,
  pm: PackageManager,
  needsInstall: boolean,
  linkedFirebase: boolean,
  followUpPrompt?: string,
  suggestedPlan?: "free" | "paid",
  extraModules?: string[],
): void {
  ui.heading("Next steps");
  ui.info(`  cd ${name}`);
  if (needsInstall) ui.info(`  ${formatInstallHint(pm)}`);
  if (!linkedFirebase) {
    const planHint =
      suggestedPlan === "paid"
        ? "   # prefer --plan paid (Storage / Functions)"
        : "";
    ui.info(`  radiance setup firebase${planHint}`);
  }
  if (extraModules?.length) {
    ui.info(pc.dim(`  (already added: ${extraModules.join(", ")})`));
  }
  ui.info(`  ${formatRunHint(pm, "start")}`);
  ui.blank();
  ui.info(pc.dim("  radiance add <module>     add a capability"));
  if (followUpPrompt) {
    ui.info(`  radiance prompt ${JSON.stringify(followUpPrompt)}`);
  } else {
    ui.info(pc.dim('  radiance prompt "..."     describe a change'));
  }
}

async function resolveAppName(
  nameArg: string | undefined,
  options: InitOptions,
): Promise<string> {
  const fromArg = nameArg?.trim();
  if (fromArg) return fromArg;

  if (options.yes) {
    throw new RadianceError(
      "Missing app name",
      "Pass a directory name: `radiance init my-app -y`, or omit `-y` to be prompted.",
    );
  }

  const answer = await prompts.text({
    message: "App name (directory to create)",
    placeholder: "my-app",
    validate: (value) => {
      const trimmed = value?.trim();
      if (!trimmed) return "Enter a name for the app directory";
      if (trimmed === "." || trimmed === "..")
        return "Pick a directory name, not `.` or `..`";
      return undefined;
    },
  });

  if (prompts.isCancel(answer)) throw new RadianceError("Cancelled.");
  return answer.trim();
}

async function resolveStarter(
  starters: { id: string; title: string; description: string }[],
  options: InitOptions,
): Promise<string | null> {
  if (options.scaffold) return null;
  if (options.template) {
    if (!starters.some((starter) => starter.id === options.template)) {
      throw new RadianceError(
        `Unknown starter "${options.template}"`,
        `Available: ${starters.map((starter) => starter.id).join(", ")}`,
      );
    }
    return options.template;
  }

  if (options.yes) return null;

  const choice = await prompts.select({
    message: "What are you building?",
    options: [
      ...starters.map((starter) => ({
        value: starter.id,
        label: starter.title,
        hint: starter.description,
      })),
      {
        value: "__scaffold__",
        label: "Bare scaffold",
        hint: "Tooling only, no domain screens",
      },
    ],
  });

  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
  return choice === "__scaffold__" ? null : (choice as string);
}

async function initGit(root: string): Promise<void> {
  try {
    await execa("git", ["init", "--quiet"], { cwd: root });
    await execa("git", ["add", "."], { cwd: root });
    await execa(
      "git",
      ["commit", "--quiet", "-m", "Initial commit from Radiance"],
      {
        cwd: root,
        // Committer as well as author. Git only falls back to the machine's
        // identity for the committer, and the provision worker's container has
        // none configured — there, `git commit` fails outright with "unable to
        // auto-detect email address" rather than picking something sensible.
        env: {
          GIT_AUTHOR_NAME: "Radiance",
          GIT_AUTHOR_EMAIL: "radiance@radianc.es",
          GIT_COMMITTER_NAME: "Radiance",
          GIT_COMMITTER_EMAIL: "radiance@radianc.es",
        },
      },
    );
    ui.success("Initialised a git repository");
  } catch {
    ui.warn("Could not initialise git — carry on without it.");
  }
}

async function installDependencies(
  root: string,
  pm: PackageManager,
): Promise<void> {
  const spinner = prompts.spinner();
  spinner.start(`Installing dependencies with ${pm}`);

  const { command, args } = installCommand(pm);

  try {
    await execa(command, args, { cwd: root, timeout: 600_000 });
    spinner.stop("Dependencies installed");
  } catch (error) {
    spinner.stop("Dependency install failed");
    const hint = formatInstallHint(pm);
    ui.warn(
      error instanceof Error
        ? `Run \`${hint}\` yourself: ${error.message.split("\n")[0]}`
        : `Run \`${hint}\` yourself.`,
    );
    return;
  }

  // Cloud Functions is a nested package — root install does not cover it.
  if (!existsSync(join(root, "functions", "package.json"))) return;

  spinner.start(`Installing functions dependencies with ${pm}`);
  try {
    const nested = installInDirCommand(pm, "functions");
    await execa(nested.command, nested.args, { cwd: root, timeout: 600_000 });
    spinner.stop("Functions dependencies installed");
  } catch (error) {
    spinner.stop("Functions dependency install failed");
    const hint = formatInstallInDirHint(pm, "functions");
    ui.warn(
      error instanceof Error
        ? `Run \`${hint}\` yourself: ${error.message.split("\n")[0]}`
        : `Run \`${hint}\` yourself.`,
    );
  }
}

/**
 * The resolved plan, for a caller without a terminal.
 *
 * Written before anything is staged, so a caller can tell "the description
 * resolved to this" apart from "the install then failed". `followUpPrompt` is
 * the part of the description the chosen starter does not already cover;
 * under `-y` it is otherwise only printed.
 */
async function writePlanJson(
  path: string,
  resolved: ResolvedInit,
): Promise<void> {
  const out = {
    starterId: resolved.starterId,
    themePack: resolved.themePack,
    locale: resolved.locale,
    locales: resolved.locales,
    translateLocales: resolved.translateLocales ?? false,
    extraModules: resolved.extraModules ?? [],
    followUpPrompt: resolved.followUpPrompt ?? null,
    promptGaps: resolved.promptGaps ?? [],
    suggestedPlan: resolved.suggestedPlan ?? null,
    openingPrompt: resolved.openingPrompt ?? null,
  };
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");
}
