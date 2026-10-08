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

for (const action of ["launch", "silo-upgrade"]) {
  for (const capture of ["none", "before-probe", "during-probe"]) {
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
    attacker.conquer(source);
    attacker.addGold(100_000_000n);
    defender.conquer(target);
    defender.conquer(game.ref(80, 2));
    const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
    const sam =
      action === "silo-upgrade"
        ? defender.buildUnit(UnitType.SAMLauncher, game.ref(80, 2), {})
        : null;
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
    bot.harness.internals.state.settings.winFixes = true;
    const nuke = bot.nationBot.nukeBehavior;
    const targetPlayer = bot.api.game.playerBySmallID(defender.smallID());
    assert.equal(nuke.isValidNukeTarget(targetPlayer), true);
    if (action === "silo-upgrade") {
      bot.harness.internals.state.nukeWantSlots = {
        need: 2,
        targetSamId: sam!.id(),
        targetTile: target,
        unblockedSiloIds: [silo.id()],
        at: game.ticks(),
      };
      assert.equal(nuke.getRouteEligibleSilos({ targetTile: target }).length, 1);
    }
    if (capture === "before-probe") attacker.conquer(target);
    const nativeBuildables = runner.playerBuildables.bind(runner);
    let probes = 0;
    runner.playerBuildables = (...args) => {
      const result = nativeBuildables(...args);
      const probeTile = action === "launch" ? target : source;
      if (args[1] === game.x(probeTile) && args[2] === game.y(probeTile)) {
        probes++;
        const buildable = result.find(
          (bu) => bu.type === (action === "launch" ? UnitType.AtomBomb : UnitType.MissileSilo),
        );
        assert.ok(buildable, "the native worker exposes the requested buildable");
        if (action === "launch")
          assert.equal(buildable.canBuild, source, "the worker authorizes the launch silo");
        else
          assert.equal(
            buildable.canUpgrade,
            silo.id(),
            "the worker authorizes the actual silo upgrade",
          );
        if (capture === "during-probe") attacker.conquer(target);
      }
      return result;
    };
    const goldBefore = attacker.gold();
    const sent =
      action === "launch"
        ? await nuke.sendNuke(target, UnitType.AtomBomb, targetPlayer)
        : await bot.nationBot.structureBehavior.maybeUpgradeSiloForNukeDemand();
    assert.equal(nuke.isValidNukeTarget(targetPlayer), true, "the rival remains a valid target");
    assert.equal(nuke.isValidNukeDestination(target), capture === "none");
    assert.equal(probes, action === "silo-upgrade" && capture === "before-probe" ? 0 : 1);
    assert.equal(sent, capture === "none");
    const launches = bot.intentBuffer.filter(
      (intent) => intent.type === "build_unit" && intent.unit === UnitType.AtomBomb,
    );
    assert.equal(launches.length, action === "launch" && capture === "none" ? 1 : 0);
    assert.equal(nuke.atomBombsLaunched, launches.length);
    const upgrades = bot.intentBuffer.filter(
      (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
    );
    assert.equal(upgrades.length, action === "silo-upgrade" && capture === "none" ? 1 : 0);
    if (action === "silo-upgrade") {
      if (capture === "none") {
        game.addExecution(executor.createExec({ ...upgrades[0], clientID: "attacker" }));
        game.executeNextTick();
        assert.equal(silo.level(), 2, "the emitted intent upgrades the native silo");
        assert.ok(attacker.gold() < goldBefore, "the native upgrade actually spends gold");
      } else {
        assert.equal(silo.level(), 1);
        assert.equal(attacker.gold(), goldBefore, "obsolete demand spends no gold");
        assert.equal(
          bot.harness.internals.state.nukeWantSlots,
          null,
          "capture clears obsolete nuclear demand",
        );
      }
      assert.equal(launches.length, 0, "the capacity request cannot launch a bomb");
    } else if (capture === "none") {
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
}
console.log("live-engine nuclear territory race fixture passed (6 scenarios)");
