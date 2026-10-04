import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Resolve a templates catalogue the same way CI and bootstrap-starters do:
 * `RADIANCE_TEMPLATES_PATH` first, then the sibling `../radiance-templates` checkout.
 */
export function resolveTemplatesRoot(): string {
  const fromEnv = process.env.RADIANCE_TEMPLATES_PATH?.trim();
  if (fromEnv) {
    const root = resolve(fromEnv);
    if (!existsSync(join(root, "registry.json"))) {
      throw new Error(
        `RADIANCE_TEMPLATES_PATH=${root} has no registry.json.\nPoint it at a radiance-templates checkout.`,
      );
    }
    return root;
  }

  const sibling = resolve(process.cwd(), "..", "radiance-templates");
  if (existsSync(join(sibling, "registry.json"))) return sibling;

  throw new Error(
    "Could not find a templates catalogue.\nSet RADIANCE_TEMPLATES_PATH or keep radiance-templates next to radiance-cli.",
  );
}
