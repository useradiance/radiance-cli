import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import pc from "picocolors";

import { addCommand } from "./add.js";
import { initCommand } from "./init.js";
import { ensureTemplateSource } from "../core/cache.js";
import {
  compileApp,
  parsePlatforms,
  resolveCompilePlatforms,
} from "../core/compile-app.js";
import { loadConfig } from "../core/config.js";
import { bindLogSession, RadianceError, ui } from "../core/logger.js";
import {
  resolvePackageManager,
  type PackageManager,
} from "../core/package-manager.js";
import { isFeatureInstalled, requireProject } from "../core/project.js";

export type CompileOptions = {
  starter?: string;
  module?: string;
  platforms?: string;
  out?: string;
  force?: boolean;
  pm?: string;
};

export async function compileCommand(options: CompileOptions): Promise<void> {
  const requested = parsePlatforms(options.platforms);
  const platforms = resolveCompilePlatforms(requested);
  const config = await loadConfig();
  const packageManager = await resolvePackageManager({
    preferred: options.pm,
    global: config.packageManager,
  });

  const catalogueMode = Boolean(options.starter || options.module);
  const root = catalogueMode
    ? await generateCompileTarget(options, packageManager)
    : (await requireProject()).root;

  bindLogSession(root);
  ui.heading(`Compiling ${pc.bold(root)}`);
  ui.detail(`platforms ${platforms.join(", ")}`);

  await compileApp(root, { platforms, packageManager });
  ui.success("Compile finished.");
}

async function generateCompileTarget(
  options: CompileOptions,
  packageManager: PackageManager,
): Promise<string> {
  const config = await loadConfig();
  const source = await ensureTemplateSource(config);

  if (options.starter) {
    const starter = source.registry.starters.find(
      (entry) => entry.id === options.starter,
    );
    if (!starter) {
      throw new RadianceError(
        `Unknown starter "${options.starter}"`,
        `See \`radiance templates list\` for ids.`,
      );
    }
  }
  if (options.module) {
    const module = source.registry.modules.find(
      (entry) => entry.id === options.module,
    );
    if (!module) {
      throw new RadianceError(
        `Unknown module "${options.module}"`,
        `See \`radiance templates list\` for ids.`,
      );
    }
  }

  const label = options.starter ?? options.module ?? "app";
  const root = await resolveCompileRoot(label, options);
  ui.step(`Generating ${label} → ${root}`);

  await initCommand(root, {
    template: options.starter,
    scaffold: !options.starter,
    yes: true,
    git: false,
    firebase: false,
    pm: packageManager,
  });

  if (options.module) {
    const { config: project } = await requireProject(root);
    if (!isFeatureInstalled(project, options.module)) {
      const previous = process.cwd();
      process.chdir(root);
      try {
        await addCommand([options.module], { yes: true });
      } finally {
        process.chdir(previous);
      }
    } else {
      ui.detail(`module ${options.module} already in starter`);
    }
  }

  return root;
}

async function resolveCompileRoot(
  label: string,
  options: CompileOptions,
): Promise<string> {
  if (!options.out) {
    return mkdtemp(join(tmpdir(), `radiance-compile-${label}-`));
  }

  const parent = isAbsolute(options.out)
    ? options.out
    : resolve(process.cwd(), options.out);
  mkdirSync(parent, { recursive: true });
  const root = join(parent, label);
  if (existsSync(root)) {
    if (!options.force) {
      throw new RadianceError(
        `${root} already exists`,
        "Pass --force to replace it, or choose a different --out.",
      );
    }
    rmSync(root, { recursive: true, force: true });
  }
  return root;
}
