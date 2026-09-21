import fg from "fast-glob";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import pc from "picocolors";

import {
  removeExactBlock,
  stripModuleTag,
  unregisterProvider,
} from "../core/apply/markers.js";
import { applyChanges, reportNotes } from "../core/apply/writer.js";
import { Workspace } from "../core/apply/workspace.js";
import { ensureTemplateSource } from "../core/cache.js";
import { loadConfig } from "../core/config.js";
import { RadianceError, bindLogSession, ui } from "../core/logger.js";
import {
  isFeatureInstalled,
  requireProject,
  writeProjectConfig,
} from "../core/project.js";
import {
  moduleDir,
  readModuleManifest,
  type ModuleManifest,
  type TemplateSource,
} from "../core/registry.js";

export type RemoveOptions = {
  yes?: boolean;
  dryRun?: boolean;
};

/**
 * Conservative uninstall: drop the module from radiance.json, delete catalogue
 * files it copied, strip tagged marker/provider blocks. npm deps and locale
 * keys are reported as orphans — not auto-reverted.
 */
export async function removeCommand(
  moduleId: string | undefined,
  options: RemoveOptions,
): Promise<void> {
  const id = moduleId?.trim();
  if (!id) {
    throw new RadianceError(
      "Module id required",
      "Usage: radiance remove <module>",
    );
  }

  const { root, config: project } = await requireProject();
  bindLogSession(root);

  if (!isFeatureInstalled(project, id)) {
    throw new RadianceError(
      `${id} is not installed`,
      "See `radiance templates list` for what this project has.",
    );
  }

  const config = await loadConfig();
  const source = await ensureTemplateSource(config);
  const manifest = await readModuleManifest(source, id);
  const workspace = new Workspace(root);
  const orphans: string[] = [];

  await deleteCatalogueFiles(workspace, source, manifest, orphans);
  await unwindWiring(workspace, manifest, orphans);

  const nextProject = {
    ...project,
    features: project.features.filter((feature) => feature.id !== id),
  };
  await workspace.write(
    "radiance.json",
    `${JSON.stringify(nextProject, null, 2)}\n`,
    id,
  );

  ui.heading(`Removing ${pc.bold(id)}`);
  const result = await applyChanges(root, workspace.changes(), {
    confirm: !options.yes,
    dryRun: options.dryRun ?? false,
  });
  reportNotes(workspace.getNotes());

  if (result.cancelled || options.dryRun) return;

  await writeProjectConfig(root, nextProject);
  ui.success(`Removed ${id}`);
  if (orphans.length > 0) {
    ui.heading("Left in place (review by hand)");
    for (const line of orphans) ui.detail(line);
  }
}

async function listModuleFiles(
  fromDir: string,
  targetPrefix?: string,
): Promise<string[]> {
  if (!existsSync(fromDir)) return [];
  const entries = await fg("**/*", {
    cwd: fromDir,
    dot: true,
    onlyFiles: true,
  });
  return entries.map((entry) =>
    targetPrefix ? posix.join(targetPrefix, entry) : entry,
  );
}

async function deleteCatalogueFiles(
  workspace: Workspace,
  source: TemplateSource,
  manifest: ModuleManifest,
  orphans: string[],
): Promise<void> {
  const dir = moduleDir(source, manifest.id);
  const paths = [
    ...(await listModuleFiles(join(dir, "files"))),
    ...(await listModuleFiles(join(dir, "functions"), "functions")),
  ];

  for (const path of paths) {
    if (path === "package.json" || path.startsWith("locales/")) {
      orphans.push(`kept merged file ${path}`);
      continue;
    }
    if ((await workspace.read(path)) === null) continue;
    await workspace.remove(path, manifest.id);
  }
}

async function unwindWiring(
  workspace: Workspace,
  manifest: ModuleManifest,
  orphans: string[],
): Promise<void> {
  const providersPath = "lib/registry/providers.tsx";
  const providersFile = await workspace.read(providersPath);
  if (providersFile) {
    let next = providersFile;
    for (const provider of manifest.wire.providers) {
      next = unregisterProvider(next, provider, manifest.id);
    }
    if (next !== providersFile) {
      await workspace.write(providersPath, next, manifest.id);
    }
  }

  const taggedFiles = [
    "firestore.rules",
    "storage.rules",
    "functions/src/index.ts",
    "lib/callable-contracts.ts",
    ...manifest.wire.markers.map((marker) => marker.file),
  ];

  for (const path of [...new Set(taggedFiles)]) {
    const current = await workspace.read(path);
    if (!current) continue;
    let next = stripModuleTag(current, manifest.id);
    for (const marker of manifest.wire.markers) {
      if (marker.file !== path) continue;
      next = removeExactBlock(next, marker.block);
      for (const importLine of marker.imports ?? []) {
        next = next
          .split("\n")
          .filter((line) => line.trim() !== importLine.trim())
          .join("\n");
      }
    }
    if (next !== current) {
      await workspace.write(path, next, manifest.id);
    }
  }

  const depNames = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });
  if (depNames.length > 0) {
    orphans.push(
      `package.json still lists: ${depNames.join(", ")} (not uninstalled)`,
    );
  }
  if (Object.keys(manifest.env).length > 0) {
    orphans.push(
      `.env keys from ${manifest.id}: ${Object.keys(manifest.env).join(", ")}`,
    );
  }
  if (Object.keys(manifest.secrets).length > 0) {
    orphans.push(
      `functions secrets from ${manifest.id}: ${Object.keys(manifest.secrets).join(", ")} (functions/.secret.local + Secret Manager)`,
    );
  }
  if (Object.keys(manifest.params).length > 0) {
    orphans.push(
      `functions params from ${manifest.id}: ${Object.keys(manifest.params).join(", ")} (functions/.env)`,
    );
  }
  orphans.push(`locale keys from ${manifest.id} were kept`);
}
