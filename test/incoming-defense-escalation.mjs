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

bot.attackBehavior.incomingHostileAttackPressure = () => 1;
bot.lastIncomingDefenseStructureTick = 11;
await bot.handleIncomingDefense(14, null, 0);
assert.equal(
  structureCalls,
  2,
  "a parity invasion retries defensive construction before the routine cadence",
);

bot.attackBehavior.incomingHostileAttackPressure = () => 0.99;
bot.lastIncomingDefenseStructureTick = 14;
await bot.handleIncomingDefense(17, null, 0);
assert.equal(structureCalls, 2, "a sub-parity border probe keeps the normal construction cadence");

const multifrontBot = Object.create(sandbox.NationBot.prototype);
let multifrontResponses = 0;
let multifrontStructures = 0;
let threatLeader = 7;
const hostile7 = { smallID: () => 7 };
const hostile8 = { smallID: () => 8 };
multifrontBot.attackRate = 36;
multifrontBot.incomingDefenseTargetKey = null;
multifrontBot.lastIncomingDefenseAttemptTick = -Infinity;
multifrontBot.lastIncomingDefenseStructureTick = -Infinity;
multifrontBot.feat = (name) => name === "build";
multifrontBot.tickIsCurrent = () => true;
multifrontBot.attackBehavior = {
  findIncomingAttackPlayer: () => (threatLeader === 7 ? hostile7 : hostile8),
  incomingHostileAttacks: () => [{ attacker: () => hostile7 }, { attacker: () => hostile8 }],
  incomingHostileAttackPressure: () => 5,
  respondToIncomingAttack: async () => {
    multifrontResponses++;
    return false;
  },
};
multifrontBot.structureBehavior = {
  handleStructures: async () => {
    multifrontStructures++;
  },
};
for (let tick = 100; tick < 106; tick++) {
  threatLeader = tick % 2 === 0 ? 7 : 8;
  await multifrontBot.handleIncomingDefense(tick, null, 0);
}
assert.equal(
  multifrontResponses,
  2,
  "alternating leaders in one hostile set retry at the defensive cadence instead of every tick",
);
assert.equal(
  multifrontStructures,
  2,
  "alternating leaders do not thrash the defensive construction lane",
);
multifrontBot.attackBehavior.incomingHostileAttacks = () => [
  { attacker: () => hostile7 },
  { attacker: () => hostile8 },
  { attacker: () => ({ smallID: () => 9 }) },
];
await multifrontBot.handleIncomingDefense(106, null, 0);
assert.equal(
  multifrontResponses,
  3,
  "a newly joined attacker immediately refreshes the defense response",
);
assert.equal(
  multifrontStructures,
  3,
  "a newly joined attacker immediately refreshes defensive construction",
);

process.stdout.write("incoming defense escalation tests passed\n");
