import assert from "node:assert/strict";
import { GameRunner } from "../openfront-engine/src/core/GameRunner";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import {
  createBuildMenu,
  createMaxDifficultyOpponent,
} from "../scripts/headless/opponent-adapter.js";
import { engineTestsUtil } from "./helpers/two-player-game.mts";

for (const capture of ["none", "before-probe", "during-probe"]) {
  const game = await setup(
    "big_plains",
    { infiniteGold: true, instantBuild: true },
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
  attacker.conquer(source);
  defender.conquer(target);
  defender.conquer(game.ref(80, 2));
  attacker.buildUnit(UnitType.MissileSilo, source, {});
  const executor = new Executor(game, "nuke-territory-race", "attacker");
  const runner = new GameRunner(game, executor, () => {});
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  bot.attach({ runner, clientID: "attacker" });
  await bot.api.beginTick(bot.pageGame.myPlayer());
  bot.nationBot.player = bot.api.game.myPlayer();
  bot.nationBot.initializeBehaviors();
  assert.equal(bot.nationBot.player.smallID(), attacker.smallID());
  const menu = createBuildMenu(bot);
  bot.harness.current.buildMenu = menu;
  bot.harness.current.eventBus = menu.eventBus;
  bot.harness.internals.state.settings.enabled = true;
  const nuke = bot.nationBot.nukeBehavior;
  const targetPlayer = bot.api.game.playerBySmallID(defender.smallID());
  assert.equal(nuke.isValidNukeTarget(targetPlayer), true);
  if (capture === "before-probe") attacker.conquer(target);
  const nativeBuildables = runner.playerBuildables.bind(runner);
  let probes = 0;
  runner.playerBuildables = (...args) => {
    const result = nativeBuildables(...args);
    if (args[1] === game.x(target) && args[2] === game.y(target)) {
      probes++;
      const atom = result.find((bu) => bu.type === UnitType.AtomBomb);
      assert.ok(atom, "the native worker exposes the Atom buildable");
      assert.equal(atom.canBuild, source, "the worker authorizes the launch silo");
      if (capture === "during-probe") attacker.conquer(target);
    }
    return result;
  };
  const sent = await nuke.sendNuke(target, UnitType.AtomBomb, targetPlayer);
  assert.equal(nuke.isValidNukeTarget(targetPlayer), true, "the rival remains a valid target");
  assert.equal(nuke.isValidNukeDestination(target), capture === "none");
  assert.equal(probes, 1, "the real worker probe must run");
  assert.equal(sent, capture === "none");
  const launches = bot.intentBuffer.filter(
    (intent) => intent.type === "build_unit" && intent.unit === UnitType.AtomBomb,
  );
  assert.equal(launches.length, capture === "none" ? 1 : 0);
  assert.equal(nuke.atomBombsLaunched, launches.length);
  if (capture === "none") {
    game.addExecution(executor.createExec({ ...launches[0], clientID: "attacker" }));
    game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();
    assert.equal(
      attacker.units(UnitType.AtomBomb).length,
      1,
      "the emitted intent launches a native missile",
    );
  } else {
    assert.equal(game.owner(target).smallID(), attacker.smallID());
    assert.equal(attacker.units(UnitType.AtomBomb).length, 0);
  }
  bot.harness.window.close();
}
console.log("live-engine nuclear territory race fixture passed (3 scenarios)");
