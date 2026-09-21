import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execa } from "execa";

import { applyChanges } from "../src/core/apply/writer.js";
import { deriveVars, stageInstall } from "../src/core/install.js";
import {
  isFeatureInstalled,
  writeProjectConfig,
  type ProjectConfig,
} from "../src/core/project.js";
import { readRegistry, type TemplateSource } from "../src/core/registry.js";

const TEMPLATES_ROOT = join(process.cwd(), "..", "radiance-templates");
const TYPECHECK_TIMEOUT_MS = 10 * 60_000;

async function localSource(): Promise<TemplateSource> {
  const registry = await readRegistry(TEMPLATES_ROOT);
  return {
    root: TEMPLATES_ROOT,
    version: registry.version,
    registry,
    local: true,
  };
}

/**
 * Mirrors `initCommand`'s merge path: scaffold → starter modules → optional extras,
 * then write `radiance.json` and commit the workspace (as `-y` / non-interactive init does).
 */
async function simulateInit(
  source: TemplateSource,
  options: {
    appName: string;
    starterId: string | null;
    /** Same role as init interview `extraModules` / CLI extras. */
    extraModules?: string[];
    optionFlags?: string[];
  },
): Promise<{ root: string; project: ProjectConfig }> {
  const root = await mkdtemp(join(tmpdir(), "radiance-init-"));
  const starter = options.starterId
    ? source.registry.starters.find((entry) => entry.id === options.starterId)
    : undefined;
  const themePack = starter?.defaults?.themePack ?? "neutral";
  const vars = deriveVars(options.appName, { themePack, defaultLocale: "en" });

  const staged = await stageInstall({
    root,
    source,
    vars,
    scaffold: true,
    starterId: options.starterId,
    moduleIds: options.extraModules ?? [],
    installed: [],
    optionFlags: options.optionFlags ?? [],
    interactiveOptions: false,
  });

  const project: ProjectConfig = {
    name: vars.appName,
    template: options.starterId,
    templateVersion: starter?.version ?? null,
    registryVersion: source.registry.version,
    scaffold: {
      id: source.registry.scaffold.id,
      version: source.registry.scaffold.version,
    },
    themePack: vars.themePack,
    defaultLocale: vars.defaultLocale,
    locales: ["en"],
    bundleId: vars.bundleId,
    scheme: vars.scheme,
    packageManager: "npm",
    features: staged.features,
    harness: {},
  };

  await staged.workspace.write(
    "radiance.json",
    `${JSON.stringify(project, null, 2)}\n`,
    "radiance",
  );

  const result = await applyChanges(root, staged.workspace.changes(), {
    confirm: false,
    dryRun: false,
  });
  assert.equal(result.cancelled, false);
  assert.ok(result.written.length > 0);
  await writeProjectConfig(root, project);

  return { root, project };
}

/**
 * Mirrors `addCommand` (without `--force`): skip already-installed ids, merge into the
 * existing project, update `radiance.json`.
 */
async function simulateAdd(
  source: TemplateSource,
  root: string,
  project: ProjectConfig,
  moduleIds: string[],
  options: { force?: boolean; optionFlags?: string[] } = {},
): Promise<{
  project: ProjectConfig;
  written: string[];
  skippedAsInstalled: string[];
}> {
  const alreadyInstalled = moduleIds.filter((id) =>
    isFeatureInstalled(project, id),
  );
  const target = options.force
    ? moduleIds
    : moduleIds.filter((id) => !alreadyInstalled.includes(id));

  if (target.length === 0) {
    return { project, written: [], skippedAsInstalled: alreadyInstalled };
  }

  const installed = options.force
    ? project.features
        .filter((feature) => !target.includes(feature.id))
        .map((f) => f.id)
    : project.features.map((feature) => feature.id);

  const vars = deriveVars(project.name, {
    themePack: project.themePack,
    defaultLocale: project.defaultLocale,
    bundleId: project.bundleId,
    scheme: project.scheme,
  });

  const staged = await stageInstall({
    root,
    source,
    vars,
    scaffold: false,
    starterId: null,
    moduleIds: target,
    installed,
    existingFeatures: project.features,
    optionFlags: options.optionFlags ?? [],
    interactiveOptions: false,
  });

  const updatedProject: ProjectConfig = {
    ...project,
    features: staged.features,
    themePack: vars.themePack,
  };
  await staged.workspace.write(
    "radiance.json",
    `${JSON.stringify(updatedProject, null, 2)}\n`,
    "radiance",
  );

  const result = await applyChanges(root, staged.workspace.changes(), {
    confirm: false,
    dryRun: false,
  });
  assert.equal(result.cancelled, false);

  if (result.written.length > 0) {
    await writeProjectConfig(root, updatedProject);
  }

  return {
    project: updatedProject,
    written: result.written.map((change) => change.path),
    skippedAsInstalled: alreadyInstalled,
  };
}

