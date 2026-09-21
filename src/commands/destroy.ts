import * as prompts from "@clack/prompts";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  assertFirebaseCli,
  assertSafeToDeleteDirectory,
  deleteFirebaseProject,
  deleteFirestoreDatabase,
  deleteFunctions,
  deleteHostingSite,
  ensureFirebaseLogin,
  listFunctions,
  listHostingSites,
  openInBrowser,
  resolveLinkedFirebaseProjectId,
} from "../core/firebase-cli.js";
import { RadianceError, bindLogSession, ui } from "../core/logger.js";
import { requireProject } from "../core/project.js";

import { FIREBASE_ENV_KEYS } from "./setup-firebase.js";
import { NATIVE_FIREBASE_APP_ID_KEYS } from "../core/app-distribution.js";

export type DestroyTarget =
  | "firebase-project"
  | "hosting"
  | "functions"
  | "firestore"
  | "unlink"
  | "local";

export type DestroyOptions = {
  firebaseProject?: boolean;
  hosting?: boolean;
  functions?: boolean;
  firestore?: boolean;
  unlink?: boolean;
  local?: boolean;
  yes?: boolean;
  force?: boolean;
};

const DESTROY_ORDER: DestroyTarget[] = [
  "firebase-project",
  "hosting",
  "functions",
  "firestore",
  "unlink",
  "local",
];

/** Sentinel value for the multiselect "Select all" row. */
export const DESTROY_SELECT_ALL = "__all__" as const;

export type DestroyPromptValue = DestroyTarget | typeof DESTROY_SELECT_ALL;

/** Drop redundant cloud targets when the whole Firebase project is selected. */
export function coerceDestroyTargets(
  selected: DestroyTarget[],
): DestroyTarget[] {
  const set = new Set(selected);
  if (set.has("firebase-project")) {
    set.delete("hosting");
    set.delete("functions");
    set.delete("firestore");
  }
  return DESTROY_ORDER.filter((target) => set.has(target));
}

/**
 * Expand a multiselect result. If "Select all" is checked, return every available
 * target (still coerced so firebase-project drops redundant cloud deletes).
 */
export function expandDestroySelection(
  selected: DestroyPromptValue[],
  available: DestroyTarget[],
): DestroyTarget[] {
  if (selected.includes(DESTROY_SELECT_ALL)) {
    return coerceDestroyTargets(available);
  }
  return coerceDestroyTargets(
    selected.filter(
      (value): value is DestroyTarget => value !== DESTROY_SELECT_ALL,
    ),
  );
}

export function targetsFromFlags(options: DestroyOptions): DestroyTarget[] {
  const selected: DestroyTarget[] = [];
  if (options.firebaseProject) selected.push("firebase-project");
  if (options.hosting) selected.push("hosting");
  if (options.functions) selected.push("functions");
  if (options.firestore) selected.push("firestore");
  if (options.unlink) selected.push("unlink");
  if (options.local) selected.push("local");
  return coerceDestroyTargets(selected);
}

/** Clear Firebase SDK values in a `.env` file while keeping key lines and other vars. */
export function clearFirebaseEnvValues(content: string): string {
  let next = content;
  for (const key of [...FIREBASE_ENV_KEYS, ...NATIVE_FIREBASE_APP_ID_KEYS]) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(next)) {
      next = next.replace(pattern, `${key}=`);
    }
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

/**
 * Restore eas.json Firebase project id placeholders when they match the linked id.
 * Uses nearby profile keys (`production` / `prod` vs preview/development/staging) as a hint.
 */
export function restoreEasProjectIds(
  content: string,
  projectId: string,
): string {
  const lines = content.split("\n");
  let profileHint: "staging" | "prod" = "staging";

  return lines
    .map((line) => {
      if (/"production"\s*:/.test(line) || /"prod"\s*:/.test(line))
        profileHint = "prod";
      if (
        /"preview"\s*:/.test(line) ||
        /"development"\s*:/.test(line) ||
        /"staging"\s*:/.test(line)
      ) {
        profileHint = "staging";
      }

      if (
        !line.includes("EXPO_PUBLIC_FIREBASE_PROJECT_ID") ||
        !line.includes(projectId)
      ) {
        return line;
      }

      const placeholder =
        profileHint === "prod"
          ? "radiance-prod-placeholder"
          : "radiance-staging-placeholder";
      return line.replaceAll(projectId, placeholder);
    })
    .join("\n");
}

export function placeholderFirebaserc(): string {
  return `${JSON.stringify(
    {
      projects: {
        default: "radiance-staging-placeholder",
        staging: "radiance-staging-placeholder",
        prod: "radiance-prod-placeholder",
      },
    },
    null,
    2,
  )}\n`;
}

