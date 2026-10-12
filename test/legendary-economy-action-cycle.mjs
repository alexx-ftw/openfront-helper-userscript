import assert from "node:assert/strict";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";

const sandbox = {
  state: { settings: { warshipAutoSpawn: true, winFixes: true } },
  window: {},
  tr: (value) => value,
  autoBotProfileAsyncPhase: async (_profile, _name, action) => action(),
  autoBotProfileSyncPhase: (_profile, _name, action) => action(),
};
executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/nationExecution.js")}
globalThis.__testApi = { NationBot };`,
  sandbox,
  { filename: repositoryFilePath("engine/ingame/auto-bot/nationExecution.js") },
);

async function runDecisionChain({
  missileDefenseUrgent = false,
  peaceWindowSamClaimed = false,
  plateauCityBuilt = false,
}) {
  const calls = [];
  let structureAttempts = 0;
  const bot = Object.create(sandbox.__testApi.NationBot.prototype);
  bot.status = "";
  bot.feat = (feature) => ["build", "nuke", "expand", "warship"].includes(feature);
  bot.tickIsCurrent = () => true;
  bot.emojiBehavior = { maybeSendCasualEmoji: () => calls.push("emoji") };
  bot.runDiplomacy = () => {};
  bot.structureBehavior = {
    legendaryMissileDefenseUrgent: () => {
      calls.push("urgent-check");
      return missileDefenseUrgent;
    },
    maybeSpawnPeaceWindowSam: async () => {
      calls.push("peace-window-sam");
      if (peaceWindowSamClaimed) structureAttempts += 1;
      return peaceWindowSamClaimed;
    },
    maybeSpawnPlateauCity: async () => {
      calls.push("plateau-city");
      if (plateauCityBuilt) structureAttempts += 1;
      return plateauCityBuilt;
    },
    handleStructures: async () => {
      calls.push("structures");
      calls.push(missileDefenseUrgent ? "urgent-sam" : "ordinary-structure");
      structureAttempts += 1;
    },
  };
  bot.mirvBehavior = { considerMIRV: async () => calls.push("mirv") };
  bot.warshipBehavior = {
    maybeSpawnWarship: async () => calls.push("warship-build"),
    counterWarshipInfestation: async () => calls.push("warship-counter"),
  };
  bot.attackBehavior = { maybeAttack: async () => calls.push("attack") };
  bot.nukeBehavior = { maybeSendNuke: async () => calls.push("nuke") };

  await bot.runDecisionChain(null, 1);
  return { calls, structureAttempts };
}

const urgentMissile = await runDecisionChain({
  missileDefenseUrgent: true,
  peaceWindowSamClaimed: true,
  plateauCityBuilt: true,
});
assert.deepEqual(
  urgentMissile.calls,
  [
    "emoji",
    "urgent-check",
    "mirv",
    "warship-build",
    "structures",
    "urgent-sam",
    "attack",
    "warship-counter",
    "nuke",
  ],
  "an urgent missile defers both early economy/SAM probes to the full structures response",
);
assert.equal(urgentMissile.structureAttempts, 1, "only the urgent SAM lane attempts a structure");

const peaceWindowSam = await runDecisionChain({
  peaceWindowSamClaimed: true,
  plateauCityBuilt: true,
});
assert.deepEqual(
  peaceWindowSam.calls,
  [
    "emoji",
    "urgent-check",
    "peace-window-sam",
    "mirv",
    "warship-build",
    "attack",
    "warship-counter",
    "nuke",
  ],
  "a claimed peace-window SAM lane skips plateau economy and later structures",
);
assert.equal(peaceWindowSam.structureAttempts, 1, "the claimed SAM lane is not retried later");

const plateauCity = await runDecisionChain({ plateauCityBuilt: true });
assert.deepEqual(
  plateauCity.calls,
  [
    "emoji",
    "urgent-check",
    "peace-window-sam",
    "plateau-city",
    "mirv",
    "warship-build",
    "attack",
    "warship-counter",
    "nuke",
  ],
  "a successful plateau City skips only the later structures phase",
);
assert.equal(plateauCity.structureAttempts, 1, "the plateau City is the only structure action");

assert.deepEqual(
  (await runDecisionChain({})).calls,
  [
    "emoji",
    "urgent-check",
    "peace-window-sam",
    "plateau-city",
    "mirv",
    "warship-build",
    "structures",
    "ordinary-structure",
    "attack",
    "warship-counter",
    "nuke",
  ],
  "ordinary structures still run when no early safety or plateau lane claims the action",
);

process.stdout.write("legendary economy action-cycle tests passed\n");
