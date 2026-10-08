import assert from "node:assert/strict";
import { GameRunner } from "../../openfront-engine/src/core/GameRunner";
import { Executor } from "../../openfront-engine/src/core/execution/ExecutionManager";
import { SAMLauncherExecution } from "../../openfront-engine/src/core/execution/SAMLauncherExecution";
import { TurnSchema } from "../../openfront-engine/src/core/Schemas";
import { PlayerInfo, PlayerType, UnitType } from "../../openfront-engine/src/core/game/Game";
import { setup } from "../../openfront-engine/tests/util/Setup";
import { engineTestsUtil } from "../../test/helpers/two-player-game.mts";
import {
  createBuildMenu,
  createMaxDifficultyOpponent,
} from "../../scripts/headless/opponent-adapter.js";

// Production credits a cooling SAM slot as available once its reload tick is
// before the travel-only arrival. This control places the SAM off the final
// approach so the reload happens but the interceptor can never reach in time.
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
  new Executor(game, "unreachable-reload", "attacker"),
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
    "travel-only viability rejects the shot (documents the over-rejection)",
  );
  assert.equal(nuke.hasPendingNukeLaunches(), false);
  assert.equal(await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, salvo), true);
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  while (attacker.units(UnitType.AtomBomb).length < 1) step();
  const missile = attacker.units(UnitType.AtomBomb)[0];
  bot.applyGameUpdate({ packedMotionPlans: game.drainPackedMotionPlans() });
  const plan = bot.api.game.motionPlans().get(missile.id());
  assert.ok(plan);
  while (missile.isActive()) step();
  assert.equal(
    game.units(UnitType.SAMMissile).length,
    0,
    "the SAM never even attempts an interception",
  );
  assert.equal(missile.isActive(), false, "the Atom detonates on the target");
  // Secondary discovery: the detonation 6.3 tiles away does NOT destroy this
  // SAM, although the aim planner models Atom outer radius (30) as lethal.
  assert.equal(
    sam.isActive(),
    true,
    "characterization: an Atom 6.3 tiles away leaves the SAM alive",
  );
  console.log(
    JSON.stringify({
      launchTick,
      flight,
      impact: game.ticks(),
      reload: game.config().SAMCooldown(),
      verdict: "production rejected a clean penetration; blast left the SAM alive",
    }),
  );
  console.log(
    JSON.stringify({
      launchTick,
      flight,
      impact: game.ticks(),
      reload: game.config().SAMCooldown(),
      verdict: "production rejected a clean penetration",
    }),
  );
} finally {
  bot.harness.window.close();
}