async function npmInstall(root: string): Promise<void> {
  // Drop inherited npm_config_* before spawning npm.
  //
  // yarn v1 re-exports every setting from the developer's ~/.npmrc as an
  // environment variable, so a personal config leaks into these installs. One
  // such setting (`allow-scripts`) is rejected outright by npm 11 for a
  // project-scoped install, which fails this suite on that machine and nowhere
  // else. The production workers already scrub the same way.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("npm_config_")),
  );

  const install = await execa("npm", ["install", "--no-fund", "--no-audit"], {
    cwd: root,
    reject: false,
    timeout: TYPECHECK_TIMEOUT_MS,
    env,
    extendEnv: false,
  });
  assert.equal(
    install.exitCode,
    0,
    `npm install failed:\n${install.stdout}\n${install.stderr}`,
  );
}

async function expoInstallCheck(root: string): Promise<void> {
  const check = await execa("npx", ["expo", "install", "--check"], {
    cwd: root,
    reject: false,
    timeout: TYPECHECK_TIMEOUT_MS,
  });
  assert.equal(
    check.exitCode,
    0,
    `expo install --check failed:\n${check.stdout}\n${check.stderr}`,
  );
}

async function typecheck(root: string): Promise<void> {
  const check = await execa("npm", ["run", "typecheck"], {
    cwd: root,
    reject: false,
    timeout: TYPECHECK_TIMEOUT_MS,
  });
  assert.equal(
    check.exitCode,
    0,
    `typecheck failed:\n${check.stdout}\n${check.stderr}`,
  );
}

async function packageJson(root: string): Promise<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}> {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}

function mapsApiFixture(includeSocialPostCard: boolean): string {
  const social = includeSocialPostCard
    ? `
import type { PostCardProps } from '@/components/PostCard';
import type { Post } from '@/lib/posts';

declare const post: Post;
const _postCardProps: PostCardProps = { post, onPress: () => undefined };
void _postCardProps;
`
    : "";

  return `import { StateView } from '@/components/StateView';
import { Screen } from '@/components/ui/Screen';
import { useCollection } from '@/lib/firestore';
import { useUserLocation } from '@/lib/maps';
${social}
/** Public API smoke for modules commonly pulled in after init via prompt/add. */
export function MergeApiFixture() {
  void useCollection;
  void useUserLocation;
  return (
    <Screen width="content">
      <StateView kind="loading" />
    </Screen>
  );
}
`;
}

