// Source inventory and shared readers for the userscript build.
//
// LOBBY_FILES / INGAME_FILES are load order: engine files are concatenated in
// this exact order into a shared sloppy-mode scope (see the auto-bot README),
// so the order below is authoritative.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INGAME_FILES } from "./ingame-files.mjs";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const read = (rel) => fs.readFileSync(path.resolve(PROJECT_ROOT, rel), "utf8");

export const logBuild = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);

export { INGAME_FILES };

const I18N_OVERRIDE =
  "\n;(window.__OFH && window.__OFH.installI18nOverride && window.__OFH.installI18nOverride());\n";

// Lobby layer (formerly "content"): map data, shared settings/i18n, auto-join,
// and the floating auto-join panel.
export const LOBBY_FILES = [
  "engine/map-data.js",
  "engine/shared/settings.js",
  "engine/shared/i18n.js",
  "__I18N_OVERRIDE__",
  "engine/lobby/core.js",
  "engine/lobby/floating-autojoin.js",
  "engine/lobby/auto-join.js",
];

export const AUTO_BOT_FILES = INGAME_FILES.filter((file) => file.includes("/auto-bot/"));

// The Legendary planner is mechanically split into ordered classic-script
// chunks that must stay contiguous in INGAME_FILES. The build emits the whole
// group under the legacy single-file banner with raw chunk bytes, so assembled
// output stays byte-identical to the pre-split planner slot.
// Split classic scripts (one file per logical module, mechanically chunked to
// stay under the 200-line limit) are declared in INGAME_FILES as
// "<dir>/SPLIT_GROUP". Every chunk in that directory is loaded contiguously in
// lexicographic part order, under the legacy single-file banner, so build
// output stays byte-identical to the pre-split slot and the directory is the
// single source of truth for the chunk list.
export const SPLIT_GROUPS = [
  {
    marker: "auto-bot/legendary-planner/SPLIT_GROUP",
    prefix: "engine/ingame/auto-bot/legendary-planner/",
    bannerFile: "engine/ingame/auto-bot/legendaryPlanner.js",
  },
  {
    marker: "auto-bot/nuke-behavior/SPLIT_GROUP",
    prefix: "engine/ingame/auto-bot/nuke-behavior/",
    bannerFile: "engine/ingame/auto-bot/nukeBehavior.js",
  },
  {
    marker: "auto-bot/structure-behavior/SPLIT_GROUP",
    prefix: "engine/ingame/auto-bot/structure-behavior/",
    bannerFile: "engine/ingame/auto-bot/structureBehavior.js",
  },
];

function splitGroupFor(file) {
  return SPLIT_GROUPS.find((group) => file.endsWith(group.marker));
}

export function splitGroupFiles(group) {
  const directory = path.join(PROJECT_ROOT, group.prefix);
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => group.prefix + file);
}

function expandSplitGroups(files) {
  return files.flatMap((file) => {
    const group = splitGroupFor(file);
    return group ? splitGroupFiles(group) : [file];
  });
}

export const INGAME_FILES_EXPANDED = expandSplitGroups(INGAME_FILES);

/** Assemble classic scripts with one legacy banner per raw-concatenated split group. */
export function readEngineFilesGrouped(files) {
  return files
    .map((file) => {
      const group = splitGroupFor(file);
      if (!group) return readEngineFile(file);
      return `\n// ===== ${group.bannerFile} =====\n${splitGroupFiles(group).map(read).join("")}\n`;
    })
    .join("");
}

export function readEngineFile(rel) {
  return `\n// ===== ${rel} =====\n${read(rel)}\n`;
}

export function readLobbyFile(rel) {
  if (rel === "__I18N_OVERRIDE__") return I18N_OVERRIDE;
  return readEngineFile(rel);
}

export function wrapIife(body) {
  return `\n;(function(){\n${body}\n})();\n`;
}
