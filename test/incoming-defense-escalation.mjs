import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/nationExecution.js");
const source = fs.readFileSync(sourcePath, "utf8");
const sandbox = {
  state: { settings: { winFixes: true } },
  autoBotProfileAsyncPhase: async (_profile, _name, action) => action(),
};
executeClassicScript(`${source}\nglobalThis.NationBot = NationBot;`, sandbox, {
  filename: sourcePath,
});

const bot = Object.create(sandbox.NationBot.prototype);
let structureCalls = 0;
bot.attackRate = 36;
bot.incomingDefenseTargetKey = "hostile";
bot.lastIncomingDefenseAttemptTick = 8;
bot.lastIncomingDefenseStructureTick = 8;
bot.feat = (name) => name === "build";
bot.tickIsCurrent = () => true;
bot.attackBehavior = {
  findIncomingAttackPlayer: () => ({ smallID: () => 7 }),
  incomingHostileAttackPressure: () => 5,
  respondToIncomingAttack: async () => false,
};
bot.structureBehavior = {
  handleStructures: async () => {
    structureCalls++;
  },
};

await bot.handleIncomingDefense(11, null, 0);
assert.equal(
  structureCalls,
  1,
  "a coordinated siege retries defensive construction every three ticks",
);
assert.equal(bot.lastIncomingDefenseStructureTick, 11);

bot.attackBehavior.incomingHostileAttackPressure = () => 1.5;
bot.lastIncomingDefenseStructureTick = 11;
await bot.handleIncomingDefense(14, null, 0);
assert.equal(structureCalls, 1, "a non-overwhelming attack keeps the normal construction cadence");

process.stdout.write("incoming defense escalation tests passed\n");