describe("radiance init / add merge typecheck", () => {
  it(
    "init typechecks every starter with no extra modules (stock catalogue merge)",
    { timeout: TYPECHECK_TIMEOUT_MS * 4 },
    async () => {
      const source = await localSource();
      assert.ok(source.registry.starters.length >= 3);

      for (const starter of source.registry.starters) {
        let root: string | undefined;
        try {
          const created = await simulateInit(source, {
            appName: `Init ${starter.id}`,
            starterId: starter.id,
          });
          root = created.root;

          for (const moduleId of starter.modules) {
            assert.ok(
              isFeatureInstalled(created.project, moduleId),
              `${starter.id} init missing feature ${moduleId}`,
            );
          }
          assert.equal(
            isFeatureInstalled(created.project, "maps"),
            starter.modules.includes("maps"),
            `${starter.id} maps install mismatch`,
          );

          await npmInstall(root);
          await expoInstallCheck(root);
          await typecheck(root);
        } finally {
          if (root) await rm(root, { recursive: true, force: true });
        }
      }
    },
  );

  it(
    "bare scaffold init typechecks",
    { timeout: TYPECHECK_TIMEOUT_MS },
    async () => {
      const source = await localSource();
      let root: string | undefined;
      try {
        const created = await simulateInit(source, {
          appName: "Bare Scaffold",
          starterId: null,
        });
        root = created.root;

        for (const moduleId of source.registry.scaffold.requiredModules) {
          assert.ok(isFeatureInstalled(created.project, moduleId));
        }
        assert.equal(created.project.template, null);

        await npmInstall(root);
        await typecheck(root);
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "init then radiance-add maps typechecks every starter",
    { timeout: TYPECHECK_TIMEOUT_MS * 4 },
    async () => {
      const source = await localSource();

      for (const starter of source.registry.starters) {
        let root: string | undefined;
        try {
          const created = await simulateInit(source, {
            appName: `AddMaps ${starter.id}`,
            starterId: starter.id,
          });
          root = created.root;

          await npmInstall(root);
          await typecheck(root);

          if (isFeatureInstalled(created.project, "maps")) {
            const pkg = await packageJson(root);
            assert.ok(pkg.dependencies?.["expo-location"]);
            assert.ok(pkg.dependencies?.["react-native-maps"]);
            continue;
          }

          const added = await simulateAdd(source, root, created.project, [
            "maps",
          ]);
          assert.ok(isFeatureInstalled(added.project, "maps"));
          assert.ok(added.written.includes("lib/maps.ts"));
          assert.ok(added.written.includes("package.json"));

          const pkg = await packageJson(root);
          assert.ok(pkg.dependencies?.["expo-location"]);
          assert.ok(pkg.dependencies?.["react-native-maps"]);

          await npmInstall(root);
          await typecheck(root);
        } finally {
          if (root) await rm(root, { recursive: true, force: true });
        }
      }
    },
  );

  it(
    "init with extraModules=[maps] (interview extras path) typechecks social-app",
    { timeout: TYPECHECK_TIMEOUT_MS },
    async () => {
      const source = await localSource();
      let root: string | undefined;
      try {
        const created = await simulateInit(source, {
          appName: "Social With Maps Extras",
          starterId: "social-app",
          extraModules: ["maps"],
        });
        root = created.root;

        assert.ok(isFeatureInstalled(created.project, "maps"));
        await npmInstall(root);
        await typecheck(root);
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "sequential add maps then deep-linking on social-app typechecks",
    { timeout: TYPECHECK_TIMEOUT_MS },
    async () => {
      const source = await localSource();
      let root: string | undefined;
      try {
        const created = await simulateInit(source, {
          appName: "Social Sequential Adds",
          starterId: "social-app",
        });
        root = created.root;
        await npmInstall(root);

        const withMaps = await simulateAdd(source, root, created.project, [
          "maps",
        ]);
        const withLinks = await simulateAdd(source, root, withMaps.project, [
          "deep-linking",
        ]);

        assert.ok(isFeatureInstalled(withLinks.project, "maps"));
        assert.ok(isFeatureInstalled(withLinks.project, "deep-linking"));
        assert.ok(
          withLinks.skippedAsInstalled.includes("deep-linking") ||
            withLinks.written.some((path) => path.includes("deep-link")),
        );

        await npmInstall(root);
        await typecheck(root);
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "add skips modules already installed by the starter (no --force)",
    { timeout: TYPECHECK_TIMEOUT_MS },
    async () => {
      const source = await localSource();
      let root: string | undefined;
      try {
        const created = await simulateInit(source, {
          appName: "Skip Installed",
          starterId: "social-app",
        });
        root = created.root;

        const before = await readFile(join(root, "package.json"), "utf8");
        const result = await simulateAdd(source, root, created.project, [
          "firestore",
          "auth",
        ]);

        assert.deepEqual(result.skippedAsInstalled.sort(), [
          "auth",
          "firestore",
        ]);
        assert.deepEqual(result.written, []);
        assert.equal(
          await readFile(join(root, "package.json"), "utf8"),
          before,
        );
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "after init+add maps, public API fixture typechecks on social-app",
    { timeout: TYPECHECK_TIMEOUT_MS },
    async () => {
      const source = await localSource();
      let root: string | undefined;
      try {
        const created = await simulateInit(source, {
          appName: "Api Fixture",
          starterId: "social-app",
        });
        root = created.root;
        await simulateAdd(source, root, created.project, ["maps"]);

        await writeFile(
          join(root, "merge-api.fixture.tsx"),
          mapsApiFixture(true),
          "utf8",
        );
        await npmInstall(root);
        await typecheck(root);
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    },
  );
});
