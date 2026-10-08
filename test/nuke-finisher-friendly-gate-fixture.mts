import assert from "node:assert/strict";
import { GameRunner } from "../openfront-engine/src/core/GameRunner";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager";
import { TurnSchema } from "../openfront-engine/src/core/Schemas";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import { engineTestsUtil } from "./helpers/two-player-game.mts";
import {
  createBuildMenu,
  createMaxDifficultyOpponent,
} from "../scripts/headless/opponent-adapter.js";

// The post-salvo Hydrogen finisher fires the largest blast circle the bot
// owns (outer 100). Offensive-reach silo placement deliberately moves our
// silos toward hostile centers, so the finisher must price friendly-fire
// with the same monetary geometry as the anti-SAM aim selector: fire only
// when remaining enemy structure value covers the friendly replacement
// loss. An own forward silo inside the circle holds and clears the
// finisher; without one, the finisher still launches.
for (const c of [
  { forwardSilo: true, expectFired: false, label: "own silo inside the circle" },
  { forwardSilo: false, expectFired: true, label: "no friendly structure inside" },
]) {
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
  // The shared test config stubs every magnitude to {1,1} for tick
  // predictability. Restore the production hydrogen magnitudes so the
  // finisher gate prices blast geometry at real radii (same override as
  // nuke-blast-radius-fixture).
  game.config().nukeMagnitudes = (unitType) => {
    switch (unitType) {
      case UnitType.MIRVWarhead:
        return { inner: 12, outer: 18 };
      case UnitType.AtomBomb:
        return { inner: 12, outer: 30 };
      default:
        return { inner: 80, outer: 100 };
    }
  };
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
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  const runner = new GameRunner(
    game,
    new Executor(game, "finisher-friendly-gate", "attacker"),
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
    const rival = bot.api.game.playerBySmallID(defender.smallID());
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
      assert.equal(
        bot.harness.internals.state.postSalvoHydrogen,
        null,
        "a permanent friendly-structure condition clears the pending finisher",
      );
      assert.equal(bot.intentBuffer.length, 0, "no intent is emitted");
      console.log(JSON.stringify({ label: c.label, verdict: "held and cleared" }));
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
