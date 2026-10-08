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

// Prior-pass prefixes need receipts; a freshly validated due batch can emit together.
for (const prefixCount of [0, 2]) {
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
    step();
    step();
    assert.equal(attacker.units(UnitType.AtomBomb).length, 3);
    assert.equal(nuke.hasPendingNukeLaunches(), false);
    console.log("native salvo receipt-gap regression passed");
  } finally {
    bot.harness.window.close();
  }
}
