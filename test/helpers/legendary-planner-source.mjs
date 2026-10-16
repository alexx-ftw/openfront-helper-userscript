import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INGAME_FILES_EXPANDED, read } from "../../scripts/build/sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLANNER_DIRECTORY = "engine/ingame/auto-bot/legendary-planner/";
const plannerFiles = INGAME_FILES_EXPANDED.filter((file) => file.startsWith(PLANNER_DIRECTORY));

/** Return the planner scripts in the build's ordered classic-script representation. */
export function readLegendaryPlannerSource() {
  const files = plannerFiles.filter((file) => fs.existsSync(path.resolve(here, "../..", file)));
  if (files.length === 0) {
    throw new Error(
      "legendary-planner chunks are not wired into INGAME_FILES (scripts/build/sources.mjs)",
    );
  }
  return files.map(read).join("");
}
