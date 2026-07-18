import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "engine/ingame/auto-bot/nationExecution.js");
const source = fs.readFileSync(sourcePath, "utf8");
const sandbox = {
  UNIT: { City: "City" },
  state: { settings: { winFixes: true } },
  autoBotProfileAsyncPhase: async (_profile, _name, action) => action(),
};
sandbox.globalThis = sandbox;
executeClassicScript(`${source}\nglobalThis.NationBot = NationBot;`, sandbox, {
  filename: sourcePath,
});

const bot = Object.create(sandbox.NationBot.prototype);
let cityBuilds = 0;
bot.lastOpeningCityAttemptTick = -Infinity;
bot.feat = (feature) => feature === "build" || feature === "expand";
bot.mg = { config: () => ({ isUnitDisabled: () => false }) };
bot.player = { units: () => [] };
bot.tickIsCurrent = () => true;
bot.structureBehavior = {
  maybeSpawnStructure: async (type) => {
    assert.equal(type, "City");
    cityBuilds++;
    return true;
  },
};

assert.equal(
  await bot.maybeBuildOpeningCity(12, null, 0),
  true,
  "an opening expansion may fund the first City without waiting for ordinary cadence",
);
assert.equal(cityBuilds, 1);
assert.equal(
  await bot.maybeBuildOpeningCity(20, null, 0),
  true,
  "the opening City probe is throttled while the expansion follow-up remains pending",
);
assert.equal(cityBuilds, 1);

bot.player = { units: () => [{ type: () => "City" }] };
assert.equal(await bot.maybeBuildOpeningCity(24, null, 0), true);
assert.equal(cityBuilds, 1, "a completed or pending City ends the opening economy lane");

process.stdout.write("opening economy overlap tests passed\n");
