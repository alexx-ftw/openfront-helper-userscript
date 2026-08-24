import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";

const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const game = await setup(
  "big_plains",
  { infiniteGold: false, instantBuild: true },
  [],
  engineTestsUtil,
);

game.addPlayer(new PlayerInfo("defender", PlayerType.Human, null, "defender"));
game.addPlayer(new PlayerInfo("attacker", PlayerType.Human, null, "attacker"));

const defender = game.player("defender");
const attacker = game.player("attacker");

assert.equal(
  game.unitInfo(UnitType.SAMLauncher).cost(game, defender),
  1_500_000n,
  "the first SAM uses the engine's authoritative base cost",
);

// Execution order matters: SAM-B can reach both missiles and claims first.
// This is the live-engine counterpart of Legendary's engine-order-conflict
// schedule: a flexible launcher can consume a shared target before the
// constrained launcher runs, leaving the exclusive target uncovered.
const samB = defender.buildUnit(UnitType.SAMLauncher, game.ref(50, 1), {});
assert.equal(
  game.unitInfo(UnitType.SAMLauncher).cost(game, defender),
  3_000_000n,
  "the second SAM costs 3M in the live engine rather than the bot's perceived 3.9M",
);
const samA = defender.buildUnit(UnitType.SAMLauncher, game.ref(1, 1), {});
game.addExecution(new SAMLauncherExecution(defender, null, samB));
game.addExecution(new SAMLauncherExecution(defender, null, samA));

const missileA = attacker.buildUnit(UnitType.AtomBomb, game.ref(1, 1), {
  targetTile: game.ref(50, 1),
  trajectory: [1, 10, 20, 30, 40, 50].map((x) => ({
    tile: game.ref(x, 1),
    targetable: true,
  })),
});
const missileB = attacker.buildUnit(UnitType.AtomBomb, game.ref(199, 1), {
  targetTile: game.ref(199, 1),
  trajectory: [199, 170, 140, 110, 100, 110, 140, 170, 199].map((x) => ({
    tile: game.ref(x, 1),
    targetable: true,
  })),
});

game.executeNextTick();
game.executeNextTick();

assert.deepEqual(samB.missileTimerQueue(), [1]);
assert.deepEqual(samA.missileTimerQueue(), []);
assert.equal(missileA.targetedBySAM(), true);
assert.equal(missileB.targetedBySAM(), false);

game.executeNextTick();
game.executeNextTick();

assert.equal(missileA.isActive(), false);
assert.equal(missileA.wasDestroyedByEnemy(), true);
assert.equal(missileB.isActive(), true);

const timingGame = await setup(
  "big_plains",
  { infiniteGold: true, instantBuild: true },
  [
    new PlayerInfo("timing-defender", PlayerType.Human, null, "timing-defender"),
    new PlayerInfo("timing-attacker", PlayerType.Human, null, "timing-attacker"),
  ],
  engineTestsUtil,
);
timingGame.config().defaultSamMissileSpeed = () => 2;
timingGame.config().samRange = () => 5;
timingGame.config().maxSamRange = () => 5;

const timingDefender = timingGame.player("timing-defender");
const timingAttacker = timingGame.player("timing-attacker");
const timingSam = timingDefender.buildUnit(UnitType.SAMLauncher, timingGame.ref(10, 1), {});
timingGame.addExecution(new SAMLauncherExecution(timingDefender, null, timingSam));
const lateNuke = timingAttacker.buildUnit(UnitType.AtomBomb, timingGame.ref(0, 1), {
  targetTile: timingGame.ref(7, 1),
  trajectory: [0, 6, 7].map((x) => ({
    tile: timingGame.ref(x, 1),
    targetable: true,
  })),
});

timingGame.executeNextTick();
timingGame.executeNextTick();

assert.deepEqual(
  timingSam.missileTimerQueue(),
  [],
  "the engine does not launch a SAM that cannot reach the final in-flight tile in time",
);
assert.equal(lateNuke.targetedBySAM(), false);

console.log("SAM launcher claim-order fixture passed");
