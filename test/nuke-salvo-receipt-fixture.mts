import {
  loadUnitToLevel,
  attachNativeCombatBot,
  setupNativeDuel,
  createNativeLoop,
  nativeSiloFlightTicks,
  nativeMissileImpactTicks,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { MissileSiloExecution } from "../openfront-engine/src/core/execution/MissileSiloExecution";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

// Prior-pass prefixes need receipts; a freshly validated due batch can emit together.
for (const [prefixCount, physicalDefense] of [
  [0, false],
  [2, false],
  [0, true],
] as const) {
  const { game, attacker, defender } = await setupNativeDuel();
  const source = game.ref(1, physicalDefense ? 80 : 1);
  const target = game.ref(80, 1);
  // A priced defender structure on its own tile: the finisher's pending
  // target points here, so its enemy-value gate passes even after the
  // atomic salvo flattens the SAM on the other tile.
  const finisherTarget = game.ref(84, 4);
  attacker.addGold(100_000_000n);
  attacker.conquer(source);
  defender.conquer(target);
  defender.conquer(finisherTarget);
  if (physicalDefense) defender.conquer(game.ref(180, 180));
  const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
  loadUnitToLevel(silo, 3);
  const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
  loadUnitToLevel(sam, 2);
  defender.buildUnit(UnitType.City, finisherTarget, {});
  if (physicalDefense) {
    game.addExecution(new SAMLauncherExecution(defender, null, sam));
    game.addExecution(new MissileSiloExecution(silo));
  }
  const { runner, step } = createNativeLoop(game, "salvo-receipt-gap", (update) =>
    bot.applyGameUpdate(update),
  );
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  try {
    const { menu, nuke, rival } = await attachNativeCombatBot(bot, runner, defender);
    // The salvo flattens the target's only structure, so the finisher's
    // enemy-value gate would hold it; this fixture tests receipt/reload
    // resume mechanics, not gate economics (nuke-finisher-friendly-gate-fixture).

    const flight = nativeSiloFlightTicks(bot, target, sam.id());
    const salvo = {
      salvoId: 99,
      targetTile: target,
      targetSamId: sam.id(),
      plannedCoveringLevel: 2,
      flightTicks: flight,
      // The per-launch revalidation exempts exactly the covering SAM this
      // salvo was sized to overwhelm (same metadata fireSamSalvo attaches).
      coveringSamIds: [sam.id()],
    };
    for (let index = 0; index < prefixCount; index++)
      assert.equal(await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, { ...salvo }), true);
    for (let index = prefixCount; index < 3; index++)
      assert.equal(nuke.queueDelayedNukeLaunch(target, UnitType.AtomBomb, rival, 1, salvo), true);
    const atomIntents = () =>
      bot.intentBuffer.filter(
        (intent) => intent.type === "build_unit" && intent.unit === UnitType.AtomBomb,
      );
    assert.equal(atomIntents().length, prefixCount);
    step(bot.intentBuffer);
    bot.intentBuffer.length = 0;
    assert.equal(
      attacker.units(UnitType.AtomBomb).length,
      0,
      "the admitted prefix has not reached native missile creation yet",
    );
    const emittedTick = game.ticks();
    if (prefixCount === 0) {
      assert.equal(await nuke.processPendingNukeLaunches(), true);
      assert.equal(
        atomIntents().length,
        3,
        "one fully validated due batch is not serialized by its own new receipts",
      );
      assert.equal(nuke.hasPendingNukeLaunches(), false);
    } else {
      assert.equal(await nuke.processPendingNukeLaunches(), false);
      assert.equal(
        nuke.hasPendingNukeLaunches(),
        true,
        "the third Atom survives until the two prefix receipts arrive",
      );
      step();
      step();
      assert.equal(
        attacker.units(UnitType.AtomBomb).length,
        2,
        "both prefix intents were valid and actually create native missiles afterwards",
      );
      assert.equal(
        await nuke.processPendingNukeLaunches(),
        true,
        "confirmed prefix capacity supports the tail",
      );
    }
    step(bot.intentBuffer);
    bot.intentBuffer.length = 0;
    step();
    step();
    assert.equal(attacker.units(UnitType.AtomBomb).length, 3);
    assert.equal(nuke.hasPendingNukeLaunches(), false);
    if (prefixCount === 0) {
      const arrivals = nativeMissileImpactTicks(bot, attacker.units(UnitType.AtomBomb));
      assert.deepEqual(
        arrivals,
        [2, 3, 4].map((offset) => emittedTick + flight + offset),
        "the native build-menu pipeline and silo serialization exceed travel-only estimates",
      );
    }
    if (physicalDefense) {
      const missiles = attacker.units(UnitType.AtomBomb);
      const finisher = {
        salvoId: salvo.salvoId,
        targetTile: finisherTarget,
        dueTick: game.ticks(),
        targetSmallID: defender.smallID(),
      };
      bot.harness.internals.state.postSalvoHydrogen = finisher;
      const lastImpact = Math.max(...nativeMissileImpactTicks(bot, missiles));
      while (game.ticks() <= lastImpact && missiles.some((missile) => missile.isActive())) {
        await bot.api.beginTick(bot.pageGame.myPlayer());
        assert.equal(
          await nuke.maybeFirePostSalvoHydrogen(),
          false,
          "a stale finisher deadline cannot bypass live native Atoms",
        );
        step();
      }
      assert.equal(sam.missileTimerQueue().length, 2, "the real SAM spends both charges");
      assert.equal(sam.isActive(), false, "the saturation batch destroys the real SAM");
      assert.equal(silo.isActive(), true, "the source remains outside the Atomic blast");
      // Native silo execution reloads at most one expired queue entry per tick.
      const launchDeadline =
        Math.max(
          finisher.dueTick,
          ...silo.missileTimerQueue().map((tick) => tick + game.config().SiloCooldown()),
        ) +
        silo.missileTimerQueue().length +
        1;
      let fired = false;
      while (!fired && game.ticks() <= launchDeadline) {
        await bot.api.beginTick(bot.pageGame.myPlayer());
        fired = await nuke.maybeFirePostSalvoHydrogen();
        if (!fired) step();
      }
      assert.equal(fired, true, "the finisher resumes after native impacts and silo reload");
      assert.ok(game.ticks() >= finisher.dueTick, "the native impact landing margin is respected");
      assert.equal(bot.harness.internals.state.postSalvoHydrogen, null);
      assert.equal(
        bot.intentBuffer.filter(
          (intent) => intent.type === "build_unit" && intent.unit === UnitType.HydrogenBomb,
        ).length,
        1,
      );
      step(bot.intentBuffer);
      step();
      step();
      assert.equal(
        attacker.units(UnitType.HydrogenBomb).length,
        1,
        "the resumed finisher creates a real native Hydrogen",
      );
      console.log("native saturation batch penetrates an active level-two SAM");
    }
    console.log("native salvo receipt-gap regression passed");
  } finally {
    bot.harness.window.close();
  }
}
