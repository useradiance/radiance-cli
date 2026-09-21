#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

import { addCommand } from "./commands/add.js";
import { buildCommand } from "./commands/build.js";
import { compileCommand } from "./commands/compile.js";
import {
  configGetCommand,
  configSetCommand,
  configSetKeyCommand,
  configShowCommand,
  configUnsetKeyCommand,
} from "./commands/config.js";
import { deployCommand } from "./commands/deploy.js";
import { destroyCommand } from "./commands/destroy.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { previewCommand } from "./commands/preview.js";
import { explainCommand, promptCommand } from "./commands/prompt.js";
import { refreshCommand } from "./commands/refresh.js";
import { removeCommand } from "./commands/remove.js";
import { setupFirebaseCommand } from "./commands/setup-firebase.js";
import {
  templatesListCommand,
  templatesOutdatedCommand,
  templatesPruneCommand,
} from "./commands/templates.js";
import {
  MULTI_STEP_COMMANDS,
  RadianceError,
  endLogSession,
  setVerbose,
  startLogSession,
  ui,
} from "./core/logger.js";
import { findProjectRoot } from "./core/project.js";
import { printHint } from "./harness/diagnostics.js";

function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(here, "..", "package.json"), "utf8"),
  );
  return manifest.version as string;
}

function collectOption(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function commandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current && current.parent) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(" ");
}

const program = new Command();

program
  .name("radiance")
  .description(
    "Build Expo + Firebase apps from the Radiance catalogue, with an AI harness that reuses it.",
  )
  .version(version(), "-v, --version")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (multi-step commands always write a log file)",
  );

program.hook("preAction", (_thisCommand, actionCommand) => {
  let verbose = Boolean(program.opts().verbose);
  let current: Command | null = actionCommand;
  while (current) {
    if (Boolean(current.opts().verbose)) verbose = true;
    current = current.parent;
  }
  setVerbose(verbose);

  const name = commandPath(actionCommand);
  if (!MULTI_STEP_COMMANDS.has(name)) return;

  startLogSession({
    command: name,
    projectRoot: findProjectRoot(),
  });
});

program.hook("postAction", (_thisCommand, actionCommand) => {
  if (!MULTI_STEP_COMMANDS.has(commandPath(actionCommand))) return;
  endLogSession();
});

program
  .command("init")
  .argument("[name]", "directory to create the app in (prompted if omitted)")
  .description("create a new app from a starter")
  .option("-t, --template <id>", "starter to use (skips the prompt)")
  .option("--scaffold", "start from the bare scaffold with no domain screens")
  .option(
    "--theme-pack <id>",
    "theme pack: neutral, contrast, branded, ocean, ink, hearth, bloom, flare, paper, grove, violet, citrus, or custom",
  )
  .option(
    "--locale <code>",
    "default locale (comma-separated for multiple, e.g. en,fr,de)",
  )
  .option("--bundle-id <id>", "iOS/Android bundle identifier")
  .option("--template-version <version>", "pin a templates release")
  .option(
    "--option <key=value...>",
    "module option, e.g. providers=email,google or auth.providers=email",
    collectOption,
    [],
  )
  .option("--pm <name>", "package manager: npm, yarn, pnpm or bun")
  .option(
    "--prompt <text>",
    "describe the app; AI interviews until init settings are complete",
  )
  .option(
    "--provider <id>",
    "ollama, openai, anthropic or cursor (with --prompt)",
  )
  .option("--model <id>", "model to use for --prompt")
  .option("--no-install", "skip dependency install")
  .option("--no-git", "skip git init")
  .option("--no-firebase", "skip Firebase project setup")
  .option(
    "--plan <free|paid>",
    "when setting up Firebase: free (emulators for Storage/Functions) or paid",
  )
  .option(
    "-y, --yes",
    "accept defaults without prompting (also skips Firebase setup)",
  )
  .option("--demo", "install demo-data and set EXPO_PUBLIC_SEED_DEMO=true")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(initCommand);

