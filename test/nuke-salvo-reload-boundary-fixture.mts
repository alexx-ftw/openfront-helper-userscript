import {
  attachNativeCombatBot,
  setupNativeSamRange,
  createNativeLoop,
  nativeSiloFlightTicks,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

// Reload before impact alone does not prove that a real SAM can intercept in time.
for (const reloadOffset of [-3, -2, -1, 0, 1, 2, 3]) {
  const { game, attacker, defender, source, target } = await setupNativeSamRange();
  attacker.buildUnit(UnitType.MissileSilo, source, {});
  const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
  sam.launch();
  game.addExecution(new SAMLauncherExecution(defender, null, sam));
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  const { runner, step } = createNativeLoop(game, "reload-boundary", (update) =>
    bot.applyGameUpdate(update),
  );
  try {
    const { nuke, rival } = await attachNativeCombatBot(bot, runner, defender);

    const flight = nativeSiloFlightTicks(bot, target, sam.id());
    const reloadTick = game.config().SAMCooldown();
    while (game.ticks() < reloadTick - flight + reloadOffset) step();
    await bot.api.beginTick(bot.pageGame.myPlayer());
    const predictedImpact = game.ticks() + flight;
    const salvo = {
      salvoId: 991,
      targetTile: target,
      targetSamId: sam.id(),
      plannedCoveringLevel: sam.level(),
      coveringSamIds: [sam.id()],
      flightTicks: flight,
    };
    assert.equal(nuke.queueDelayedNukeLaunch(target, UnitType.AtomBomb, rival, 0, salvo), true);
    assert.equal(
      await nuke.processPendingNukeLaunches(),
      reloadOffset < 0,
      "the arrival horizon accepts the late reload and rejects the earlier reload",
    );
    if (reloadOffset >= 0) {
      assert.equal(nuke.hasPendingNukeLaunches(), false);
      // Bypass only the salvo viability decision to verify its native counterfactual.
      assert.equal(await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, salvo), true);
    }
    step(bot.intentBuffer);
    bot.intentBuffer.length = 0;
    step();
    step();
    const missile = attacker.units(UnitType.AtomBomb)[0];
    assert.ok(missile);
    const plan = bot.api.game.motionPlans().get(missile.id());
    assert.ok(plan);
    const actualImpact = plan.startTick + plan.path.length;
    const planner = bot.nationBot.structureBehavior;
    const profiles = planner.buildLegendaryFriendlySamProfiles([sam], null, null);
    const motion = planner.legendaryActiveMissileMotion(missile, missile.tile());
    assert.ok(motion);
    const route = planner.legendaryBuildMissileRoute(
      {
        ...motion,
        targetTile: target,
        weapon: UnitType.AtomBomb,
        id: "native-reload-control",
      },
      profiles,
    );
    const canIntercept = route.samOptions.some((option) =>
      option.interceptTicks.some((tick) => tick >= profiles[option.samIndex].availableTicks[0]),
    );
    assert.equal(
      canIntercept,
      reloadOffset >= 0,
      "native motion plus reachable fire opportunities classifies the reload boundary",
    );
    while (missile.isActive() && game.ticks() <= actualImpact + 1) step();
    console.log(
      JSON.stringify({
        reloadOffset,
        predictedImpact,
        actualImpact,
        reloadTick,
        samActive: sam.isActive(),
        missileActive: missile.isActive(),
        samQueue: sam.missileTimerQueue(),
      }),
    );
    assert.equal(actualImpact, predictedImpact + 2);
    assert.equal(
      sam.isActive(),
      reloadOffset >= 0,
      "only the earlier reload intercepts the real native shot",
    );
    assert.equal(
      sam.missileTimerQueue().length,
      reloadOffset >= 0 || actualImpact <= reloadTick ? 1 : 0,
    );
    assert.equal(missile.isActive(), false);
  } finally {
    bot.harness.window.close();
  }
}
