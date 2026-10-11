import {
  loadUnitToLevel,
  attachNativeCombatBot,
  setupNativeSamRange,
  createNativeLoop,
  nativeMissileImpactTicks,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

// Forecast a pending three-Atom batch with the route planner, then let the
// native engine decide interception. The SAM reload must land inside the
// predicted arrival window for one case and outside it for the other.
for (const beforeReload of [true, false]) {
  const { game, attacker, defender, source, target } = await setupNativeSamRange();
  const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
  loadUnitToLevel(silo, 3);
  const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
  sam.launch();
  game.addExecution(new SAMLauncherExecution(defender, null, sam));
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  const { runner, step } = createNativeLoop(game, "pending-forecast", (update) =>
    bot.applyGameUpdate(update),
  );
  try {
    const { nuke, rival } = await attachNativeCombatBot(bot, runner, defender);

    const siloUnit = bot.nationBot.player.units(UnitType.MissileSilo)[0];
    const flight = nuke.getAvailableSiloEntries([siloUnit], target, new Set([sam.id()]))[0]
      .flightTicks;
    const reloadTick = game.config().SAMCooldown();
    const launchTick = beforeReload ? reloadTick - flight - 4 : reloadTick - flight + 2;
    while (game.ticks() < launchTick) step();
    await bot.api.beginTick(bot.pageGame.myPlayer());

    const planner = bot.nationBot.structureBehavior;
    const profiles = planner.buildLegendaryFriendlySamProfiles([sam], null, null);
    const fromTile = siloUnit.tile();
    const path = planner.legendaryNukeFlightPath(fromTile, target);
    const routes = [0, 1, 2].map((offset) =>
      planner.legendaryBuildMissileRoute(
        {
          fromTile,
          targetTile: target,
          impactTick: flight + offset + 2,
          launchOffset: offset,
          weapon: UnitType.AtomBomb,
          id: `forecast:${offset}`,
          path,
        },
        profiles,
      ),
    );
    // One level-one SAM holds one usable charge before its tick-90 reload;
    // greedy-classify routes by earliest impact with a reachable fire tick.
    const availableTick = Math.max(...profiles[0].availableTicks);
    const interceptable = routes
      .filter((route) =>
        route.samOptions.some((option) =>
          option.interceptTicks.some((tick) => tick >= availableTick),
        ),
      )
      .sort((a, b) => a.impactTick - b.impactTick);
    const forecast = {
      intercepted: Math.min(1, interceptable.length),
      unintercepted: 3 - Math.min(1, interceptable.length),
    };

    const salvo = {
      salvoId: beforeReload ? 101 : 102,
      targetTile: target,
      targetSamId: sam.id(),
      coveringSamIds: [sam.id()],
      flightTicks: flight,
    };
    for (let index = 0; index < 3; index++) {
      assert.equal(nuke.queueDelayedNukeLaunch(target, UnitType.AtomBomb, rival, 0, salvo), true);
    }
    assert.equal(await nuke.processPendingNukeLaunches(), true);
    step(bot.intentBuffer);
    bot.intentBuffer.length = 0;
    while (attacker.units(UnitType.AtomBomb).length < 3) step();
    const missiles = attacker.units(UnitType.AtomBomb);
    const packed = game.drainPackedMotionPlans();
    bot.applyGameUpdate({ packedMotionPlans: packed });
    const impacts = nativeMissileImpactTicks(bot, missiles);
    const intercepted = [];
    while (missiles.some((missile) => missile.isActive())) {
      step();
      for (let index = 0; index < missiles.length; index++) {
        if (missiles[index].isActive() || intercepted[index] !== undefined) continue;
        intercepted[index] = game.ticks() < impacts[index];
      }
    }
    const nativeIntercepted = intercepted.filter(Boolean).length;
    assert.equal(
      nativeIntercepted,
      forecast.intercepted,
      "the route forecast matches native interceptions",
    );
    assert.equal(
      missiles.length - nativeIntercepted,
      forecast.unintercepted,
      "the route forecast matches native penetrations",
    );
    assert.equal(sam.isActive(), false, "a penetrating Atom always destroys the level-one SAM");
    console.log(
      JSON.stringify({
        beforeReload,
        predicted: impacts[0] - 2,
        actual: impacts,
        reloadTick,
        forecast,
      }),
    );
  } finally {
    bot.harness.window.close();
  }
}
