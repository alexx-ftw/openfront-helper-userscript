import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const autoBotSources = [
  "engine/ingame/auto-bot/core.js",
  "engine/ingame/auto-bot/helpers.js",
  "engine/ingame/auto-bot/context.js",
  "engine/ingame/auto-bot/portutil.js",
  "engine/ingame/auto-bot/attackBehavior.js",
]
  .map(read)
  .join("\n");
const ingameAvailabilitySource = [
  "engine/ingame/trade-policy/context.js",
  "engine/ingame/trade-policy/players.js",
  "engine/ingame/trade-policy/partners.js",
  "engine/ingame/trade-policy/apply.js",
]
  .map(read)
  .join("\n");
const standaloneDonationSource = read("engine/ingame/auto-donate.js");
const autoBotGameApiSource = read("engine/ingame/auto-bot/gameApi.js");
const companionSource = ["engine/ingame/companion/core.js", "engine/ingame/companion/engine.js"]
  .map(read)
  .join("\n");
const lobbyCoreSource = read("engine/lobby/core.js");
const lobbyMessagesSource = read("engine/lobby/auto-join.js");
const sharedSettingsSource = read("engine/shared/settings.js");
const popupSource = read("src/shell/popup/panel.ts");

for (const [label, source] of [
  ["auto-bot", autoBotSources],
  ["in-game bridge", ingameAvailabilitySource],
  ["lobby core", lobbyCoreSource],
  ["lobby message handler", lobbyMessagesSource],
  ["shared settings", sharedSettingsSource],
]) {
  assert.doesNotMatch(
    source,
    /CHEATS_AVAILABILITY|cheatsAvailable|isCheatsAvailable|isCustomGame|gameType\s*[:(]|GameType\s*=|donateAllowedByLobby|lobby disables donations/,
    `${label} must not detect public/custom lobby type or gate helper functionality`,
  );
}

assert.doesNotMatch(
  autoBotSources,
  /config\(\)\.donateTroops\(\)\s*===\s*false|config\.donateTroops\(\)\s*===\s*false|canDonateTroops/,
  "the Auto-Bot must not suppress troop donations based on lobby configuration",
);
assert.doesNotMatch(
  standaloneDonationSource,
  /gameAllowsTroopDonation|canDonateTroops|config\?*\.?donateTroops/,
  "standalone troop donations must not consult lobby donation capabilities",
);
assert.doesNotMatch(
  autoBotGameApiSource,
  /canDonateTroops/,
  "the Auto-Bot adapter must not expose the lobby-gated troop donation capability",
);
assert.doesNotMatch(
  companionSource,
  /canDonateTroops|bossCanDonateTroops/,
  "Companion troop donations must not consult lobby donation capabilities",
);
assert.doesNotMatch(
  popupSource,
  /private[- ]lobby/i,
  "the popup must not describe Auto-Bot as private-lobby-only",
);
for (const locale of fs.readdirSync(path.join(root, "locales"))) {
  const localeSource = read(`locales/${locale}/common.json`);
  assert.doesNotMatch(
    localeSource,
    /private[- ]lobby training tool/i,
    `${locale} locale must not retain the obsolete private-lobby description`,
  );
}

assert.match(
  lobbyCoreSource,
  /type:\s*"SHOW_NUKE_SUGGESTIONS"[\s\S]*?enabled:\s*Boolean\(lobbyState\.settings\.showNukeSuggestions\)/,
  "nuke suggestions follow only their user preference",
);
assert.match(
  lobbyCoreSource,
  /type:\s*"SET_AUTO_NUKE"[\s\S]*?enabled:\s*Boolean\(lobbyState\.settings\.autoNuke\)/,
  "Auto Nukes follows only its user preference",
);

process.stdout.write("public lobby unrestricted tests passed\n");
