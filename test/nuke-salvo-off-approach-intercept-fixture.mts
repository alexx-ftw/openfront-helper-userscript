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

// A hostile SAM off the final approach whose slot reloads before the last
// arrival still intercepts natively (fires on the trajectory's terminal
// window). Travel-only salvo viability must keep blocking the salvo, and the
// counterfactual shot must really be intercepted, not detonate: this pins
// the 2026-10-08 refutation of the unreachable-reload-overreject experiment.
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
const sam = defender.buildUnit(UnitType.SAMLauncher, game.ref(86, 3), {});
sam.launch();
game.addExecution(new SAMLauncherExecution(defender, null, sam));
const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
const runner = new GameRunner(
  game,
  new Executor(game, "off-approach-intercept", "attacker"),
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
  const launchTick = game.config().SAMCooldown() - flight + 6;
  while (game.ticks() < launchTick) step();
  await bot.api.beginTick(bot.pageGame.myPlayer());
  const salvo = { salvoId: 777, targetTile: target, targetSamId: sam.id(), flightTicks: flight };
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
