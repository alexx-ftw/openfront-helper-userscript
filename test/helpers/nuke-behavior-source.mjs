import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INGAME_FILES_EXPANDED, read } from "../../scripts/build/sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NUKE_BEHAVIOR_PREFIX = "engine/ingame/auto-bot/nuke-behavior/";

/** Return the nuke-behavior scripts in the build's ordered classic-script representation. */
export function readNukeBehaviorSource() {
  const files = INGAME_FILES_EXPANDED.filter((file) => file.startsWith(NUKE_BEHAVIOR_PREFIX)).filter(
    (file) => fs.existsSync(path.resolve(here, "../..", file)),
  );
  if (files.length === 0) {
    throw new Error(
      "nuke-behavior chunks are not wired into INGAME_FILES (scripts/build/sources.mjs)",
    );
  }
  return files.map(read).join("");
}
