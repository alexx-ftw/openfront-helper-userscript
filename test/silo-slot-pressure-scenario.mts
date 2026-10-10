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

// End-to-end SAM-demand scenario: a real hostile SAM target requests one more
// level of reachable silo capacity, and the structures planner must upgrade
// through the real build menu. Busy reloads alone do not trigger the generic
// slot-pressure lane.
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
silo.increaseLevel();
silo.reloadMissile();
silo.reloadMissile();
const targetSam = defender.buildUnit(UnitType.SAMLauncher, target, {});
defender.buildUnit(UnitType.City, target, {});
const runner = new GameRunner(
  game,
  new Executor(game, "silo-slot-pressure-scenario", "attacker"),
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
  const structures = bot.nationBot.structureBehavior;
  const rival = bot.api.game.playerBySmallID(defender.smallID());
  const flight = nuke.getAvailableSiloEntries(
    [bot.nationBot.player.units(UnitType.MissileSilo)[0]],
    target,
    new Set(),
  )[0].flightTicks;
  const salvo = {
    salvoId: 7,
    targetTile: target,
    targetSamId: null,
    plannedCoveringLevel: 0,
    flightTicks: flight,
  };
  // Launch both slots: every silo shot is now busy reloading.
  for (let index = 0; index < 2; index++) {
    assert.equal(await nuke.sendNuke(target, UnitType.AtomBomb, rival, 0, { ...salvo }), true);
  }
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  step();
  step();
  assert.equal(attacker.units(UnitType.AtomBomb).length, 2, "both slots launched");
  assert.equal(silo.missileTimerQueue().length, 2, "both slots are busy reloading");

  // Negative control: busy slots alone are not slot pressure.
  assert.equal(
    await structures.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "no upgrade without a nuclear capacity request",
  );

  // A live SAM target needs one additional reachable launch slot.
  const state = bot.harness.internals.state;
  state.nukeWantSlots = {
    need: 3,
    targetSamId: targetSam.id(),
    targetTile: target,
    unblockedSiloIds: [silo.id()],
    at: game.ticks(),
  };
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    true,
    "a valid SAM target upgrades a route-eligible silo through the real menu",
  );
  const siloUpgrades = bot.intentBuffer.filter(
    (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(siloUpgrades.length, 1, "exactly one silo upgrade intent is emitted");
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(silo.level(), 3, "the accepted upgrade adds the required capacity level");
} finally {
  bot.harness.window.close();
}
console.log("silo slot pressure end-to-end scenario passed");
