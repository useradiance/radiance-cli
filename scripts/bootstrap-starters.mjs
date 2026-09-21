#!/usr/bin/env node
/**
 * Drive the real `radiance init` CLI for the bare scaffold and every catalogue
 * starter, link a Firebase project, then typecheck. Apps stay on disk so you
 * can run them.
 *
 *   yarn build && yarn bootstrap:starters
 *   yarn bootstrap:starters -- --starter social-app
 *   yarn bootstrap:starters -- social-app
 *   yarn bootstrap:starters -- --project my-radiance-e2e
 *   yarn bootstrap:starters -- --only social-app,e-commerce --no-firebase
 */
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pc from "picocolors";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = join(CLI_ROOT, "dist", "index.js");
const PACKAGE_MANAGERS = ["yarn", "npm", "pnpm", "bun"];
const PLANS = ["free", "paid"];
const INIT_TIMEOUT_MS = 15 * 60_000;
const FIREBASE_TIMEOUT_MS = 15 * 60_000;
const TYPECHECK_TIMEOUT_MS = 5 * 60_000;
const SCAFFOLD_ID = "scaffold";
/** Same rule as radiance-cli `isValidProjectId`. */
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,29}$/;

const HELP = `Bootstrap every Radiance starter (and the bare scaffold) via the real CLI.

Usage:
  yarn bootstrap:starters -- [options]
  yarn bootstrap:starters -- --starter social-app
  yarn bootstrap:starters -- social-app

By default each app gets its own Firebase project named \`<starter>-<timestamp>\`
(created automatically). Pass --project to share one existing project instead.
Free plan: Auth/Firestore in the cloud, Storage & Functions on emulators.
Requires \`firebase login\`.

Options:
  --starter <id>       Bootstrap only this starter (or "${SCAFFOLD_ID}")
  --only <ids>         Comma-separated ids (include "${SCAFFOLD_ID}" for the bare app)
  --project <id>       Shared Firebase project id (or RADIANCE_FIREBASE_PROJECT)
  --plan <free|paid>   Firebase plan (default: free)
  --create-project     Create a shared --project if it does not exist (first target only)
  --no-firebase        Skip Firebase setup
  --out <dir>          Output directory (default: ~/tmp/radiance-starters)
  --pm <name>          yarn | npm | pnpm | bun (default: yarn)
  --clean              Delete --out before starting
  --force              Re-init targets that already exist
  --no-install         Pass --no-install to init; skip typecheck
  --no-typecheck       Init + install only
  --demo               Pass --demo to init
  --verbose            Pass --verbose to init
  --help               Show this help

Requires a built CLI (\`yarn build\`) and a local catalogue
(RADIANCE_TEMPLATES_PATH, or the sibling ../radiance-templates checkout).
`;

function fail(message) {
  console.error(pc.red(message));
  process.exit(1);
}

function parseCli(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        out: { type: "string" },
        starter: { type: "string" },
        only: { type: "string" },
        pm: { type: "string", default: "yarn" },
        project: { type: "string" },
        plan: { type: "string", default: "free" },
        "create-project": { type: "boolean", default: false },
        "no-firebase": { type: "boolean", default: false },
        clean: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "no-install": { type: "boolean", default: false },
        "no-typecheck": { type: "boolean", default: false },
        demo: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return { values, positionals };
}

/** @returns {string[] | null} selected ids, or null to run every target */
function resolveWantedIds(options, positionals) {
  const fromPos = positionals.map((id) => id.trim()).filter(Boolean);
  if (fromPos.length > 1) {
    fail(
      "Pass one starter as a positional argument, or use --only a,b for several.",
    );
  }

  const starter = options.starter?.trim();
  if (starter && fromPos.length > 0 && starter !== fromPos[0]) {
    fail(
      `Conflicting starter ids: --starter ${starter} vs positional ${fromPos[0]}`,
    );
  }

  const single = starter || fromPos[0];
  const onlyRaw = options.only?.trim();
  if (single && onlyRaw) {
    fail("Use --starter (or a positional id) or --only, not both.");
  }

  if (single) return [single];
  if (!onlyRaw) return null;

  const wanted = onlyRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (wanted.length === 0) {
    fail("--only was empty. Pass comma-separated ids, e.g. --only social-app,scaffold");
  }
  return wanted;
}