program
  .command("add")
  .argument("[modules...]", "module ids to install")
  .description("install catalogue modules into this project")
  .option("-y, --yes", "apply without confirming the diff")
  .option("--dry-run", "show what would change and stop")
  .option("--force", "reapply modules that are already installed")
  .option(
    "--option <key=value...>",
    "module option, e.g. providers=email,google",
    collectOption,
    [],
  )
  .option("--pack <id>", "alias for --option pack=<id> (theme)")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(addCommand);

program
  .command("remove")
  .argument("<module>", "module id to uninstall")
  .description(
    "remove a catalogue module (files + wiring; deps/locales reported as orphans)",
  )
  .option("-y, --yes", "apply without confirming the diff")
  .option("--dry-run", "show what would change and stop")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(removeCommand);

program
  .command("prompt")
  .argument("<request>", "what you want to change, in plain language")
  .description(
    "plan and apply a change, reusing catalogue modules before generating code",
  )
  .option("-y, --yes", "apply without confirming the diff")
  .option("--dry-run", "show what would change and stop")
  .option("--plan-only", "print the plan and stop")
  .option(
    "--effort <level>",
    "high: plan, then write (thorough). fast: one pass (roughly twice as quick)",
    "high",
  )
  .option("--no-verify", "skip the typecheck and repair loop")
  .option("--follow-up", "with -y, auto-run the residual follow-up prompt once")
  .option("--provider <id>", "ollama, openai, anthropic or cursor")
  .option("--model <id>", "model to use for this run")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(promptCommand);

program
  .command("update")
  .description("refresh the template cache within the current major version")
  .option("--project", "also sync the modules installed in this project")
  .option("-y, --yes", "apply without confirming the diff")
  .option("--dry-run", "show what would change and stop")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action((options) => refreshCommand("update", options));

program
  .command("upgrade")
  .description("move to the newest templates release, including major versions")
  .option("--project", "also sync the modules installed in this project")
  .option("-y, --yes", "apply without confirming the diff")
  .option("--dry-run", "show what would change and stop")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action((options) => refreshCommand("upgrade", options));

const templates = program
  .command("templates")
  .description("inspect the template catalogue and its local cache");

templates
  .command("list", { isDefault: true })
  .description("list starters and modules")
  .action(templatesListCommand);
templates
  .command("outdated")
  .description("compare the cache with the published releases")
  .action(templatesOutdatedCommand);
templates
  .command("prune")
  .description("delete cached releases nothing is using")
  .action(templatesPruneCommand);

const config = program
  .command("config")
  .description("read and write Radiance settings");

config
  .command("list", { isDefault: true })
  .description("show every setting")
  .action(configShowCommand);
config
  .command("get")
  .argument("<key>")
  .description("print one setting")
  .action(configGetCommand);
config
  .command("set")
  .argument("<key>", "setting name (e.g. packageManager, or alias pm)")
  .argument("<value>", "new value (e.g. yarn)")
  .description("change one setting")
  .action(configSetCommand);
config
  .command("set-key")
  .argument("<provider>", "anthropic, openai or cursor")
  .argument("[value]", "API key (prompted if omitted)")
  .description("store a provider API key in the OS keychain")
  .action(configSetKeyCommand);
config
  .command("unset-key")
  .argument("<provider>", "anthropic, openai or cursor")
  .description("remove a provider API key from the OS keychain")
  .action(configUnsetKeyCommand);

program
  .command("build")
  .description("build local web and/or native artifacts (EAS for Android/iOS)")
  .option("--web", "export the web build only")
  .option("--android", "build an Android binary")
  .option("--ios", "build an iOS binary")
  .option("--profile <name>", "EAS build profile (default: preview)")
  .option(
    "--local",
    "compile native builds on this machine (eas build --local)",
  )
  .option(
    "--out <dir>",
    "directory for native artifacts (default: .radiance/artifacts/<stamp>)",
  )
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(buildCommand);

program
  .command("preview")
  .description("start Expo web, or export a static web build with --export")
  .option(
    "--export",
    "write a web export to dist/ instead of starting the dev server",
  )
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(previewCommand);

