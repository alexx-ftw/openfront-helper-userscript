// Win pacing v2 (commerce stall): on dominant Team+Legendary rows the win
// itself ends the game before the trade-capture metric completes. V2 scope:
// Terra Nullius expansion stays authorized while armed, and the under-attack
// failsafe only locks the stall off for MATERIAL incoming pressure (largest
// single-attacker wave >= 0.5x our army), not for any skirmish.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");

const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const sandbox = {
  UNIT: { TradeShip: "TradeShip", Warship: "Warship" },
  Difficulty,
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  GameMode: { FFA: "FFA", Team: "Team" },
  currentDifficulty: () => Difficulty.Legendary,
  state: { settings: { winFixes: true }, stats: {} },
};
executeClassicScript(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
  filename: sourcePath,
});
assert.equal(typeof sandbox.AttackBehavior, "function");

function freshState() {
  return {
    settings: { winFixes: true },
    winPacingAtTick: null,
    winPacingActive: false,
    winPacingArmedTick: null,
    winPacingLockedOff: false,
  };
}

function makeTeamPlayer(smallID, teamID, tiles) {
  return {
    isPlayer: () => true,
    smallID: () => smallID,
    team: () => teamID,
    numTilesOwned: () => tiles,
  };
}

function makeBehavior({ ownTiles, rivalTiles, ownTroops, incoming, tick }) {
  const behavior = Object.create(sandbox.AttackBehavior.prototype);
  const me = {
    isPlayer: () => true,
    smallID: () => 1,
    type: () => "Human",
    team: () => ({ smallID: () => 10, id: 10 }),
    numTilesOwned: () => ownTiles,
    troops: () => ownTroops,
    units: () => [],
  };
  const rival = makeTeamPlayer(2, 20, rivalTiles);
  const incomingAttacks = (incoming || []).map((troops) => ({
    attacker: () => rival,
    troops: () => troops,
  }));
  behavior.game = {
    ticks: () => tick,
    players: () => [me, rival],
    units: () => new Array(25).fill({}),
    config: () => ({ gameConfig: () => ({ gameMode: "Team" }) }),
  };
  behavior.player = me;
  behavior.incomingHostileAttacks = () => incomingAttacks;
  behavior.getOutboundAttackTargetKey = () => rival;
  behavior.getLiveOutboundAttackTroopsForTarget = () => 0;
  behavior.getPendingOutboundAttackTroopsForTarget = () => 0;
  behavior.estimatedOwnCommerceCaptures = () => 0;
  Object.assign(sandbox.state, freshState());
  return { behavior, rival };
}

// 1. Armed stall spares a fresh conquest of a rival player.
{
  const { behavior, rival } = makeBehavior({
    ownTiles: 6200,
    rivalTiles: 2000,
    ownTroops: 1_000_000,
    incoming: [10_000],
    tick: 6_000,
  });
  assert.equal(
    behavior.winPacingSparesConquest({ target: rival }),
    true,
    "dominant team row should spare rival conquest",
  );
}

// 2. Terra Nullius expansion stays authorized while armed.
{
  const { behavior } = makeBehavior({
    ownTiles: 6200,
    rivalTiles: 2000,
    ownTroops: 1_000_000,
    incoming: [10_000],
    tick: 6_000,
  });
  const terraNullius = { isPlayer: () => false, tiles: () => 0 };
  assert.equal(
    behavior.winPacingSparesConquest({ target: terraNullius }),
    false,
    "Terra Nullius target must never be spared",
  );
}

// 3. Small skirmishes do not disarm the stall.
{
  const { behavior } = makeBehavior({
    ownTiles: 6200,
    rivalTiles: 2000,
    ownTroops: 1_000_000,
    incoming: [5_000, 40_000],
    tick: 6_000,
  });
  assert.equal(
    behavior.winPacingThrottleActive(),
    true,
    "raid below 0.5x army must not lock the stall off",
  );
  assert.equal(sandbox.state.winPacingLockedOff, false);
}

// 4. MATERIAL pressure (>= 0.5x army from one attacker) locks the stall off
//    permanently.
{
  const { behavior } = makeBehavior({
    ownTiles: 6200,
    rivalTiles: 2000,
    ownTroops: 1_000_000,
    incoming: [400_000, 150_000],
    tick: 6_000,
  });
  assert.equal(behavior.winPacingThrottleActive(), false);
  assert.equal(
    sandbox.state.winPacingLockedOff,
    true,
    "material wave must permanently lock the stall off",
  );
  assert.equal(behavior.winPacingThrottleActive(), false);
}

// 5. Arming requires clear dominance (share >= 0.60, margin >= 0.20).
{
  const { behavior } = makeBehavior({
    ownTiles: 5800,
    rivalTiles: 3900,
    ownTroops: 1_000_000,
    incoming: [],
    tick: 6_000,
  });
  assert.equal(behavior.winPacingThrottleActive(), false, "0.598 share must not arm");
}

// 6. Team mode only: FFA never arms.
{
  const { behavior } = makeBehavior({
    ownTiles: 6200,
    rivalTiles: 2000,
    ownTroops: 1_000_000,
    incoming: [],
    tick: 6_000,
  });
  behavior.game.config = () => ({ gameConfig: () => ({ gameMode: "FFA" }) });
  assert.equal(behavior.winPacingThrottleActive(), false, "FFA must stay untouched");
}

// 7. Window: the stall extends at most 6000 ticks, then stands down for good.
{
  let tick = 6_000;
  const rivalTiles = 2000;
  const { behavior } = makeBehavior({
    ownTiles: 6200,
    rivalTiles,
    ownTroops: 1_000_000,
    incoming: [],
    tick,
  });
  behavior.game.ticks = () => tick;
  behavior.game.players = () => [behavior.player, makeTeamPlayer(2, 20, rivalTiles)];
  assert.equal(behavior.winPacingThrottleActive(), true);
  tick = 11_000;
  assert.equal(behavior.winPacingThrottleActive(), true, "armed stall holds through +5000");
  tick = 12_100;
  assert.equal(behavior.winPacingThrottleActive(), false, "stall must expire after 6000 ticks");
  assert.equal(sandbox.state.winPacingLockedOff, true);
}

// 8. Dominance decay below 0.60/0.30 while armed releases permanently.
{
  let rivalTiles = 2000;
  let tick = 6_000;
  const { behavior } = makeBehavior({
    ownTiles: 6200,
    rivalTiles,
    ownTroops: 1_000_000,
    incoming: [],
    tick,
  });
  behavior.game.ticks = () => tick;
  behavior.game.players = () => [behavior.player, makeTeamPlayer(2, 20, rivalTiles)];
  assert.equal(behavior.winPacingThrottleActive(), true);
  rivalTiles = 4600;
  tick = 7_000;
  assert.equal(behavior.winPacingThrottleActive(), false, "dominance decay must release the stall");
  assert.equal(sandbox.state.winPacingLockedOff, true);
}

process.stdout.write("win-pacing-v2: all assertions passed\n");
