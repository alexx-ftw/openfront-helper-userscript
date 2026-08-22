// Protector appeasement (FFA survival): courting the strongest bordering
// nation into an alliance makes its land AND boat attacks engine-rejected.
// Tests the gating, protector selection, throttled courtship, embargo
// exemption and the ordinary-attack filter wiring.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/allianceBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");
const attackSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js"),
  "utf8",
);
const nationSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/nationExecution.js"),
  "utf8",
);

const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
let testDifficulty = Difficulty.Legendary;
const state = { settings: { winFixes: true }, stats: {} };
const sentRequests = [];
const sandbox = {
  Difficulty,
  GameMode: { FFA: "FFA", Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation", Tribe: "Tribe" },
  UNIT: { Warship: "Warship", TransportShip: "TransportShip" },
  Relation: { Hostile: -1, Neutral: 0, Friendly: 1 },
  state,
  currentDifficulty: () => testDifficulty,
  isAtLeastHardDifficulty: (d) =>
    d === Difficulty.Hard || d === Difficulty.Impossible || d === Difficulty.Legendary,
  tr: (_key, params) => `tr:${params?.name ?? ""}`,
  setLastAction: () => {},
  runtimeDebugLog: () => {},
  safeName: (p) => String(p?.name?.() ?? "player"),
  performance: { now: () => 10_000 },
  getEventBus: () => ({}),
  discoverCtors: () => ({
    allianceRequest: (from, to) => {
      sentRequests.push({ from, to });
      return { from, to };
    },
  }),
  emitIntent: (payload) => {
    sentRequests.push(payload);
    return true;
  },
};
executeClassicScript(`${source}\nglobalThis.__AllianceBehavior = AllianceBehavior;`, sandbox, {
  filename: sourcePath,
});
assert.equal(typeof sandbox.__AllianceBehavior, "function");

const makePlayer = ({ sid, type = "Nation", alive = true, maxTroops }) => ({
  isPlayer: () => true,
  smallID: () => sid,
  type: () => type,
  isAlive: () => alive,
  troops: () => Math.round(maxTroops / 2),
  maxTroops: () => maxTroops,
});
const makeBehavior = ({ mode = "FFA", nearby = [], dominant = false, friendlySids = [] }) => {
  const behavior = Object.create(sandbox.__AllianceBehavior.prototype);
  const me = makePlayer({ sid: 1, type: "Human", maxTroops: 100_000 });
  behavior.player = me;
  me.isFriendly = (other) => friendlySids.includes(other.smallID());
  me.nearby = () => nearby;
  behavior.game = {
    ticks: () => 1000,
    config: () => ({
      disableAlliances: () => false,
      gameConfig: () => ({ gameMode: mode }),
    }),
  };
  behavior.isDominantForDiplomacy = () => dominant;
  behavior.emojiBehavior = { sendEmoji: () => {} };
  behavior.random = { chance: () => true, nextInt: () => 50, randElement: (xs) => xs[0] };
  return behavior;
};

// 1. Gating: FFA + Legendary + winFixes + alliances enabled.
{
  const strong = makePlayer({ sid: 2, maxTroops: 1_000_000 });
  assert.equal(
    makeBehavior({ nearby: [strong] }).protectorAppeasementActive(),
    true,
    "FFA Legendary with alliances on activates appeasement",
  );
  testDifficulty = Difficulty.Impossible;
  assert.equal(
    makeBehavior({ nearby: [strong] }).protectorAppeasementActive(),
    false,
    "non-Legendary difficulty never activates appeasement",
  );
  testDifficulty = Difficulty.Legendary;
  assert.equal(
    makeBehavior({ mode: "Team", nearby: [strong] }).protectorAppeasementActive(),
    false,
    "Team mode has real allies — appeasement is FFA-only",
  );
  state.settings.winFixes = false;
  assert.equal(
    makeBehavior({ nearby: [strong] }).protectorAppeasementActive(),
    false,
    "winFixes off deactivates appeasement",
  );
  state.settings.winFixes = true;
}

// 2. Protector selection: the strongest nearby Nation at >=1.25x our
// strength; weaker neighbours, bots, friendly nations and the dead are not
// protectors.
{
  const weakerNation = makePlayer({ sid: 3, maxTroops: 120_000 });
  const bot = makePlayer({ sid: 4, type: "Bot", maxTroops: 5_000_000 });
  const dead = makePlayer({ sid: 6, maxTroops: 3_000_000, alive: false });
  const strong = makePlayer({ sid: 2, maxTroops: 1_000_000 });
  const behavior = makeBehavior({
    nearby: [weakerNation, bot, dead, strong, makePlayer({ sid: 5, maxTroops: 2_000_000 })],
    friendlySids: [5],
  });
  assert.equal(
    behavior.appeasementProtector()?.smallID(),
    2,
    "the strongest live, non-friendly, materially stronger bordering Nation is the protector",
  );
  assert.equal(
    makeBehavior({ nearby: [weakerNation] }).appeasementProtector(),
    null,
    "a nation we already outmuscle is a conquest target, not a protector",
  );
  assert.equal(
    makeBehavior({ nearby: [] }).appeasementProtector(),
    null,
    "no neighbours means no protector",
  );
}

// 3. Courtship: throttled allianceRequest emission toward the protector;
// never while dominant.
{
  const strong = makePlayer({ sid: 2, maxTroops: 1_000_000 });
  const behavior = makeBehavior({ nearby: [strong] });
  sentRequests.length = 0;
  state.lastProtectorCourtMs = 0;
  behavior.maybeCourtProtectors();
  assert.equal(sentRequests.length, 1, "the protector is courted with an alliance request");
  behavior.maybeCourtProtectors();
  assert.equal(
    sentRequests.length,
    1,
    "the throttle prevents request spam (engine cooldown is 300 ticks)",
  );
  const dominant = makeBehavior({ nearby: [strong], dominant: true });
  state.lastProtectorCourtMs = 0;
  dominant.maybeCourtProtectors();
  assert.equal(
    sentRequests.length,
    1,
    "a dominant bot stops courting (the alliance is now in the way)",
  );
}

// 4. Wiring: the ordinary-attack path filters the protector; the embargo
// handler exempts it.
{
  assert.match(
    attackSource,
    /appeasementFilteredEnemies\(context\.borderingEnemies\)/,
    "ordinary target selection routes through the appeasement filter",
  );
  assert.match(
    attackSource,
    /appeasementFilteredEnemies\(borderingEnemies\)[\s\S]{0,400}filtered\.length > 0 \? filtered : borderingEnemies/,
    "the filter never empties the target list (it excludes, not blocks)",
  );
  assert.match(
    nationSource,
    /protectorEmbargoExemption\(other, embargoed\)/,
    "the embargo handler exempts the protector",
  );
  assert.match(
    nationSource,
    /maybeCourtProtectors\?\.\(\)/,
    "the diplomacy tick courts protectors",
  );
}

// 5. Embargo exemption behavior on the NationBot prototype.
{
  const nationSandbox = {
    Difficulty,
    PseudoRandom: class {},
    simpleHash: () => 0,
    Relation: sandbox.Relation,
    GameMode: sandbox.GameMode,
    PlayerType: sandbox.PlayerType,
    state,
    currentDifficulty: () => testDifficulty,
    isAtLeastHardDifficulty: sandbox.isAtLeastHardDifficulty,
    getEventBus: sandbox.getEventBus,
    discoverCtors: () => ({}),
    getIntentRateLimitSnapshot: () => null,
  };
  executeClassicScript(`${nationSource}\nglobalThis.__TestNationBot = NationBot;`, nationSandbox, {
    filename: "nationExecution-appeasement.js",
  });
  const bot = Object.create(nationSandbox.__TestNationBot.prototype);
  let stopped = 0;
  bot.stopEmbargo = () => {
    stopped += 1;
    return true;
  };
  bot.allianceBehavior = { appeasementProtector: () => ({ smallID: () => 42 }) };
  const protector = { smallID: () => 42 };
  const stranger = { smallID: () => 7 };
  assert.equal(
    bot.protectorEmbargoExemption(protector, true),
    true,
    "an existing embargo on the protector is repaired (stopped), not added",
  );
  assert.equal(stopped, 1, "the poisoned embargo is actively rolled back");
  assert.equal(
    bot.protectorEmbargoExemption(protector, false),
    true,
    "a not-yet-embargoed protector is exempt going forward",
  );
  assert.equal(
    bot.protectorEmbargoExemption(stranger, false),
    false,
    "other nations keep the ordinary embargo semantics",
  );
}

process.stdout.write("protector appeasement tests passed\n");