program
  .command("deploy")
  .description(
    "deploy Firebase hosting/rules/auth/functions; optionally distribute mobile builds",
  )
  .option("--web", "export and deploy the web build only")
  .option("--rules", "deploy security rules and indexes only")
  .option("--auth", "deploy Authentication provider config only")
  .option("--functions", "build and deploy Cloud Functions only")
  .option("--android", "include an Android mobile binary")
  .option("--ios", "include an iOS mobile binary")
  .option(
    "--app-distribution",
    "upload mobile binaries to Firebase App Distribution (requires --android/--ios)",
  )
  .option(
    "--eas",
    "build mobile binaries with EAS cloud (requires --android/--ios)",
  )
  .option(
    "--local",
    "store mobile binaries under .radiance/artifacts (requires --android/--ios)",
  )
  .option("--submit", "after --eas, submit the latest build to the stores")
  .option("--profile <name>", "EAS build/submit profile")
  .option(
    "--groups <aliases>",
    "App Distribution tester group aliases (comma-separated)",
  )
  .option(
    "--testers <emails>",
    "App Distribution tester emails (comma-separated)",
  )
  .option("--release-notes <text>", "App Distribution release notes")
  .option("--from <dir>", "reuse binaries from a prior radiance build output")
  .option("--project <id>", "Firebase project to deploy to")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(deployCommand);

program
  .command("destroy")
  .argument(
    "[path]",
    "project directory to destroy (defaults to current directory)",
  )
  .description(
    "tear down Firebase resources and/or this local Radiance project",
  )
  .option("--firebase-project", "delete the entire Firebase/GCP project")
  .option("--hosting", "delete Firebase Hosting site(s)")
  .option("--functions", "delete deployed Cloud Functions")
  .option("--firestore", "delete the default Firestore database")
  .option("--unlink", "reset local Firebase link (.env, .firebaserc, eas.json)")
  .option("--local", "delete this project directory")
  .option("-y, --yes", "non-interactive; requires explicit target flags")
  .option("--force", "skip typed confirmations (use with explicit targets)")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(destroyCommand);

const setup = program
  .command("setup")
  .description("guided post-init configuration");
setup
  .command("firebase")
  .description("login, link a Firebase project, and write `.env`")
  .option("--plan <free|paid>", "free or paid — skips the plan prompt")
  .option("--project <id>", "Firebase project id (headless / hosted)")
  .option(
    "--create-project",
    "create --project if missing (requires --project and -y)",
  )
  .option("-y, --yes", "non-interactive; requires --plan and --project")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(setupFirebaseCommand);

program
  .command("compile")
  .description(
    "typecheck and compile web / iOS / Android (current app, or --starter / --module)",
  )
  .option("--starter <id>", "generate this starter, then compile it")
  .option(
    "--module <id>",
    "generate the scaffold (or --starter), add this module, then compile",
  )
  .option(
    "--platforms <list>",
    "comma-separated: web,ios,android (default: web, plus ios on macOS, plus android when ANDROID_HOME is set)",
  )
  .option("--out <dir>", "catalogue mode: write the generated app here")
  .option("--force", "replace --out/<starter-or-module> if it already exists")
  .option("--pm <name>", "package manager: npm, yarn, pnpm or bun")
  .option(
    "--verbose",
    "echo step-by-step progress to the terminal (a log file is always written)",
  )
  .action(compileCommand);
program
  .command("doctor")
  .description("check your toolchain, cache and project")
  .action(doctorCommand);
program
  .command("explain")
  .description("print this project's RADIANCE.md constitution")
  .action(explainCommand);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    ui.blank();

    if (error instanceof RadianceError) {
      ui.error(error.message);
      printHint(error.hint);
    } else if (error instanceof Error) {
      ui.error(error.message);
      if (process.env.RADIANCE_DEBUG) console.error(pc.dim(error.stack ?? ""));
      else ui.detail("Run again with RADIANCE_DEBUG=1 for a stack trace.");
    } else {
      ui.error(String(error));
    }

    endLogSession();
    process.exitCode = 1;
  }
}

await main();