function resolveTemplatesRoot() {
  const fromEnv = process.env.RADIANCE_TEMPLATES_PATH?.trim();
  if (fromEnv) {
    const root = resolve(fromEnv);
    if (!existsSync(join(root, "registry.json"))) {
      fail(
        `RADIANCE_TEMPLATES_PATH=${root} has no registry.json.\nPoint it at a radiance-templates checkout.`,
      );
    }
    return root;
  }

  const sibling = resolve(CLI_ROOT, "..", "radiance-templates");
  if (existsSync(join(sibling, "registry.json"))) return sibling;

  fail(
    "Could not find a templates catalogue.\nSet RADIANCE_TEMPLATES_PATH or keep radiance-templates next to radiance-cli.",
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function typecheckCommand(pm) {
  switch (pm) {
    case "npm":
      return { command: "npm", args: ["run", "typecheck"] };
    case "yarn":
      return { command: "yarn", args: ["typecheck"] };
    case "pnpm":
      return { command: "pnpm", args: ["typecheck"] };
    case "bun":
      return { command: "bun", args: ["run", "typecheck"] };
    default:
      fail(`Unknown package manager "${pm}"`);
  }
}

function spawnLogged(command, args, options) {
  const { cwd, env, logPath, timeoutMs } = options;
  mkdirSync(dirname(logPath), { recursive: true });

  return new Promise((resolveSpawn) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(logPath);
    let output = "";

    const onData = (buf) => {
      const text = buf.toString();
      output += text;
      log.write(buf);
      process.stdout.write(buf);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      log.end();
      resolveSpawn({
        ok: false,
        code: 1,
        timedOut: false,
        output: error.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      log.end();
      resolveSpawn({
        ok: !timedOut && code === 0,
        code: code ?? 1,
        signal,
        timedOut,
        output,
      });
    });
  });
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function statusColor(value) {
  if (value === "ok") return pc.green(value);
  if (value === "fail") return pc.red(value);
  return pc.dim(value);
}

function printTable(results) {
  const idW = Math.max(8, ...results.map((row) => row.id.length));
  const header = `${pad("id", idW)}  ${pad("init", 7)}  ${pad("install", 7)}  ${pad("firebase", 8)}  ${pad("typecheck", 9)}  path`;
  console.log("");
  console.log(pc.bold(header));
  console.log("-".repeat(Math.min(header.length, 120)));
  for (const row of results) {
    console.log(
      `${pad(row.id, idW)}  ${statusColor(pad(row.init, 7))}  ${statusColor(pad(row.install, 7))}  ${statusColor(pad(row.firebase, 8))}  ${statusColor(pad(row.typecheck, 9))}  ${row.path}`,
    );
  }
}

function envProjectId(appRoot) {
  const envPath = join(appRoot, ".env");
  if (!existsSync(envPath)) return null;
  const match = /^EXPO_PUBLIC_FIREBASE_PROJECT_ID=(.*)$/m.exec(
    readFileSync(envPath, "utf8"),
  );
  const value = match?.[1]?.trim();
  return value || null;
}

function isValidProjectId(projectId) {
  return PROJECT_ID_RE.test(projectId) && !projectId.endsWith("-");
}

/** Compact local stamp so \`starter-YYYYMMDDHHmmss\` stays within Firebase's 30-char id limit. */
function projectStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function generatedProjectId(starterId, stamp) {
  const slug =
    starterId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app";
  const maxSlug = 30 - 1 - stamp.length;
  let head = slug.slice(0, Math.max(1, maxSlug)).replace(/-+$/g, "");
  if (!/^[a-z]/.test(head)) head = `r${head}`.slice(0, Math.max(1, maxSlug));
  const id = `${head}-${stamp}`;
  if (!isValidProjectId(id)) {
    fail(`Could not build a valid Firebase project id from "${starterId}" + timestamp`);
  }
  return id;
}

function assertProject(appRoot, expectedTemplate, requiredModules) {
  const configPath = join(appRoot, "radiance.json");
  if (!existsSync(configPath)) {
    return [`missing ${configPath}`];
  }

  const project = readJson(configPath);
  const errors = [];
  const actual = project.template ?? null;
  if (actual !== expectedTemplate) {
    errors.push(
      `radiance.json template is ${JSON.stringify(actual)}, expected ${JSON.stringify(expectedTemplate)}`,
    );
  }

  const installed = new Set(
    (project.features ?? []).map((feature) =>
      typeof feature === "string" ? feature : feature.id,
    ),
  );
  for (const moduleId of requiredModules) {
    if (!installed.has(moduleId)) {
      errors.push(`missing feature ${moduleId}`);
    }
  }
  return errors;
}

function lastLines(text, count = 40) {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-count).join("\n");
}

async function main() {
  const { values: options, positionals } = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (!existsSync(CLI_BIN)) {
    fail(`Missing ${CLI_BIN}\nBuild the CLI first: yarn build`);
  }

  const pm = options.pm;
  if (!PACKAGE_MANAGERS.includes(pm)) {
    fail(`Unknown --pm "${pm}". Choose one of: ${PACKAGE_MANAGERS.join(", ")}`);
  }

  const skipFirebase = options["no-firebase"] === true;
  const sharedProject =
    options.project?.trim() || process.env.RADIANCE_FIREBASE_PROJECT?.trim() || "";
  const firebasePlan = options.plan;
  if (!PLANS.includes(firebasePlan)) {
    fail(`Unknown --plan "${firebasePlan}". Choose one of: ${PLANS.join(", ")}`);
  }
  if (sharedProject && !isValidProjectId(sharedProject)) {
    fail(
      `Invalid Firebase project id "${sharedProject}".\nUse 6–30 chars: lowercase letter, then letters/digits/hyphens; no trailing hyphen.`,
    );
  }
  const runStamp = projectStamp();

  const templatesRoot = resolveTemplatesRoot();
  const registry = readJson(join(templatesRoot, "registry.json"));
  const starters = registry.starters ?? [];
  if (starters.length === 0) {
    fail(`No starters listed in ${join(templatesRoot, "registry.json")}`);
  }

  const allTargets = [
    {
      id: SCAFFOLD_ID,
      template: null,
      modules: registry.scaffold?.requiredModules ?? [],
      scaffold: true,
    },
    ...starters.map((starter) => ({
      id: starter.id,
      template: starter.id,
      modules: starter.modules ?? [],
      scaffold: false,
    })),
  ];

  let targets = allTargets;
  const wanted = resolveWantedIds(options, positionals);
  if (wanted) {
    const known = new Set(allTargets.map((target) => target.id));
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      fail(
        `Unknown starter id(s): ${unknown.join(", ")}\nAvailable: ${[...known].join(", ")}`,
      );
    }
    const order = new Map(wanted.map((id, index) => [id, index]));
    targets = allTargets
      .filter((target) => order.has(target.id))
      .sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  const outDir = resolve(
    options.out && options.out.trim()
      ? isAbsolute(options.out)
        ? options.out
        : resolve(process.cwd(), options.out)
      : join(homedir(), "tmp", "radiance-starters"),
  );
  const logsDir = join(outDir, "logs");

  if (options.clean && existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(logsDir, { recursive: true });

  const skipInstall = options["no-install"] === true;
  const skipTypecheck = skipInstall || options["no-typecheck"] === true;

  console.log(pc.bold("Radiance starter bootstrap"));
  console.log(pc.dim(`cli        ${CLI_BIN}`));
  console.log(pc.dim(`templates  ${templatesRoot}`));
  console.log(pc.dim(`out        ${outDir}`));
  console.log(pc.dim(`pm         ${pm}`));
  console.log(
    pc.dim(
      skipFirebase
        ? "firebase   skipped (--no-firebase)"
        : sharedProject
          ? `firebase   ${sharedProject} (${firebasePlan}${options["create-project"] ? ", create" : ""})`
          : `firebase   <starter>-${runStamp} (${firebasePlan}, create each)`,
    ),
  );
  console.log(
    pc.dim(
      `targets    ${targets.map((target) => target.id).join(", ")} (${targets.length})`,
    ),
  );
  console.log("");

  const childEnv = {
    ...process.env,
    RADIANCE_TEMPLATES_PATH: templatesRoot,
  };

  const startedAt = new Date().toISOString();
  const results = [];
  let createProjectPending = options["create-project"] === true;

  for (const [index, target] of targets.entries()) {
    const appRoot = join(outDir, target.id);
    const heading = `[${index + 1}/${targets.length}] ${target.id}`;
    console.log(pc.bold(heading));

    const row = {
      id: target.id,
      path: appRoot,
      init: "skipped",
      install: "skipped",
      firebase: "skipped",
      firebaseProject: null,
      typecheck: "skipped",
      errors: [],
    };

    const alreadyInited =
      existsSync(join(appRoot, "radiance.json")) && !options.force;

    if (options.force && existsSync(appRoot)) {
      rmSync(appRoot, { recursive: true, force: true });
    }

    if (alreadyInited) {
      console.log(pc.dim("  skip init (exists; pass --force to re-init)"));
      const assertErrors = assertProject(appRoot, target.template, target.modules);
      if (assertErrors.length > 0) {
        row.init = "fail";
        row.errors.push(...assertErrors);
      } else {
        row.init = "skipped";
      }
    } else {
      const initArgs = ["init", appRoot, "-y", "--no-firebase", "--no-git", "--pm", pm];
      if (target.scaffold) initArgs.push("--scaffold");
      else initArgs.push("-t", target.id);
      if (skipInstall) initArgs.push("--no-install");
      if (options.demo) initArgs.push("--demo");
      if (options.verbose) initArgs.push("--verbose");

      const initLog = join(logsDir, `${target.id}-init.log`);
      const init = await spawnLogged(process.execPath, [CLI_BIN, ...initArgs], {
        cwd: CLI_ROOT,
        env: childEnv,
        logPath: initLog,
        timeoutMs: INIT_TIMEOUT_MS,
      });

      if (!init.ok) {
        row.init = "fail";
        row.errors.push(
          init.timedOut
            ? `init timed out after ${INIT_TIMEOUT_MS / 1000}s`
            : `init exited ${init.code}${init.signal ? ` (${init.signal})` : ""}`,
        );
        if (init.output) row.errors.push(lastLines(init.output));
      } else {
        const assertErrors = assertProject(
          appRoot,
          target.template,
          target.modules,
        );
        if (assertErrors.length > 0) {
          row.init = "fail";
          row.errors.push(...assertErrors);
        } else {
          row.init = "ok";
        }
      }
    }

    if (row.init !== "fail" && !skipInstall) {
      row.install = existsSync(join(appRoot, "node_modules")) ? "ok" : "fail";
      if (row.install === "fail") {
        row.errors.push("node_modules missing after init (install likely failed)");
      }
    }

    if (row.init !== "fail" && !skipFirebase) {
      const linked = envProjectId(appRoot);
      if (linked) {
        console.log(pc.dim(`  skip firebase (already linked to ${linked})`));
        row.firebase = "skipped";
        row.firebaseProject = linked;
      } else {
        const firebaseProject = sharedProject
          ? sharedProject
          : generatedProjectId(target.id, runStamp);
        const shouldCreate = sharedProject
          ? createProjectPending
          : true;
        row.firebaseProject = firebaseProject;
        console.log(
          pc.dim(
            `  firebase  ${firebaseProject}${shouldCreate ? " (create)" : ""}`,
          ),
        );

        const firebaseArgs = [
          "setup",
          "firebase",
          "-y",
          "--plan",
          firebasePlan,
          "--project",
          firebaseProject,
        ];
        if (shouldCreate) firebaseArgs.push("--create-project");
        if (options.verbose) firebaseArgs.push("--verbose");

        const firebaseLog = join(logsDir, `${target.id}-firebase.log`);
        const setup = await spawnLogged(process.execPath, [CLI_BIN, ...firebaseArgs], {
          cwd: appRoot,
          env: childEnv,
          logPath: firebaseLog,
          timeoutMs: FIREBASE_TIMEOUT_MS,
        });
        if (sharedProject) createProjectPending = false;

        if (!setup.ok) {
          row.firebase = "fail";
          row.errors.push(
            setup.timedOut
              ? `firebase setup timed out after ${FIREBASE_TIMEOUT_MS / 1000}s`
              : `firebase setup exited ${setup.code}${setup.signal ? ` (${setup.signal})` : ""}`,
          );
          if (setup.output) row.errors.push(lastLines(setup.output));
        } else if (envProjectId(appRoot) !== firebaseProject) {
          row.firebase = "fail";
          row.errors.push(
            `.env project id is ${JSON.stringify(envProjectId(appRoot))}, expected ${JSON.stringify(firebaseProject)}`,
          );
        } else {
          row.firebase = "ok";
        }
      }
    }

    const canTypecheck =
      row.init !== "fail" && row.install !== "fail" && !skipTypecheck;

    if (canTypecheck) {
      const { command, args } = typecheckCommand(pm);
      const typecheckLog = join(logsDir, `${target.id}-typecheck.log`);
      const check = await spawnLogged(command, args, {
        cwd: appRoot,
        env: childEnv,
        logPath: typecheckLog,
        timeoutMs: TYPECHECK_TIMEOUT_MS,
      });
      if (!check.ok) {
        row.typecheck = "fail";
        row.errors.push(
          check.timedOut
            ? `typecheck timed out after ${TYPECHECK_TIMEOUT_MS / 1000}s`
            : `typecheck exited ${check.code}`,
        );
        if (check.output) row.errors.push(lastLines(check.output));
      } else {
        row.typecheck = "ok";
      }
    }

    const failed = [row.init, row.install, row.firebase, row.typecheck].includes(
      "fail",
    );
    console.log(failed ? pc.red(`  ${target.id} failed`) : pc.green(`  ${target.id} ok`));
    if (row.errors.length > 0) {
      for (const error of row.errors) {
        console.log(pc.dim(`  ${error.split("\n")[0]}`));
      }
    }
    console.log("");
    results.push(row);
  }

  const finishedAt = new Date().toISOString();
  const ok = results.every(
    (row) =>
      row.init !== "fail" &&
      row.install !== "fail" &&
      row.firebase !== "fail" &&
      row.typecheck !== "fail",
  );

  const summary = {
    out: outDir,
    templatesPath: templatesRoot,
    pm,
    firebaseProject: skipFirebase ? null : sharedProject || `<starter>-${runStamp}`,
    firebasePlan: skipFirebase ? null : firebasePlan,
    startedAt,
    finishedAt,
    ok,
    results,
  };
  const summaryPath = join(outDir, "summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  printTable(results);
  console.log("");
  console.log(pc.dim(`summary  ${summaryPath}`));
  console.log(
    pc.dim(
      `next     cd ${join(outDir, results[0]?.id ?? SCAFFOLD_ID)} && ${pm === "npm" ? "npm start" : `${pm} start`}`,
    ),
  );

  if (!ok) {
    const failed = results.filter((row) =>
      [row.init, row.install, row.firebase, row.typecheck].includes("fail"),
    );
    fail(
      `${failed.length} of ${results.length} target(s) failed: ${failed.map((row) => row.id).join(", ")}`,
    );
  }

  console.log(pc.green(`All ${results.length} target(s) passed.`));
}

await main();
