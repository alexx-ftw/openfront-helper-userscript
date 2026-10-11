import {
  useProductionNukeMagnitudes,
  attachNativeCombatBot,
  setupNativeDuel,
  createNativeLoop,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

// The post-salvo Hydrogen finisher fires the largest blast circle the bot
// owns (outer 100). Offensive-reach silo placement deliberately moves our
// silos toward hostile centers, so the finisher must price friendly-fire
// with the same monetary geometry as the anti-SAM aim selector: fire only
// when remaining enemy structure value covers the friendly replacement
// loss. An own forward silo inside the circle holds and clears the
// finisher; without one, the finisher still launches.
for (const c of [
  { forwardSilo: true, expectFired: false, label: "own silo inside the circle" },
  {
    forwardSilo: true,
    mirvTarget: true,
    expectFired: true,
    label: "mirv-capable enemy silo outweighs own silo loss",
  },
  { forwardSilo: false, expectFired: true, label: "no friendly structure inside" },
]) {
  const { game, attacker, defender } = await setupNativeDuel();
  // The shared test config stubs every magnitude to {1,1} for tick
  // predictability. Restore the production hydrogen magnitudes so the
  // finisher gate prices blast geometry at real radii (same override as
  // nuke-blast-radius-fixture).
  useProductionNukeMagnitudes(game);
  const source = game.ref(1, 80);
  const target = game.ref(80, 1);
  const farCity = game.ref(140, 50);
  attacker.addGold(100_000_000n);
  attacker.conquer(source);
  defender.conquer(target);
  defender.conquer(farCity);
  defender.conquer(game.ref(180, 180));
  const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
  if (c.forwardSilo) {
    const forward = game.ref(150, 60);
    attacker.conquer(forward);
    attacker.buildUnit(UnitType.MissileSilo, forward, {});
  }
  defender.buildUnit(UnitType.City, target, {});
  defender.buildUnit(UnitType.City, farCity, {});
  if (c.mirvTarget) {
    defender.addGold(50_000_000n);
    defender.buildUnit(UnitType.MissileSilo, target, {});
  }
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  const { runner, step } = createNativeLoop(game, "finisher-friendly-gate", (update) =>
    bot.applyGameUpdate(update),
  );
  try {
    const { nuke, rival } = await attachNativeCombatBot(bot, runner, defender);

    await bot.api.beginTick(bot.pageGame.myPlayer());
    bot.harness.internals.state.postSalvoHydrogen = {
      salvoId: 4242,
      targetSmallID: defender.smallID(),
      targetTile: target,
      dueTick: game.ticks(),
      plannedCoveringLevel: 0,
    };
    const fired = await nuke.maybeFirePostSalvoHydrogen();
    assert.equal(
      fired,
      c.expectFired,
      "the friendly-fire gate holds the finisher beside own structures and releases it otherwise",
    );
    if (!c.expectFired) {
      assert.notEqual(
        bot.harness.internals.state.postSalvoHydrogen,
        null,
        "a friendly-structure rejection holds the finisher for retry",
      );
      assert.equal(bot.intentBuffer.length, 0, "no intent is emitted");
      console.log(JSON.stringify({ label: c.label, verdict: "held for retry" }));
      continue;
    }
    step(bot.intentBuffer);
    bot.intentBuffer.length = 0;
    while (attacker.units(UnitType.HydrogenBomb).length < 1) step();
    console.log(
      JSON.stringify({ label: c.label, verdict: "Hydrogen launched at the cleared cluster" }),
    );
  } finally {
    bot.harness.window.close();
  }
}
