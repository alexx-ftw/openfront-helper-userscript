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

// A hostile SAM off the final approach whose slot reloads before the last
// arrival still intercepts natively (fires on the trajectory's terminal
// window). Travel-only salvo viability must keep blocking the salvo, and the
// counterfactual shot must really be intercepted, not detonate: this pins
// the 2026-10-08 refutation of the unreachable-reload-overreject experiment.
const { game, attacker, defender, source, target } = await setupNativeSamRange();
attacker.buildUnit(UnitType.MissileSilo, source, {});
const sam = defender.buildUnit(UnitType.SAMLauncher, game.ref(86, 3), {});
sam.launch();
game.addExecution(new SAMLauncherExecution(defender, null, sam));
const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
const { runner, step } = createNativeLoop(game, "off-approach-intercept", (update) =>
  bot.applyGameUpdate(update),
);
try {
  const { nuke, rival } = await attachNativeCombatBot(bot, runner, defender);

  const flight = nativeSiloFlightTicks(bot, target, sam.id());
  const launchTick = game.config().SAMCooldown() - flight + 6;
  while (game.ticks() < launchTick) step();
  await bot.api.beginTick(bot.pageGame.myPlayer());
  const salvo = {
    salvoId: 777,
    targetTile: target,
    targetSamId: sam.id(),
    coveringSamIds: [sam.id()],
    flightTicks: flight,
  };
  assert.equal(nuke.queueDelayedNukeLaunch(target, UnitType.AtomBomb, rival, 0, salvo), true);
  assert.equal(
    await nuke.processPendingNukeLaunches(),
    false,
    "travel-only viability blocks the reload-before-arrival salvo",
  );
  assert.equal(nuke.hasPendingNukeLaunches(), false);
  assert.equal(await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, salvo), true);
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  while (attacker.units(UnitType.AtomBomb).length < 1) step();
  const missile = attacker.units(UnitType.AtomBomb)[0];
  let maxSamMissiles = 0;
  while (missile.isActive()) {
    step();
    maxSamMissiles = Math.max(maxSamMissiles, game.units(UnitType.SAMMissile).length);
  }
  assert.equal(
    missile.reachedTarget(),
    false,
    "the engine intercepts the counterfactual shot before detonation",
  );
  assert.equal(
    maxSamMissiles > 0,
    true,
    "the off-approach SAM does launch an interceptor during the flight",
  );
  assert.equal(sam.isActive(), true, "the SAM survives because no detonation ever happens near it");
  console.log(
    JSON.stringify({
      launchTick,
      flight,
      impactApprox: game.ticks(),
      samQueue: sam.missileTimerQueue(),
      verdict: "off-approach SAM intercepts natively; travel-only block is correct",
    }),
  );
} finally {
  bot.harness.window.close();
}
