import assert from "node:assert/strict";
import { NukeExecution } from "../openfront-engine/src/core/execution/NukeExecution";
import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { Difficulty, UnitType } from "../openfront-engine/src/core/game/Game";
import { unpackMotionPlans } from "../openfront-engine/src/core/game/MotionPlans";
import { setupTwoPlayerGame } from "./helpers/two-player-game.mts";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";
import { readNukeBehaviorSource } from "./helpers/nuke-behavior-source.mjs";
import { readStructureBehaviorSource } from "./helpers/structure-behavior-source.mjs";

const game = await setupTwoPlayerGame("big_plains");
const attacker = game.player("attacker");
const defender = game.player("defender");
const source = game.ref(1, 1);
const target = game.ref(80, 1);
attacker.conquer(source);
defender.conquer(target);
attacker.buildUnit(UnitType.MissileSilo, source, {});
const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
game.addExecution(new SAMLauncherExecution(defender, null, sam));
game.addExecution(new NukeExecution(UnitType.AtomBomb, attacker, target, null, 1));
game.executeNextTick();
game.executeNextTick();
const plans = new Map(
  unpackMotionPlans(game.drainPackedMotionPlans()!).flatMap((plan) =>
    plan.kind === "grid" ? [[plan.unitId, plan] as const] : [],
  ),
);
const view = Object.assign(Object.create(game), { motionPlans: () => plans });
const sources = [
  readRepositoryFile("engine/ingame/shared-utils.js"),
  readLegendaryPlannerSource(),
  readStructureBehaviorSource(),
  readNukeBehaviorSource(),
];
const behavior = executeClassicScript(
  `${sources.join("\n")}
  const behavior = Object.create(NukeBehavior.prototype);
  behavior.structureBehavior = Object.create(StructureBehavior.prototype);
  behavior;`,
  { UNIT: UnitType, Difficulty },
);
behavior.game = view;
behavior.player = attacker;
behavior.structureBehavior.game = view;
const pending = { salvo: { targetTile: target, targetSamId: sam.id() }, targetPlayer: defender };
const missile = attacker.units(UnitType.AtomBomb)[0];
const arrival = plans.get(missile.id())!.startTick + plans.get(missile.id())!.path.length + 5;
assert.equal(sam.missileTimerQueue().length, 0);
assert.equal(behavior.samSalvoLiveCapacitySpend(target, [sam], arrival), 1);
assert.equal(
  behavior.samSalvoStillViable(pending, 1, arrival),
  true,
  "the already-launched Atom supports the queued finisher before the SAM fires",
);
while (game.units(UnitType.SAMMissile).length === 0 && game.ticks() < arrival)
  game.executeNextTick();
assert.equal(game.units(UnitType.SAMMissile)[0]?.targetUnit()?.id(), missile.id());
assert.equal(sam.missileTimerQueue().length, 1);
assert.equal(
  behavior.samSalvoLiveCapacitySpend(target, [sam], arrival),
  0,
  "the same missile is not credited again after the real SAM claims it",
);
assert.equal(behavior.samSalvoStillViable(pending, 1, arrival), true);
console.log("live-engine SAM-salvo capacity fixture passed");
