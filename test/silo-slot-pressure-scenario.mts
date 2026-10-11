import {
  attachNativeBot,
  setupNativeDuel,
  createNativeLoop,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { MissileSiloExecution } from "../openfront-engine/src/core/execution/MissileSiloExecution";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

// End-to-end SAM-demand scenario: a real hostile level-2 SAM and City target
// need three launch slots, but the level-2 Silo exposes two. The planner must
// discover the missing capacity and upgrade through the real build menu.
const { game, attacker, defender } = await setupNativeDuel();
const source = game.ref(1, 1);
const target = game.ref(80, 1);
const reserveBuildSite = game.ref(40, 1);
const territoryBoundary = game.ref(41, 1);
attacker.addGold(100_000_000n);
attacker.conquer(source);
attacker.conquer(reserveBuildSite);
attacker.conquer(territoryBoundary);
defender.conquer(target);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
silo.increaseLevel();
silo.reloadMissile();
silo.reloadMissile();
game.addExecution(new MissileSiloExecution(silo));
const targetSam = defender.buildUnit(UnitType.SAMLauncher, target, {});
targetSam.increaseLevel();
const valuableCity = defender.buildUnit(UnitType.City, target, {});
const { runner, step } = createNativeLoop(game, "silo-slot-pressure-scenario", (update) =>
  bot.applyGameUpdate(update),
);
const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
try {
  const { menu, nuke } = await attachNativeBot(bot, runner);
  const structures = bot.nationBot.structureBehavior;
  const rival = bot.api.game.playerBySmallID(defender.smallID());
  // Negative control: no SAM capacity request means no upgrade.
  assert.equal(
    await structures.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "no upgrade without a nuclear capacity request",
  );

  // Let the real target-specific planner discover the missing level: this
  // valuable SAM+City target needs three Atom slots, but the level-2 Silo has two.
  const state = bot.harness.internals.state;
  await nuke.maybeDestroyEnemySam(rival);
  assert.equal(state.nukeWantSlots?.targetSamId, targetSam.id());
  assert.equal(state.nukeWantSlots?.need, 3, "the covering SAM requires three Atom slots");
  const demandTargetTile = state.nukeWantSlots?.targetTile;
  const atomBlastRadius = Number(game.config().nukeMagnitudes(UnitType.AtomBomb).outer);
  assert.ok(
    demandTargetTile &&
      game.euclideanDistSquared(demandTargetTile, valuableCity.tile()) < atomBlastRadius ** 2,
    "the SAM-overwhelm plan keeps the valuable City inside its blast footprint",
  );
  assert.ok(
    nuke.blastStructureValue(demandTargetTile, [targetSam, valuableCity], atomBlastRadius) >
      nuke.blastStructureValue(demandTargetTile, [targetSam], atomBlastRadius),
    "the valuable City adds target value to the planned SAM-overwhelm blast",
  );
  assert.equal(
    silo.level(),
    2,
    "the planner leaves the Silo unchanged until the emitted upgrade intent resolves",
  );
  const siloUpgrades = bot.intentBuffer.filter(
    (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(siloUpgrades.length, 1, "exactly one silo upgrade intent is emitted");
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(silo.level(), 3, "the accepted upgrade adds the required capacity level");

  // A level-5 SAM needs seven shots. Upgrade the useful Silo one level at a
  // time even though that Silo alone cannot reach seven slots, then add a
  // route-clear Silo when the existing one reaches its level cap.
  targetSam.increaseLevel();
  targetSam.increaseLevel();
  targetSam.increaseLevel();
  await nuke.maybeDestroyEnemySam(rival);
  assert.equal(state.nukeWantSlots?.need, 7, "the level-5 SAM needs seven launch slots");
  const demandUpgrade = bot.intentBuffer.filter(
    (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(
    demandUpgrade.length,
    1,
    "SAM demand upgrades a useful Silo even when its own maximum is below the full salvo",
  );
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(silo.level(), 4, "the accepted demand upgrade adds one launch slot");
  await nuke.maybeDestroyEnemySam(rival);
  const finalLevelUpgrade = bot.intentBuffer.filter(
    (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(finalLevelUpgrade.length, 1, "the Silo upgrades again until its level cap");
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(silo.level(), 5, "the existing Silo reaches the engine's level cap");
  const structureNextInt = structures.random.nextInt;
  structures.random.nextInt = (min, max) => (max > min ? max - 1 : min);
  await nuke.maybeDestroyEnemySam(rival);
  structures.random.nextInt = structureNextInt;
  const newSiloBuilds = bot.intentBuffer.filter(
    (intent) => intent.type === "build_unit" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(newSiloBuilds.length, 1, "the unmet SAM demand emits one additional Silo build");
  assert.equal(
    bot.intentBuffer.some(
      (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
    ),
    false,
    "the capped Silo is not sent an invalid level-6 upgrade",
  );
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(
    state.nukeWantSlots?.need,
    7,
    "emitting the build does not spend capacity before acceptance",
  );
  step();
  const builtSilos = attacker.units(UnitType.MissileSilo);
  assert.equal(builtSilos.length, 2, "the engine accepts the capacity Silo build");
  const newSilo = builtSilos.find((candidate) => candidate.id() !== silo.id());
  assert.ok(newSilo, "the additional Silo is present in the game state");
  assert.equal(
    nuke.isTrajectoryInterceptableBySam(
      newSilo.tile(),
      state.nukeWantSlots.targetTile,
      new Set([targetSam.id()]),
    ),
    false,
    "the additional Silo has a route that can join the SAM-overwhelm salvo",
  );
  assert.equal(state.nukeWantSlots?.need, 7, "demand stays open until capacity is ready");
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    true,
    "the new route-compatible Silo is upgraded to finish the SAM capacity request",
  );
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(newSilo.level(), 2, "the accepted follow-up upgrade adds the seventh slot");
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    true,
    "a SAM arrival-window shortage keeps a useful Silo upgrade ahead of another build",
  );
  const arrivalWindowUpgrade = bot.intentBuffer.filter(
    (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(arrivalWindowUpgrade.length, 1, "arrival pressure emits one Silo upgrade intent");
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(newSilo.level(), 3, "the route-clear Silo gains a level for the SAM target");

  const launchSilos = attacker
    .units(UnitType.MissileSilo)
    .filter((candidate) => !candidate.isUnderConstruction());
  const reloadTicks =
    game.config().SiloCooldown() +
    Math.max(...launchSilos.map((candidate) => candidate.missileTimerQueue().length));
  // Accepted levels enter the native cooldown queue before their shots are launchable.
  for (let tick = 0; tick < reloadTicks; tick++) step();
  assert.ok(
    launchSilos.every((candidate) => candidate.missileTimerQueue().length === 0),
    "the bounded native cooldown window reloads all accepted Silo capacity",
  );
  const launchPlan = nuke.createSamOverwhelmPlan(targetSam, launchSilos);
  assert.equal(launchPlan.targetSamId, targetSam.id());
  assert.equal(launchPlan.targetTile, state.nukeWantSlots?.targetTile);
  assert.equal(launchPlan.totalBombs, 7, "the level-5 SAM requires seven Atom slots");
  const clearSlotCount = launchPlan.launchSequence.filter((slot) => !slot.interceptable).length;
  assert.equal(
    launchPlan.capacityMissing,
    false,
    `SAM capacity: clear=${clearSlotCount}, window=${launchPlan.window.length}/${launchPlan.totalBombs}`,
  );
  const expectedLaunches = nuke.getSamSalvo(launchPlan).bombsToFire;
  assert.ok(expectedLaunches >= launchPlan.totalBombs);
  assert.equal(
    await nuke.maybeDestroyEnemySam(rival),
    true,
    "the same NukeBehavior emits or queues the now-capable SAM-overwhelm salvo",
  );
  const atomIntents = bot.intentBuffer.filter(
    (intent) => intent.type === "build_unit" && intent.unit === UnitType.AtomBomb,
  );
  const queuedSalvo = nuke._pendingNukeLaunches.filter(
    (launch) => launch.salvo?.targetSamId === targetSam.id(),
  );
  assert.equal(
    atomIntents.length + queuedSalvo.length,
    expectedLaunches,
    "every capacity-planned Atom is either emitted or queued",
  );
  assert.ok(
    atomIntents.every((intent) => intent.tile === launchPlan.targetTile),
    "emitted Atom intents use the planned destination",
  );
  assert.ok(
    queuedSalvo.every(
      (launch) =>
        launch.targetPlayer.smallID() === rival.smallID() &&
        launch.tile === launchPlan.targetTile &&
        launch.salvo.targetTile === launchPlan.targetTile,
    ),
    "queued salvos preserve the defender, planned destination, and SAM target metadata",
  );
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  step();
  step();
  assert.equal(
    attacker.units(UnitType.AtomBomb).length,
    atomIntents.length,
    "the native engine accepts the emitted Atom prefix",
  );
} finally {
  bot.harness.window.close();
}
console.log("SAM-demand Silo-upgrade end-to-end scenario passed");
