import assert from "node:assert/strict";
import { GameRunner } from "../openfront-engine/src/core/GameRunner";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager";
import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { TurnSchema } from "../openfront-engine/src/core/Schemas";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import { engineTestsUtil } from "./helpers/two-player-game.mts";
import {
  createBuildMenu,
  createMaxDifficultyOpponent,
} from "../scripts/headless/opponent-adapter.js";

// Reload before impact alone does not prove that a real SAM can intercept in time.
for (const reloadOffset of [-1, 2]) {
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
  const source = game.ref(1, 80);
  const target = game.ref(80, 1);
  attacker.addGold(100_000_000n);
  attacker.conquer(source);
  defender.conquer(target);
  defender.conquer(game.ref(180, 180));
  attacker.buildUnit(UnitType.MissileSilo, source, {});
  const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
  sam.launch();
  game.addExecution(new SAMLauncherExecution(defender, null, sam));
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  const runner = new GameRunner(
    game,
    new Executor(game, "reload-boundary", "attacker"),
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
    const flight = nuke.getAvailableSiloEntries(
      [bot.nationBot.player.units(UnitType.MissileSilo)[0]],
      target,
      new Set([sam.id()]),
    )[0].flightTicks;
    const reloadTick = game.config().SAMCooldown();
    while (game.ticks() < reloadTick - flight + reloadOffset) step();
    await bot.api.beginTick(bot.pageGame.myPlayer());
    const predictedImpact = game.ticks() + flight;
    const salvo = { salvoId: 991, targetTile: target, targetSamId: sam.id(), flightTicks: flight };
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
    assert.equal(sam.missileTimerQueue().length, reloadOffset < 0 ? 0 : 1);
    assert.equal(missile.isActive(), false);
  } finally {
    bot.harness.window.close();
  }
}
