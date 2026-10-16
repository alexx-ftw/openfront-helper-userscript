import { INGAME_FILES_EXPANDED, read } from "../../scripts/build/sources.mjs";

/** Return structure behavior in the build's exact classic-script chunk order. */
export function readStructureBehaviorSource() {
  const files = INGAME_FILES_EXPANDED.filter((file) =>
    file.startsWith("engine/ingame/auto-bot/structure-behavior/"),
  );
  if (files.length === 0) {
    throw new Error("structure-behavior chunks are not wired into INGAME_FILES");
  }
  return files.map(read).join("");
}
