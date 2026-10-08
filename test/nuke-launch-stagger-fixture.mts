import assert from "node:assert/strict";

import { NukeExecution } from "../openfront-engine/src/core/execution/NukeExecution";
import { UniversalPathFinding } from "../openfront-engine/src/core/pathfinding/PathFinder";
import { Difficulty, UnitType } from "../openfront-engine/src/core/game/Game";
import { engineTestsUtil, setupTwoPlayerGame } from "./helpers/two-player-game.mts";
import { PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import {
  unpackMotionPlans,
  type GridPathPlan,
} from "../openfront-engine/src/core/game/MotionPlans";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

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
attacker.addGold(100_000_000n);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
silo.increaseLevel();
silo.reloadMissile();
silo.increaseLevel();
silo.reloadMissile();

game.addExecution(new NukeExecution(UnitType.AtomBomb, attacker, target, null, 1));
game.addExecution(new NukeExecution(UnitType.AtomBomb, attacker, target, null, 1));
game.executeNextTick();
game.executeNextTick();

const missiles = attacker.units(UnitType.AtomBomb);
assert.equal(missiles.length, 2);
const packedMotionPlans = game.drainPackedMotionPlans()!;
const plans = new Map(
  unpackMotionPlans(packedMotionPlans).flatMap((plan) =>
    plan.kind === "grid" ? [[plan.unitId, plan] as const] : [],
  ),
);
const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
bot.attach({ runner: { game }, clientID: "attacker" });
assert.ok(bot.api.game.motionPlans() instanceof Map, "headless exposes the client motion-plan API");
bot.applyGameUpdate({ packedMotionPlans });
for (const missile of missiles) {
  assert.deepEqual(
    bot.api.game.motionPlans().get(missile.id()).path,
    plans.get(missile.id())!.path,
  );
}
const defense = executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js")}\nObject.create(StructureBehavior.prototype);`,
  { Difficulty, UNIT: UnitType },
);
defense.game = {
  ticks: () => game.ticks(),
  motionPlans: () => plans,
  config: () => game.config(),
  manhattanDist: (a, b) => game.manhattanDist(a, b),
};
const predictedImpacts = missiles.map(
  (missile) =>
    game.ticks() + defense.legendaryActiveMissileMotion(missile, missile.tile()).impactTick,
);
assert.deepEqual(
  silo.missileTimerQueue(),
  [game.ticks() - 1, game.ticks() - 1],
  "two of the three silo slots are claimed on the same engine tick",
);
assert.equal(
  attacker.canBuild(UnitType.HydrogenBomb, target),
  source,
  "the third slot can launch a finisher while both Atoms are still flying",
);
const finisherState = { postSalvoHydrogen: { targetTile: target, dueTick: game.ticks() } };
const view = Object.assign(Object.create(game), { motionPlans: () => plans });
const nuke = executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/nukeBehavior.js")}\nObject.create(NukeBehavior.prototype);`,
  { UNIT: UnitType, Difficulty, state: finisherState },
);
Object.assign(nuke, {
  game: view,
  player: attacker,
  structureBehavior: defense,
  _pendingNukeLaunches: [],
  postSalvoHydrogenTarget: () => ({}),
  // The stagger scenario nukes unclaimed land, so the finisher's enemy-value
  // gate would hold it; this fixture tests stagger mechanics, not gate
  // economics (covered by nuke-finisher-friendly-gate-fixture).
  blastStructureValue: () => 10_000_000,
  getPerceivedNukeCost: async () => 1n,
  findEnemySamsCoveringTile: () => [],
  sendNuke: async () => true,
});
assert.equal(
  await nuke.maybeFirePostSalvoHydrogen(),
  false,
  "an expired estimate cannot release the finisher while native Atoms remain in flight",
);
assert.equal(
  finisherState.postSalvoHydrogen.dueTick,
  Math.max(...predictedImpacts) + 5,
  "the real same-silo wait extends the finisher deadline from native motion plans",
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

const impacts = new Map<number, number>();
let finalWindows = 0;
const lastPlanTick = Math.max(...Array.from(plans.values(), (p) => p.startTick + p.path.length));
while (impacts.size < missiles.length && game.ticks() <= lastPlanTick) {
  for (const missile of missiles) {
    const plan = plans.get(missile.id())!;
    if (game.ticks() !== plan.startTick + plan.path.length - 1) continue;
    assert.equal(missile.isActive(), true);
    assert.equal(missile.isTargetable(), true);
    const motion = defense.legendaryActiveMissileMotion(missile, missile.tile());
    const opportunities = defense.legendarySamInterceptionOpportunities(
      { tile: missile.tile() },
      [0],
      motion,
    );
    assert.deepEqual(
      Array.from(opportunities.fireTicks),
      [0],
      "the final active flight tile remains interceptable before detonation",
    );
    assert.deepEqual(Array.from(motion.path), [missile.tile(), target]);
    assert.equal(motion.impactTick, 1, "adding the terminal tile must not delay impact");
    finalWindows++;
  }
  const updates = game.executeNextTick();
  bot.applyGameUpdate({
    updates,
    packedMotionPlans: game.drainPackedMotionPlans(),
  });
  for (const missile of missiles) {
    if (!missile.isActive() && !impacts.has(missile.id())) {
      assert.equal(
        bot.api.game.motionPlans().has(missile.id()),
        false,
        "an inactive-unit update removes its plan without waiting for expiry",
      );
      impacts.set(missile.id(), game.ticks());
    }
  }
  bot.applyGameUpdate({ tick: game.ticks() });
}
assert.equal(impacts.size, missiles.length, "both missiles actually detonate");
assert.equal(bot.api.game.motionPlans().size, 0, "resolved missiles release their motion plans");
bot.applyGameUpdate({ packedMotionPlans });
bot.applyGameUpdate({ tick: lastPlanTick + 1 });
assert.equal(
  bot.api.game.motionPlans().size,
  0,
  "finished paths expire even without unit deletion",
);
await new Promise<void>((resolve) => setImmediate(resolve));
bot.harness.window.close();
assert.equal(finalWindows, missiles.length);
assert.deepEqual(
  predictedImpacts,
  missiles.map((missile) => impacts.get(missile.id())),
  "active missile deadlines include the real same-silo launch wait",
);
assert.equal(
  await nuke.maybeFirePostSalvoHydrogen(),
  false,
  "resolved Atoms do not skip the five-tick landing margin",
);
while (game.ticks() < finisherState.postSalvoHydrogen.dueTick) game.executeNextTick();
assert.equal(
  await nuke.maybeFirePostSalvoHydrogen(),
  true,
  "the finisher is released after actual impacts and the landing margin",
);

// Local wait scheduling must not exchange the native closest-silo slots.
const orderGame = await setupTwoPlayerGame("big_plains");
const orderPlayer = orderGame.player("attacker");
const orderTarget = orderGame.ref(198, 100);
const nearTile = orderGame.ref(197, 100);
const speed = orderGame.config().nukeSpeed(UnitType.AtomBomb);
const pathLength = (tile: number) =>
  UniversalPathFinding.Parabola(orderGame, {
    increment: speed,
    directionUp: true,
  }).findPath(tile, orderTarget)!.length;
const nearFlight = pathLength(nearTile);
const maxSpread = Math.floor(orderGame.config().SAMCooldown() / 2);
const farTile = Array.from({ length: 197 }, (_, x) => orderGame.ref(x, 100)).find((tile) => {
  const difference = pathLength(tile) - nearFlight;
  return difference > 2 * Math.floor(maxSpread / 3) && difference <= maxSpread;
});
assert.notEqual(farTile, undefined, "native paths provide the decreasing-delay counterexample");
orderPlayer.conquer(nearTile);
orderPlayer.conquer(farTile!);
const nearSilo = orderPlayer.buildUnit(UnitType.MissileSilo, nearTile, {});
nearSilo.increaseLevel();
nearSilo.reloadMissile();
const farSilo = orderPlayer.buildUnit(UnitType.MissileSilo, farTile!, {});
const orderBehavior = executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/nukeBehavior.js")}\nObject.create(NukeBehavior.prototype);`,
  { UNIT: UnitType, Difficulty, within: (value, min, max) => Math.max(min, Math.min(max, value)) },
);
orderBehavior.game = Object.assign(Object.create(orderGame), {
  config: () => Object.assign(Object.create(orderGame.config()), { defaultNukeSpeed: () => speed }),
});
orderBehavior.isTrajectoryInterceptableBySam = () => false;
const entries = orderBehavior.getAvailableSiloEntries([nearSilo, farSilo], orderTarget, new Set());
const sequence = orderBehavior.createSamLaunchSequence(entries);
const orderSalvo = orderBehavior.getSamSalvo({
  window: sequence.map((bomb, index) => ({ ...bomb, index })),
  launchSequence: sequence,
  totalBombs: 3,
  maxSpread,
});
const executions = new Map<number, NukeExecution>();
const actualSources = new Map<number, number>();
const startTick = orderGame.ticks();
while (orderGame.ticks() <= startTick + Math.max(...orderSalvo.waits) + 2) {
  orderSalvo.waits.forEach((wait, index) => {
    if (startTick + wait !== orderGame.ticks()) return;
    const execution = new NukeExecution(UnitType.AtomBomb, orderPlayer, orderTarget);
    executions.set(index, execution);
    orderGame.addExecution(execution);
  });
  orderGame.executeNextTick();
  for (const [index, execution] of executions) {
    const missile = (execution as any).nuke;
    if (missile && !actualSources.has(index)) actualSources.set(index, missile.tile());
  }
}
assert.deepEqual(
  [0, 1, 2].map((index) => actualSources.get(index)),
  [nearTile, nearTile, farTile],
  "each planned flight must retain its native closest-silo slot after local delays",
);

