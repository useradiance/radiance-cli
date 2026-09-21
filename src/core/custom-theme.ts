import type { Workspace } from "../core/apply/workspace.js";
import {
  registerCustomThemePack,
  serializeThemePackFile,
  type ThemePackData,
} from "../harness/theme-palette.js";

const CUSTOM_PACK_PATH = "lib/theme/packs/custom.ts";
const CONFIG_PATH = "lib/theme/config.ts";

/** Write a generated custom theme pack into the staging workspace. */
export async function applyCustomThemePack(
  workspace: Workspace,
  pack: ThemePackData,
): Promise<void> {
  await workspace.write(
    CUSTOM_PACK_PATH,
    serializeThemePackFile(pack),
    "theme:custom",
  );

  const config = await workspace.read(CONFIG_PATH);
  if (!config) {
    workspace.note(
      "warn",
      `Could not register custom theme — ${CONFIG_PATH} missing`,
      "theme:custom",
    );
    return;
  }

  await workspace.write(
    CONFIG_PATH,
    registerCustomThemePack(config),
    "theme:custom",
  );
}
