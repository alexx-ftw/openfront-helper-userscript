import assert from "node:assert/strict";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";

const contextSource = readRepositoryFile("engine/ingame/auto-bot/context.js");
const nationSource = readRepositoryFile("engine/ingame/auto-bot/nationExecution.js");
const engineSource = readRepositoryFile("engine/ingame/auto-bot/engine.js");
const emitted = [];
const built = [];
const packets = [];
const player = {
  id: () => "local",
  gold: () => 100n,
  isPlayer: () => true,
  troops: () => 50,
  numTilesOwned: () => 1,
};
const game = { myPlayer: () => player, ticks: () => 42 };
const srcGame = { myPlayer: () => player };
const buildMenu = {
  eventBus: { emit: (event) => emitted.push(event) },
  sendBuildOrUpgrade: (...args) => built.push(args),
};
const state = {
  settings: { enabled: true },
  tickTimer: 1,
  tickInFlight: false,
  tickGeneration: 0,
};
const sandbox = {
  state,
  runtimeState: { lastOpenFrontGameContext: { game: srcGame } },
  window: { clearInterval() {}, __OFH_hybridStrategy: null },
  document: {
    querySelector: (selector) => (selector === "build-menu" ? buildMenu : null),
  },
  AttackBehavior: class {
    constructor(sendPacket) {
      this.sendPacket = sendPacket;
    }

    emitDonationTroops() {
      return this.sendPacket({ type: "donate_troops" });
    }
  },
  sendGamePacket: (packet) => {
    packets.push(packet);
    return true;
  },
  hasIntentRateLimitCapacity: () => true,
  tryAcquireIntentRateLimit: () => true,
  autoBotProfileAsyncPhase: async (_profile, _name, action) => action(),
  autoBotProfileSyncPhase: (_profile, _name, action) => action(),
  beginAutoBotProfileTick: () => null,
  autoBotProfileStartPhase: () => 0,
  autoBotProfileEndPhase() {},
  finishAutoBotProfileTick() {},
  updateSpeedFactor() {},
  renderStatus() {},
  setStatus() {},
  toNum: (value) => Number(value ?? 0),
  safeMaxTroops: () => 100,
  tr: (value) => value,
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${contextSource}\n${nationSource}\n${engineSource}\nglobalThis.__testApi = {
    NationBot,
    botTick,
    stopEngine,
    setRuntime(api, srcGame, bot, seedKey) {
      _api = api;
      _apiSrc = srcGame;
      _bot = bot;
      _botSeedKey = seedKey;
    },
    sendAutoBotBuildOrUpgrade,
    emitIntent,
  };`,
  sandbox,
  { filename: repositoryFilePath("engine/ingame/auto-bot/engine.js") },
);

class TestIntent {
  constructor(...args) {
    this.args = args;
  }
}

const probeStarted = new Promise((resolve) => {
  sandbox.signalProbeStarted = resolve;
});
let resumeProbe;
const suspendedProbe = new Promise((resolve) => {
  resumeProbe = resolve;
});
const attempts = {};
let attackPhases = 0;
let nukePhases = 0;
const bot = Object.create(sandbox.__testApi.NationBot.prototype);
bot.tick = (_ticks, profile, generation) => bot.runDecisionChain(profile, generation);
bot.feat = (feature) => ["build", "expand", "nuke"].includes(feature);
bot.emojiBehavior = { maybeSendCasualEmoji() {} };
bot.runDiplomacy = () => {};
bot.structureBehavior = {
  maybeSpawnPlateauCity: async () => {},
  async handleStructures() {
    sandbox.signalProbeStarted();
    await suspendedProbe;
    const buildable = { type: "City", cost: 5n, canBuild: true };
    attempts.build = sandbox.__testApi.sendAutoBotBuildOrUpgrade(
      buildMenu,
      buildable,
      7,
      game,
      player,
    );
    attempts.intent = sandbox.__testApi.emitIntent(TestIntent, "stale attack");
    attempts.fallback = new sandbox.AttackBehavior(sandbox.sendGamePacket).emitDonationTroops();
  },
};
bot.mirvBehavior = { considerMIRV: async () => {} };
bot.attackBehavior = {
  maybeAttack: () => {
    attackPhases++;
  },
};
bot.nukeBehavior = {
  maybeSendNuke: () => {
    nukePhases++;
  },
};
bot.status = "";

const api = { game, beginTick: async () => {} };
sandbox.__testApi.setRuntime(api, srcGame, bot, "local");
const tick = sandbox.__testApi.botTick();
await probeStarted;
assert.equal(state.activeTickGeneration, 0, "the engine marks the in-flight tick generation");
sandbox.__testApi.stopEngine();
resumeProbe();
await tick;

assert.deepEqual(attempts, { build: false, intent: false, fallback: false });
assert.equal(built.length, 0, "a build probe resumed after stop cannot dispatch a build");
assert.equal(emitted.length, 0, "a stale intent cannot reach the event bus");
assert.equal(packets.length, 0, "the direct donation fallback is also gated");
assert.equal(attackPhases, 0, "a stale structures phase cannot continue into attack");
assert.equal(nukePhases, 0, "a stale decision chain cannot continue into nuke");
assert.equal(
  state.activeTickGeneration,
  null,
  "the active generation clears when the tick settles",
);

const manualBuildable = { type: "City", cost: 5n, canBuild: true };
assert.equal(
  sandbox.__testApi.sendAutoBotBuildOrUpgrade(buildMenu, manualBuildable, 8, game, player),
  true,
  "a direct behavior call without an active tick generation can still build",
);
assert.equal(sandbox.__testApi.emitIntent(TestIntent, "manual"), true);
assert.equal(
  new sandbox.AttackBehavior(sandbox.sendGamePacket).emitDonationTroops(),
  true,
  "a direct donation behavior call without an active generation remains available",
);
assert.equal(built.length, 1);
assert.equal(emitted.length, 1);
assert.equal(packets.length, 1);

process.stdout.write("auto-bot stop-generation tests passed\n");
