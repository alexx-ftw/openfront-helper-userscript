import assert from "node:assert/strict";
import { GameRunner } from "../openfront-engine/src/core/GameRunner";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager";
import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { MissileSiloExecution } from "../openfront-engine/src/core/execution/MissileSiloExecution";
import { TurnSchema } from "../openfront-engine/src/core/Schemas";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import { engineTestsUtil } from "./helpers/two-player-game.mts";
import {
  createBuildMenu,
  createMaxDifficultyOpponent,
} from "../scripts/headless/opponent-adapter.js";

// Prior-pass prefixes need receipts; a freshly validated due batch can emit together.
for (const [prefixCount, physicalDefense] of [
  [0, false],
  [2, false],
  [0, true],
] as const) {
  const game = await setup(
    "big_plains",
    { instantBuild: true },
    [
      new PlayerInfo("attacker", PlayerType.Human, "attacker", "attacker"),
      new PlayerInfo("defender", PlayerType.Human, "defender", "defender"),
    ],
    engineTestsUtil,
  );
  const attacker = game.player("attacker");
  const defender = game.player("defender");
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
  for (let slot = 1; slot < 3; slot++) {
    silo.increaseLevel();
    silo.reloadMissile();
  }
  const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
  sam.increaseLevel();
  sam.reloadMissile();
  defender.buildUnit(UnitType.City, finisherTarget, {});
  if (physicalDefense) {
    game.addExecution(new SAMLauncherExecution(defender, null, sam));
    game.addExecution(new MissileSiloExecution(silo));
  }
  const runner = new GameRunner(
    game,
    new Executor(game, "salvo-receipt-gap", "attacker"),
    (update) => {
      assert.ok(!("errMsg" in update));
      bot.applyGameUpdate(update);
    },
  );
  const step = (intents = []) => {
    runner.addTurn(
      TurnSchema.parse({
        turnNumber: game.ticks(),
        intents: intents.map((intent) => ({ ...intent, clientID: "attacker" })),
      }),
    );
    assert.equal(runner.executeNextTick(), true);
  };
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  try {
    bot.attach({ runner, clientID: "attacker" });
    await bot.api.beginTick(bot.pageGame.myPlayer());
    bot.nationBot.player = bot.api.game.myPlayer();
    bot.nationBot.initializeBehaviors();
    const menu = createBuildMenu(bot);
    bot.harness.current.buildMenu = menu;
    bot.harness.current.eventBus = menu.eventBus;
    bot.harness.internals.state.settings.enabled = true;
    bot.harness.internals.state.settings.winFixes = true;
    const nuke = bot.nationBot.nukeBehavior;
    // The salvo flattens the target's only structure, so the finisher's
    // enemy-value gate would hold it; this fixture tests receipt/reload
    // resume mechanics, not gate economics (nuke-finisher-friendly-gate-fixture).
    const rival = bot.api.game.playerBySmallID(defender.smallID());
    const flight = nuke.getAvailableSiloEntries(
      [bot.nationBot.player.units(UnitType.MissileSilo)[0]],
      target,
      new Set([sam.id()]),
    )[0].flightTicks;
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
      const arrivals = attacker.units(UnitType.AtomBomb).map((missile) => {
        const plan = bot.api.game.motionPlans().get(missile.id());
        assert.ok(plan);
        return plan.startTick + plan.path.length;
      });
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
      const lastImpact = Math.max(
        ...missiles.map((missile) => {
          const plan = bot.api.game.motionPlans().get(missile.id());
          assert.ok(plan);
          return plan.startTick + plan.path.length;
        }),
      );
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
