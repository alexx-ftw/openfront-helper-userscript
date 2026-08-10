import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { WarshipExecution } from "../openfront-engine/src/core/execution/WarshipExecution";
import { MoveWarshipExecution } from "../openfront-engine/src/core/execution/MoveWarshipExecution";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const game = await setup(
  "half_land_half_ocean",
  { infiniteGold: true, instantBuild: true },
  [
    new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
  ],
  engineTestsUtil,
);

const defender = game.player("defender");
const attacker = game.player("attacker");
game.config().warshipTargettingRange = () => 130;
game.config().warshipShellAttackRate = () => Number.MAX_SAFE_INTEGER;

const leftTile = game.ref(8, 2);
const rightTile = game.ref(8, 6);
const nearTile = game.ref(8, 8);
const farTile = game.ref(8, 14);
const leftWarship = defender.buildUnit(UnitType.Warship, leftTile, {
  patrolTile: leftTile,
});
const rightWarship = defender.buildUnit(UnitType.Warship, rightTile, {
  patrolTile: rightTile,
});
const nearTransport = attacker.buildUnit(UnitType.TransportShip, nearTile, {
  targetTile: nearTile,
});
const farTransport = attacker.buildUnit(UnitType.TransportShip, farTile, {
  targetTile: farTile,
});
game.addExecution(new WarshipExecution(leftWarship));
game.addExecution(new WarshipExecution(rightWarship));

game.executeNextTick();
game.executeNextTick();

assert.equal(leftWarship.targetUnit()?.id(), nearTransport.id());
assert.equal(rightWarship.targetUnit()?.id(), nearTransport.id());
assert.notEqual(rightWarship.targetUnit()?.id(), farTransport.id());

const sandbox: Record<string, unknown> = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  `${fs.readFileSync(
    path.join(repoRoot, "engine/ingame/auto-bot/naval-interception.js"),
    "utf8",
  )}\nglobalThis.planNavalInterceptions = planNavalInterceptions;`,
  sandbox,
  { filename: "warship-target-selection-fixture.js" },
);
const planNavalInterceptions = sandbox.planNavalInterceptions as (options: unknown) => {
  coveredIds: string[];
  uncoveredIds: string[];
};
const plan = planNavalInterceptions({
  ships: [
    { id: leftWarship.id(), tile: leftTile },
    { id: rightWarship.id(), tile: rightTile },
  ],
  invasions: [
    { id: nearTransport.id(), path: [nearTile, nearTile] },
    { id: farTransport.id(), path: [farTile, farTile] },
  ],
  route: (from: number) => [from],
  distance: (from: number, to: number) => Math.sqrt(game.euclideanDistSquared(from, to)),
  targetDistanceSquared: (from: number, to: number) => game.euclideanDistSquared(from, to),
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: game.config().warshipTargettingRange(),
});

assert.deepEqual(plan.coveredIds, [nearTransport.id()]);
assert.deepEqual(plan.uncoveredIds, [farTransport.id()]);

const delayedPlan = planNavalInterceptions({
  ships: [{ id: leftWarship.id(), tile: leftTile, time: 1 }],
  invasions: [{ id: nearTransport.id(), path: [nearTile, nearTile] }],
  route: (from: number) => [from],
  distance: (from: number, to: number) => Math.sqrt(game.euclideanDistSquared(from, to)),
  targetDistanceSquared: (from: number, to: number) => game.euclideanDistSquared(from, to),
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: game.config().warshipTargettingRange(),
});
assert.deepEqual(
  delayedPlan.uncoveredIds,
  [nearTransport.id()],
  "the planner preserves a real warship's busy tick instead of restarting its timeline",
);

const patrolGame = await setup(
  "half_land_half_ocean",
  { infiniteGold: true, instantBuild: true },
  [new PlayerInfo("patrol", PlayerType.Human, null, "patrol")],
  engineTestsUtil,
);
const patrolPlayer = patrolGame.player("patrol");
const patrolStart = patrolGame.ref(8, 2);
const requestedAnchor = patrolGame.ref(8, 8);
const patrolWarship = patrolPlayer.buildUnit(UnitType.Warship, patrolStart, {
  patrolTile: patrolStart,
});
patrolGame.addExecution(
  new MoveWarshipExecution(patrolPlayer, [patrolWarship.id()], requestedAnchor),
);
patrolGame.addExecution(new WarshipExecution(patrolWarship));
patrolGame.executeNextTick();

assert.equal(patrolWarship.warshipState().patrolTile, requestedAnchor);
assert.notEqual(
  patrolWarship.targetTile(),
  requestedAnchor,
  "MoveWarshipExecution sets a patrol anchor while WarshipExecution chooses the actual movement target",
);

console.log("warship target-selection engine fixture passed");
