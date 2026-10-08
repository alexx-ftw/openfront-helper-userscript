import assert from "node:assert/strict";
import { GameRunner } from "../../openfront-engine/src/core/GameRunner";
import { Executor } from "../../openfront-engine/src/core/execution/ExecutionManager";
import { TurnSchema } from "../../openfront-engine/src/core/Schemas";
import { PlayerInfo, PlayerType, UnitType } from "../../openfront-engine/src/core/game/Game";
import { setup } from "../../openfront-engine/tests/util/Setup";
import { engineTestsUtil } from "../../test/helpers/two-player-game.mts";
import {
  createBuildMenu,
  createMaxDifficultyOpponent,
} from "../../scripts/headless/opponent-adapter.js";

// Audit reproduction for 69b89b99: it asserts the observed premature cancellation,
// not the desired policy. Turn this into a regression test when fixing the gap.
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
const source = game.ref(1, 1);
const target = game.ref(80, 1);
attacker.addGold(100_000_000n);
attacker.conquer(source);
defender.conquer(target);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
for (let slot = 1; slot < 3; slot++) {
  silo.increaseLevel();
  silo.reloadMissile();
}
const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
sam.increaseLevel();
sam.reloadMissile();
const runner = new GameRunner(game, new Executor(game, "salvo-receipt-gap", "attacker"), (update) =>
  assert.ok(!("errMsg" in update)),
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
  };
  for (let index = 0; index < 2; index++)
    assert.equal(await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, { ...salvo }), true);
  assert.equal(nuke.queueDelayedNukeLaunch(target, UnitType.AtomBomb, rival, 1, salvo), true);
  assert.equal(bot.intentBuffer.length, 2);
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(
    attacker.units(UnitType.AtomBomb).length,
    0,
    "the two admitted intents have not reached native missile creation yet",
  );
  assert.equal(await nuke.processPendingNukeLaunches(), false);
  assert.equal(
    nuke.hasPendingNukeLaunches(),
    false,
    "the legacy validator discards the third Atom before the first two receipts arrive",
  );
  step();
  step();
  assert.equal(
    attacker.units(UnitType.AtomBomb).length,
    2,
    "both prefix intents were valid and actually create native missiles afterwards",
  );
  console.log(
    "receipt-gap reproduced: valid two-Atom prefix, third Atom discarded at tick1 before native receipts",
  );
} finally {
  bot.harness.window.close();
}