// Slot position alone cannot predict departure: gaps drain serialization,
// while a recent pre-existing queue can delay even the first new missile.
for (const [emissions, preloaded, expectedWaits] of [
  [[0, 0, 0], 0, [0, 1, 2]],
  [[0, 1, 2], 0, [0, 0, 0]],
  [[0, 0, 4], 0, [0, 1, 0]],
  [[0, 2, 2], 0, [0, 0, 1]],
  [[0, 0, 0], 2, [1, 2, 3]],
] as const) {
  const departureGame = await setup(
    "big_plains",
    { instantBuild: true },
    [new PlayerInfo("attacker", PlayerType.Human, null, "attacker")],
    engineTestsUtil,
  );
  const owner = departureGame.player("attacker");
  owner.addGold(100_000_000n);
  const origin = departureGame.ref(1, 1);
  const destination = departureGame.ref(80, 1);
  owner.conquer(origin);
  const launcher = owner.buildUnit(UnitType.MissileSilo, origin, {});
  for (let slot = 1; slot < emissions.length + preloaded; slot++) {
    launcher.increaseLevel();
    launcher.reloadMissile();
  }
  for (let slot = 0; slot < preloaded; slot++) launcher.launch();
  const shots = emissions.map(() => new NukeExecution(UnitType.AtomBomb, owner, destination));
  const waits = new Map<number, number>();
  const spawnTicks = new Map<number, number>();
  const motion = new Map<number, GridPathPlan>();
  while (departureGame.ticks() <= Math.max(...emissions) + 1) {
    shots.forEach((shot, index) => {
      if (emissions[index] === departureGame.ticks()) departureGame.addExecution(shot);
    });
    departureGame.executeNextTick();
    const packed = departureGame.drainPackedMotionPlans();
    if (packed) {
      for (const plan of unpackMotionPlans(packed)) {
        if (plan.kind === "grid") motion.set(plan.unitId, plan);
      }
    }
    shots.forEach((shot, index) => {
      const missile = shot.getNuke();
      if (!missile || waits.has(index)) return;
      waits.set(index, missile.nukeState().waitTicks);
      spawnTicks.set(index, departureGame.ticks() - 1);
    });
  }
  assert.deepEqual(
    shots.map((_, index) => waits.get(index)),
    [...expectedWaits],
    `native departure waits for emissions ${emissions} with ${preloaded} old queue entries`,
  );
  assert.equal(motion.size, shots.length, "every native missile supplies its own motion plan");
  const impacts = new Map<number, number>();
  const lastImpact = Math.max(
    ...Array.from(motion.values(), (plan) => plan.startTick + plan.path.length),
  );
  while (departureGame.ticks() <= lastImpact && impacts.size < shots.length) {
    departureGame.executeNextTick();
    shots.forEach((shot, index) => {
      if (!shot.getNuke()!.isActive() && !impacts.has(index))
        impacts.set(index, departureGame.ticks());
    });
  }
  assert.equal(impacts.size, shots.length);
  shots.forEach((shot, index) => {
    const plan = motion.get(shot.getNuke()!.id());
    assert.ok(plan);
    assert.equal(plan.startTick, spawnTicks.get(index)! + expectedWaits[index] + 1);
    assert.equal(
      impacts.get(index),
      plan.startTick + plan.path.length,
      "observed detonation includes both native departure wait and terminal flight step",
    );
  });
}

console.log("nuke same-silo launch-stagger fixture passed (5 departure timing controls)");
