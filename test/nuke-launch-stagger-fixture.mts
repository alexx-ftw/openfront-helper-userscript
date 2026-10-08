import assert from "node:assert/strict";

import { NukeExecution } from "../openfront-engine/src/core/execution/NukeExecution";
import { Difficulty, UnitType } from "../openfront-engine/src/core/game/Game";
import { engineTestsUtil, setupTwoPlayerGame } from "./helpers/two-player-game.mts";
import { PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import { unpackMotionPlans } from "../openfront-engine/src/core/game/MotionPlans";
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

console.log("nuke same-silo launch-stagger fixture passed");
