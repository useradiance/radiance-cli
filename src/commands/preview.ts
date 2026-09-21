import { execa } from "execa";

import { loadConfig } from "../core/config.js";
import { RadianceError, bindLogSession, ui } from "../core/logger.js";
import {
  resolvePackageManager,
  runScriptCommand,
} from "../core/package-manager.js";
import { exportWeb } from "../core/project-build.js";
import { requireProject } from "../core/project.js";

export type PreviewOptions = {
  export?: boolean;
};

/**
 * Live Expo web preview, or a static web export with `--export`.
 */
export async function previewCommand(options: PreviewOptions): Promise<void> {
  const { root, config: project } = await requireProject();
  bindLogSession(root);
  const config = await loadConfig();
  const pm = await resolvePackageManager({
    root,
    project: project.packageManager,
    global: config.packageManager,
  });

  if (options.export) {
    await exportWeb(root, pm);
    ui.success(`Web export → ${root}/dist`);
    return;
  }

  ui.heading("Starting Expo web");
  ui.detail("MMKV, maps, and Crashlytics need a dev client — not Expo Go.");
  const { command, args } = runScriptCommand(pm, "expo", ["start", "--web"]);
  const result = await execa(command, args, {
    cwd: root,
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new RadianceError(
      "Expo web failed to start",
      "See the output above.",
    );
  }
}