export async function hasLocalFirebaseLink(root: string): Promise<boolean> {
  if (await resolveLinkedFirebaseProjectId(root)) return true;

  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    const env = await readFile(envPath, "utf8");
    return FIREBASE_ENV_KEYS.some((key) => {
      const match = new RegExp(`^${key}=(.+)$`, "m").exec(env);
      return Boolean(match?.[1]?.trim());
    });
  }

  return false;
}

export async function destroyCommand(
  pathArg: string | undefined,
  options: DestroyOptions,
): Promise<void> {
  const { root, config } = await requireProject(pathArg);
  bindLogSession(root);
  ui.trace(
    `destroy targets from flags: ${JSON.stringify(targetsFromFlags(options))}`,
  );
  const projectId = await resolveLinkedFirebaseProjectId(root);
  const linked = await hasLocalFirebaseLink(root);
  const fromFlags = targetsFromFlags(options);

  ui.heading("Destroy");
  ui.detail(`Project: ${config.name}`);
  ui.detail(`Path: ${root}`);
  if (projectId) ui.detail(`Firebase: ${projectId}`);
  else ui.detail("Firebase: (not linked)");
  ui.blank();

  let targets: DestroyTarget[];

  if (fromFlags.length > 0) {
    targets = fromFlags;
  } else if (options.yes && !options.force) {
    throw new RadianceError(
      "Nothing to destroy",
      "Pass explicit targets (e.g. `--unlink --local`) or run interactively without `-y`. Use `--force` to skip confirmations.",
    );
  } else if (options.yes && options.force) {
    throw new RadianceError(
      "Nothing to destroy",
      "Pass explicit targets with `--force`, e.g. `radiance destroy --firebase-project --unlink --local --force`.",
    );
  } else {
    targets = await promptTargets({ projectId, linked });
  }

  if (targets.length === 0) {
    ui.info("Nothing selected.");
    return;
  }

  const cloudTargets = targets.filter(
    (target) =>
      target === "firebase-project" ||
      target === "hosting" ||
      target === "functions" ||
      target === "firestore",
  );

  if (cloudTargets.length > 0 && !projectId) {
    throw new RadianceError(
      "No Firebase project is linked",
      "Link one with `radiance setup firebase`, or destroy only `--unlink` / `--local`.",
    );
  }

  if (!options.force) {
    await confirmDestruction({
      targets,
      projectId,
      directoryName: basename(root),
    });
  }

  const errors: string[] = [];
  const notes: string[] = [];

  if (targets.includes("firebase-project") && projectId) {
    try {
      await assertFirebaseCli();
      await ensureFirebaseLogin();
      const method = await deleteFirebaseProject(projectId, {
        onManualDelete: options.force
          ? undefined
          : async (consoleUrl) => {
              ui.warn(
                "Automated delete failed — finish in the Firebase console.",
              );
              ui.detail(consoleUrl);
              try {
                await openInBrowser(consoleUrl);
              } catch {
                ui.warn("Could not open a browser — use the URL above.");
              }
              const done = await prompts.confirm({
                message: `Have you deleted Firebase project "${projectId}" in the console?`,
                initialValue: false,
              });
              if (prompts.isCancel(done)) throw new RadianceError("Cancelled.");
              return Boolean(done);
            },
      });
      const methodLabel =
        method === "api"
          ? "Cloud Resource Manager API"
          : method === "gcloud"
            ? "gcloud"
            : "Firebase console";
      ui.success(`Deleted GCP project ${projectId} via ${methodLabel}`);
      notes.push(
        "Entire Firebase/GCP project removed (Hosting, Functions, Firestore, Auth, Storage go with it).",
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      ui.error(error instanceof Error ? error.message : String(error));
    }
  } else {
    if (targets.includes("hosting") && projectId) {
      try {
        await assertFirebaseCli();
        await ensureFirebaseLogin();
        const sites = await listHostingSites(projectId, { cwd: root });
        if (sites.length === 0) {
          ui.info("No Hosting sites to delete.");
        } else {
          for (const site of sites) {
            await deleteHostingSite(projectId, site.siteId, { cwd: root });
            ui.success(`Deleted Hosting site ${site.siteId}`);
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        ui.error(error instanceof Error ? error.message : String(error));
      }
    }

    if (targets.includes("functions") && projectId) {
      try {
        await assertFirebaseCli();
        await ensureFirebaseLogin();
        const functions = await listFunctions(projectId, { cwd: root });
        if (functions.length === 0) {
          ui.info("No Cloud Functions to delete.");
        } else {
          await deleteFunctions(projectId, functions, { cwd: root });
          ui.success(`Deleted ${functions.length} Cloud Function(s)`);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        ui.error(error instanceof Error ? error.message : String(error));
      }
    }

    if (targets.includes("firestore") && projectId) {
      try {
        await assertFirebaseCli();
        await ensureFirebaseLogin();
        await deleteFirestoreDatabase(projectId, "(default)", { cwd: root });
        ui.success("Deleted Firestore database (default)");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        ui.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (targets.includes("unlink")) {
    try {
      await unlinkLocalFirebase(root, projectId);
      ui.success("Unlinked local Firebase config");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      ui.error(error instanceof Error ? error.message : String(error));
    }
  }

  if (targets.includes("local")) {
    try {
      assertSafeToDeleteDirectory(root);
      await rm(root, { recursive: true, force: true });
      ui.success(`Deleted project directory ${root}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      ui.error(error instanceof Error ? error.message : String(error));
    }
  }

  ui.blank();
  for (const note of notes) ui.detail(note);

  if (errors.length > 0) {
    throw new RadianceError(
      `Destroy finished with ${errors.length} error(s)`,
      errors.join("\n"),
    );
  }

  ui.success("Done.");
}

async function promptTargets(context: {
  projectId: string | null;
  linked: boolean;
}): Promise<DestroyTarget[]> {
  const available: DestroyTarget[] = [];

  if (context.projectId) {
    available.push("firebase-project", "hosting", "functions", "firestore");
  }

  if (context.linked || context.projectId) {
    available.push("unlink");
  }

  available.push("local");

  const options: { value: DestroyPromptValue; label: string; hint?: string }[] =
    [
      {
        value: DESTROY_SELECT_ALL,
        label: "Select all",
        hint: "everything listed below",
      },
      ...available.map((value) => {
        switch (value) {
          case "firebase-project":
            return {
              value,
              label: "Delete entire Firebase/GCP project",
              hint: context.projectId ?? undefined,
            };
          case "hosting":
            return { value, label: "Delete Hosting site(s)" };
          case "functions":
            return { value, label: "Delete Cloud Functions" };
          case "firestore":
            return { value, label: "Delete Firestore database (default)" };
          case "unlink":
            return {
              value,
              label: "Unlink local Firebase config",
              hint: ".env / .firebaserc / eas.json",
            };
          case "local":
            return { value, label: "Delete this project directory" };
        }
      }),
    ];

  const choice = await prompts.multiselect({
    message: "What do you want to destroy?",
    options,
    required: false,
  });

  if (prompts.isCancel(choice)) throw new RadianceError("Cancelled.");
  return expandDestroySelection(choice as DestroyPromptValue[], available);
}

async function confirmDestruction(input: {
  targets: DestroyTarget[];
  projectId: string | null;
  directoryName: string;
}): Promise<void> {
  const needsProjectConfirm = input.targets.some((target) =>
    ["firebase-project", "hosting", "functions", "firestore"].includes(target),
  );

  if (needsProjectConfirm) {
    if (!input.projectId) {
      throw new RadianceError("No Firebase project id to confirm");
    }
    const typed = await prompts.text({
      message: `Type the Firebase project id (${input.projectId}) to confirm cloud destroy`,
      placeholder: input.projectId,
    });
    if (prompts.isCancel(typed)) throw new RadianceError("Cancelled.");
    if (String(typed).trim() !== input.projectId) {
      throw new RadianceError(
        "Confirmation did not match the Firebase project id",
      );
    }
  }

  if (input.targets.includes("local")) {
    const typed = await prompts.text({
      message: `Type the directory name (${input.directoryName}) to delete local files`,
      placeholder: input.directoryName,
    });
    if (prompts.isCancel(typed)) throw new RadianceError("Cancelled.");
    if (String(typed).trim() !== input.directoryName) {
      throw new RadianceError("Confirmation did not match the directory name");
    }
  }
}

async function unlinkLocalFirebase(
  root: string,
  projectId: string | null,
): Promise<void> {
  const rcPath = join(root, ".firebaserc");
  if (existsSync(rcPath)) {
    await writeFile(rcPath, placeholderFirebaserc(), "utf8");
  }

  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    const existing = await readFile(envPath, "utf8");
    await writeFile(envPath, clearFirebaseEnvValues(existing), "utf8");
  }

  const easPath = join(root, "eas.json");
  if (existsSync(easPath) && projectId) {
    const existing = await readFile(easPath, "utf8");
    const updated = restoreEasProjectIds(existing, projectId);
    if (updated !== existing) {
      await writeFile(
        easPath,
        updated.endsWith("\n") ? updated : `${updated}\n`,
        "utf8",
      );
    }
  }
}
