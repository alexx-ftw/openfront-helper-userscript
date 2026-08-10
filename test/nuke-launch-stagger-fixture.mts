import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { NukeExecution } from "../openfront-engine/src/core/execution/NukeExecution";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";

const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const game = await setup(
  "big_plains",
  { infiniteGold: true, instantBuild: true },
  [new PlayerInfo("attacker", PlayerType.Human, null, "attacker")],
  engineTestsUtil,
);
const attacker = game.player("attacker");
const source = game.ref(1, 1);
const target = game.ref(80, 1);
attacker.conquer(source);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
silo.increaseLevel();
silo.reloadMissile();

game.addExecution(new NukeExecution(UnitType.AtomBomb, attacker, target, null, 1));
game.addExecution(new NukeExecution(UnitType.AtomBomb, attacker, target, null, 1));
game.executeNextTick();
game.executeNextTick();

const missiles = attacker.units(UnitType.AtomBomb);
assert.equal(missiles.length, 2);
assert.deepEqual(
  silo.missileTimerQueue(),
  [game.ticks() - 1, game.ticks() - 1],
  "both level-two silo slots are claimed on the same engine tick",
);

const progress: Array<[number, number]> = [];
for (let index = 0; index < 8; index++) {
  game.executeNextTick();
  progress.push([missiles[0].trajectoryIndex(), missiles[1].trajectoryIndex()]);
}
const firstAdvance = progress.findIndex(([first]) => first > 0);
const secondAdvance = progress.findIndex(([, second]) => second > 0);
assert.ok(firstAdvance >= 0, "the first missile advances");
assert.equal(
  secondAdvance,
  firstAdvance + 1,
  "the second same-silo missile starts exactly one engine tick later",
);

console.log("nuke same-silo launch-stagger fixture passed");
