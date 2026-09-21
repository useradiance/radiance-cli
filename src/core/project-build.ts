import { execa } from "execa";

import { RadianceError, ui } from "./logger.js";
import {
  runScriptCommand,
  runScriptInDirCommand,
  type PackageManager,
} from "./package-manager.js";

/** Export the Expo web build into `dist/` (Firebase Hosting public dir). */
export async function exportWeb(
  root: string,
  pm: PackageManager,
): Promise<void> {
  ui.step("Exporting the web build");
  const { command, args } = runScriptCommand(pm, "expo", [
    "export",
    "--platform",
    "web",
  ]);
  const result = await execa(command, args, {
    cwd: root,
    stdio: "inherit",
    reject: false,
  });

  if (result.exitCode !== 0) {
    throw new RadianceError("The web export failed", "See the output above.");
  }
}

/** Build Cloud Functions (`functions` package script). */
export async function buildFunctions(
  root: string,
  pm: PackageManager,
): Promise<void> {
  ui.step("Building Cloud Functions");
  const { command, args } = runScriptInDirCommand(pm, "functions", "build");
  const result = await execa(command, args, {
    cwd: root,
    stdio: "inherit",
    reject: false,
  });

  if (result.exitCode !== 0) {
    throw new RadianceError(
      "The functions build failed",
      "See the output above.",
    );
  }
}
