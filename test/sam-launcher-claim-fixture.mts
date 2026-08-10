import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";

const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const game = await setup(
  "big_plains",
  { infiniteGold: true, instantBuild: true },
  [],
  engineTestsUtil,
);

game.addPlayer(new PlayerInfo("defender", PlayerType.Human, null, "defender"));
game.addPlayer(new PlayerInfo("attacker", PlayerType.Human, null, "attacker"));

const defender = game.player("defender");
const attacker = game.player("attacker");

// Execution order matters: SAM-B can reach both missiles and claims first.
const samB = defender.buildUnit(UnitType.SAMLauncher, game.ref(50, 1), {});
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

console.log("SAM launcher claim-order fixture passed");
