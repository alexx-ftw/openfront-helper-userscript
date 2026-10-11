import {
  setupNativeGame,
  createNativeStep,
  setupNativeDuel,
  initializeNativeBot,
  installNativeBuildMenu,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { GameRunner } from "../openfront-engine/src/core/GameRunner";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager";
import { TurnSchema } from "../openfront-engine/src/core/Schemas";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

for (const action of ["launch", "silo-upgrade"]) {
  for (const capture of [
    "none",
    "before-probe",
    "during-probe",
    ...(action === "launch" ? ["sam-during-probe", "salvo-sam-during-probe"] : []),
    ...(action === "silo-upgrade" ? ["missile-during-probe"] : []),
  ]) {
    console.error("CASE", action, capture);
    const samRace = capture.endsWith("sam-during-probe");
    const shouldSend = capture === "none" || capture === "salvo-sam-during-probe";
    const { game, attacker, defender } = await setupNativeDuel();
    const source = game.ref(1, 1);
    const target = game.ref(80, 1);
    attacker.conquer(source);
    attacker.addGold(100_000_000n);
    defender.conquer(target);
    defender.conquer(game.ref(80, 2));
    const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
    const sam =
      action === "silo-upgrade"
        ? defender.buildUnit(UnitType.SAMLauncher, game.ref(80, 2), {})
        : null;
    let raceSam: ReturnType<typeof defender.buildUnit> | null = null;
    const executor = new Executor(game, "nuke-territory-race", "attacker");
    let deliveredTick = -1;
    const runner = new GameRunner(game, executor, (update) => {
      assert.ok(!("errMsg" in update), "the runner must not hide an execution failure");
      deliveredTick = update.tick;
    });
    const runTurn = (intents = []) => {
      const tick = game.ticks();
      const before = {
        level: silo.level(),
        gold: attacker.gold(),
        atoms: attacker.units(UnitType.AtomBomb).length,
      };
      runner.addTurn(
        TurnSchema.parse({
          turnNumber: tick,
          intents: intents.map((intent) => ({ ...intent, clientID: "attacker" })),
        }),
      );
      assert.equal(runner.pendingTurns(), 1);
      assert.equal(game.ticks(), tick, "enqueueing cannot execute the turn");
      assert.equal(silo.level(), before.level);
      assert.equal(attacker.gold(), before.gold);
      assert.equal(attacker.units(UnitType.AtomBomb).length, before.atoms);
      assert.equal(runner.executeNextTick(), true);
      assert.equal(game.ticks(), tick + 1);
      assert.equal(deliveredTick, game.ticks(), "the runner delivers its engine update");
      assert.equal(runner.pendingTurns(), 0);
      assert.equal(runner.executeNextTick(), false, "an empty queue cannot advance the engine");
    };
    const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
    await initializeNativeBot(bot, runner);
    assert.equal(bot.nationBot.player.smallID(), attacker.smallID());
    const menu = installNativeBuildMenu(bot);
    bot.harness.internals.state.settings.enabled = true;
    bot.harness.internals.state.settings.winFixes = true;
    const nuke = bot.nationBot.nukeBehavior;
    const targetPlayer = bot.api.game.playerBySmallID(defender.smallID());
    assert.equal(nuke.isValidNukeTarget(targetPlayer), true);
    if (samRace) {
      assert.equal(nuke.isTrajectoryInterceptableBySam(source, target), false);
    }
    if (action === "silo-upgrade") {
      bot.harness.internals.state.nukeWantSlots = {
        need: 2,
        targetSamId: sam!.id(),
        targetTile: target,
        unblockedSiloIds: [silo.id()],
        at: game.ticks(),
      };
      assert.equal(nuke.getRouteEligibleSilos({ targetTile: target }).length, 1);
    }
    if (capture === "before-probe") attacker.conquer(target);
    const nativeBuildables = runner.playerBuildables.bind(runner);
    let probes = 0;
    runner.playerBuildables = (...args) => {
      const result = nativeBuildables(...args);
      const probeTile = action === "launch" ? target : source;
      if (args[1] === game.x(probeTile) && args[2] === game.y(probeTile)) {
        probes++;
        const buildable = result.find(
          (bu) => bu.type === (action === "launch" ? UnitType.AtomBomb : UnitType.MissileSilo),
        );
        assert.ok(buildable, "the native worker exposes the requested buildable");
        if (action === "launch")
          assert.equal(buildable.canBuild, source, "the worker authorizes the launch silo");
        else
          assert.equal(
            buildable.canUpgrade,
            silo.id(),
            "the worker authorizes the actual silo upgrade",
          );
        if (capture === "during-probe") attacker.conquer(target);
        if (capture === "missile-during-probe") {
          const missile = defender.buildUnit(UnitType.AtomBomb, game.ref(79, 1), {});
          missile.setTargetTile(source);
          runTurn();
          assert.equal(
            bot.nationBot.structureBehavior.tileInsideActiveHostileMissileImpact(source),
            true,
            "a native active missile threatens the silo after the legality probe",
          );
        }
        if (samRace) {
          raceSam = defender.buildUnit(UnitType.SAMLauncher, game.ref(80, 2), {});
          plannedSalvo.targetSamId = raceSam.id();
          plannedSalvo.coveringSamIds = [raceSam.id()];
          plannedSalvo.plannedCoveringLevel = raceSam.level();
          assert.equal(
            nuke.isTrajectoryInterceptableBySam(source, target),
            true,
            "the native SAM changes the route while the legality probe yields",
          );
        }
      }
      return result;
    };
    const goldBefore = attacker.gold();
    const buildsBefore = bot.harness.internals.state.stats.builds;
    const plannedSalvo = {
      salvoId: 1,
      flightTicks: 0,
      targetTile: target,
      targetSamId: null,
      coveringSamIds: [],
      plannedCoveringLevel: 0,
    };
    const sent =
      action === "launch"
        ? capture === "salvo-sam-during-probe"
          ? (await nuke.firePendingNukeLaunch(
              {
                tile: target,
                nukeType: UnitType.AtomBomb,
                targetPlayer,
                // Planned-budget salvo shape: the launch gate re-validates
                // against the live layout and exempts exactly the covering
                // SAM the salvo was sized to overwhelm. The budget fields
                // are filled in by the probe wrapper the moment the native
                // SAM exists, because this object literal evaluates first.
                salvo: plannedSalvo,
              },
              0,
            )) === "fired"
          : await nuke.sendNuke(target, UnitType.AtomBomb, targetPlayer)
        : await bot.nationBot.structureBehavior.maybeUpgradeSiloForNukeDemand();
    assert.equal(nuke.isValidNukeTarget(targetPlayer), true, "the rival remains a valid target");
    assert.equal(
      nuke.isValidNukeDestination(target),
      capture === "none" || samRace || capture === "missile-during-probe",
    );
    if (!shouldSend) {
      assert.equal(
        bot.intentBuffer.length,
        0,
        "an invalid destination or newly blocked ordinary route produces no intents",
      );
      assert.equal(bot.harness.internals.state.stats.builds, buildsBefore);
      runTurn();
    }
    assert.equal(probes, capture === "before-probe" ? 0 : 1);
    assert.equal(sent, shouldSend);
    const launches = bot.intentBuffer.filter(
      (intent) => intent.type === "build_unit" && intent.unit === UnitType.AtomBomb,
    );
    assert.equal(launches.length, action === "launch" && shouldSend ? 1 : 0);
    assert.equal(nuke.atomBombsLaunched, launches.length);
    const upgrades = bot.intentBuffer.filter(
      (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
    );
    assert.equal(upgrades.length, action === "silo-upgrade" && capture === "none" ? 1 : 0);
    if (action === "silo-upgrade") {
      if (capture === "none") {
        runTurn(upgrades);
        assert.equal(silo.level(), 2, "the emitted intent upgrades the native silo");
        assert.ok(attacker.gold() < goldBefore, "the native upgrade actually spends gold");
      } else {
        assert.equal(silo.level(), 1);
        assert.equal(attacker.gold(), goldBefore, "obsolete demand spends no gold");
        if (capture === "missile-during-probe") {
          assert.equal(
            bot.harness.internals.state.nukeWantSlots.need,
            2,
            "a transient impact hazard preserves the still-valid capacity request",
          );
          defender.units(UnitType.AtomBomb)[0].delete(false);
          runner.playerBuildables = nativeBuildables;
          runTurn();
          assert.equal(
            await bot.nationBot.structureBehavior.maybeUpgradeSiloForNukeDemand(),
            true,
            "the same capacity request resumes once the impact hazard disappears",
          );
          runTurn(bot.intentBuffer);
          assert.equal(silo.level(), 2);
          assert.ok(attacker.gold() < goldBefore);
        } else {
          assert.equal(
            bot.harness.internals.state.nukeWantSlots,
            null,
            "capture clears obsolete nuclear demand",
          );
        }
      }
      assert.equal(launches.length, 0, "the capacity request cannot launch a bomb");
    } else if (shouldSend) {
      runTurn(launches);
      runTurn();
      runTurn();
      runTurn();
      assert.equal(
        attacker.units(UnitType.AtomBomb).length,
        1,
        "the emitted intent launches a native missile",
      );
    } else {
      assert.equal(game.owner(target).smallID(), samRace ? defender.smallID() : attacker.smallID());
      assert.equal(attacker.units(UnitType.AtomBomb).length, 0);
    }
    bot.harness.window.close();
  }
}
for (const addCloser of [false, true]) {
  const game = await setupNativeGame();
  const attacker = game.player("attacker");
  const target = game.ref(80, 1);
  const near = game.ref(1, 1);
  const far = game.ref(1, 80);
  attacker.addGold(100_000_000n);
  attacker.conquer(near);
  attacker.conquer(far);
  game.player("defender").conquer(target);
  const nearSilo = attacker.buildUnit(UnitType.MissileSilo, near, {});
  nearSilo.increaseLevel();
  nearSilo.reloadMissile();
  attacker.buildUnit(UnitType.MissileSilo, far, {});
  const runner = new GameRunner(
    game,
    new Executor(game, "nuke-slot-reservation", "attacker"),
    () => {},
  );
  const step = createNativeStep(game, runner);
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  await initializeNativeBot(bot, runner);
  const menu = installNativeBuildMenu(bot);
  const nuke = bot.nationBot.nukeBehavior;
  const rival = bot.api.game.playerBySmallID(game.player("defender").smallID());
  const predicted = [];
  const forecasts = [];
  const cachedFlight = nuke.getAvailableSiloEntries(
    bot.nationBot.player.units(UnitType.MissileSilo),
    target,
    new Set(),
  )[0].flightTicks;
  try {
    for (let index = 0; index < 3; index++) {
      predicted.push(nuke.nukeSpawn(UnitType.AtomBomb, target));
      const metadata = { salvoId: 1, flightTicks: cachedFlight };
      forecasts.push(metadata);
      assert.equal(await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, metadata), true);
    }
    const firstThree = [...bot.intentBuffer];
    let extraSent;
    let closer;
    if (addCloser) {
      closer = game.ref(70, 1);
      attacker.conquer(closer);
      attacker.buildUnit(UnitType.MissileSilo, closer, {});
      step(); // Deliver the capacity change before any buffered nuclear intent.
      predicted.push(nuke.nukeSpawn(UnitType.AtomBomb, target));
      const metadata = { salvoId: 1, flightTicks: cachedFlight };
      forecasts.push(metadata);
      extraSent = await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, metadata);
      assert.equal(extraSent, true);
    } else {
      assert.equal(
        nuke.getAvailableSiloEntries(
          bot.nationBot.player.units(UnitType.MissileSilo),
          target,
          new Set(),
        ).length,
        0,
        "salvo planning sees the same exhausted projected slots as source prediction",
      );
      extraSent = await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, { salvoId: 1 });
    }
    step(addCloser ? bot.intentBuffer : firstThree);
    step();
    step();
    const actualSources = attacker.units(UnitType.AtomBomb).map((unit) => unit.tile());
    assert.deepEqual(
      actualSources,
      addCloser ? [closer, near, near, far] : [near, near, far],
      "native execution consumes the closest available slots in intent order",
    );
    if (addCloser) {
      assert.equal(
        predicted[3],
        actualSources[3],
        "new capacity reprojects the entire unacknowledged prefix",
      );
      assert.equal(
        forecasts[3].flightTicks,
        attacker.units(UnitType.AtomBomb)[3].trajectory().length,
        "the next emitted shot refreshes flight time after native source reassignment",
      );
    } else {
      assert.deepEqual(
        predicted,
        actualSources,
        "same-frame source predictions match native overflow",
      );
      assert.equal(extraSent, false, "a stale worker reply cannot oversubscribe the final slot");
      assert.deepEqual(
        forecasts.map((entry) => entry.flightTicks),
        attacker.units(UnitType.AtomBomb).map((unit) => unit.trajectory().length),
        "emission-time flight estimates match native near/near/far trajectories",
      );
    }
    nearSilo.increaseLevel();
    while (nearSilo.missileTimerQueue().length > 0) nearSilo.reloadMissile();
    step();
    assert.equal(
      nuke.nukeSpawn(UnitType.AtomBomb, target),
      near,
      "native missile receipts release virtual occupancy before its grace expires",
    );
    assert.equal(
      nuke.getAvailableSiloEntries(
        bot.nationBot.player.units(UnitType.MissileSilo),
        target,
        new Set(),
      )[0].slots,
      3,
      "confirmed reload capacity is not double-reserved after missile receipts",
    );
  } finally {
    bot.harness.window.close();
  }
}
console.log(
  "live-engine nuclear territory, route, upgrade and slot reservation fixture passed (11 scenarios)",
);
