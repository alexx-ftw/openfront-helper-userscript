import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EventBus } from "../openfront-engine/src/core/EventBus";
import { GameRunner } from "../openfront-engine/src/core/GameRunner";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager";
import { decodeClientMessage } from "../openfront-engine/src/core/ZbinWire";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import { engineTestsUtil } from "./helpers/two-player-game.mts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://openfront.io" });
for (const key of [
  "window",
  "document",
  "customElements",
  "HTMLElement",
  "Element",
  "Node",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
  "CSSStyleSheet",
  "MutationObserver",
  "localStorage",
  "WebSocket",
]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
try {
  const { BuildUnitIntentEvent, SendUpgradeStructureIntentEvent, Transport } =
    await import("../openfront-engine/src/client/Transport");
  await import("../openfront-engine/src/client/hud/layers/BuildMenu");
  const game = await setup(
    "big_plains",
    { instantBuild: true },
    [
      new PlayerInfo("attacker", PlayerType.Human, "attacker", "attacker"),
      new PlayerInfo("defender", PlayerType.Human, "defender", "defender"),
    ],
    engineTestsUtil,
  );
  const player = game.player("attacker");
  const source = game.ref(1, 1);
  const target = game.ref(80, 1);
  player.conquer(source);
  const defender = game.player("defender");
  defender.conquer(target);
  const raceTarget = game.ref(80, 2);
  defender.conquer(raceTarget);
  defender.conquer(game.ref(80, 3));
  player.addGold(100_000_000n);
  const silo = player.buildUnit(UnitType.MissileSilo, source, {});
  const pagePlayer = Object.create(player);
  pagePlayer.buildables = async (tile) => player.buildableUnits(tile);
  pagePlayer.totalUnitLevels = (type) =>
    player.units(type).reduce((sum, unit) => sum + unit.level(), 0);
  const menu = dom.window.document.createElement("build-menu") as any;
  const bus = new EventBus();
  const wireMessages = [];
  let socketClosed = false;
  const transport = new Transport({} as any, bus) as any;
  transport.socket = {
    readyState: dom.window.WebSocket.OPEN,
    send: (data) => wireMessages.push(decodeClientMessage(data, undefined)),
    close() {
      socketClosed = true;
    },
  };
  transport.isSessionReady = true;
  const launches = [];
  const upgrades = [];
  bus.on(BuildUnitIntentEvent, (event) => launches.push(event));
  bus.on(SendUpgradeStructureIntentEvent, (event) => upgrades.push(event));
  menu.eventBus = bus;
  menu.uiState = { rocketDirectionUp: true };
  menu.game = {
    myPlayer: () => pagePlayer,
    config: () => game.config(),
  };
  dom.window.document.body.append(menu);
  for (const [type, tile] of [
    [UnitType.AtomBomb, target],
    [UnitType.MissileSilo, source],
  ]) {
    menu.showMenu(tile);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await menu.updateComplete;
    assert.equal(menu.isVisible, true);
    const image = menu.shadowRoot.querySelector(`img[alt="${type}"]`);
    assert.ok(image, "the actual Lit template renders the requested unit");
    const button = image.closest("button");
    assert.equal(button.disabled, false);
    button.click();
    await menu.updateComplete;
    assert.equal(menu.isVisible, false, "the real menu closes after the click");
  }
  assert.equal(launches.length, 1);
  assert.equal(launches[0].unit, UnitType.AtomBomb);
  assert.equal(launches[0].tile, target);
  assert.equal(launches[0].rocketDirectionUp, true);
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].unitId, silo.id());
  assert.equal(upgrades[0].unitType, UnitType.MissileSilo);
  assert.deepEqual(wireMessages[0], {
    type: "intent",
    intent: {
      type: "build_unit",
      unit: UnitType.AtomBomb,
      tile: target,
      rocketDirectionUp: true,
    },
  });
  assert.deepEqual(wireMessages[1], {
    type: "intent",
    intent: {
      type: "upgrade_structure",
      unit: UnitType.MissileSilo,
      unitId: silo.id(),
      amount: 1,
    },
  });
  const runner = new GameRunner(game, new Executor(game, "menuRace", "attacker"), () => {});
  const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
  try {
    bot.attach({ runner, clientID: "attacker" });
    await bot.api.beginTick(bot.pageGame.myPlayer());
    bot.nationBot.player = bot.api.game.myPlayer();
    bot.nationBot.initializeBehaviors();
    bot.harness.internals.state.settings.enabled = true;
    bot.harness.internals.state.settings.winFixes = true;
    bot.harness.current.buildMenu = menu;
    bot.harness.current.eventBus = bus;
    const nuke = bot.nationBot.nukeBehavior;
    const enemy = bot.api.game.playerBySmallID(defender.smallID());
    menu.uiState.rocketDirectionUp = false;
    assert.equal(await nuke.sendNuke(target, UnitType.AtomBomb, enemy), true);
    assert.equal(launches.length, 2, "the bundled bot emits through the actual native menu");
    assert.equal(launches[1].unit, UnitType.AtomBomb);
    assert.equal(launches[1].tile, target);
    assert.equal(
      launches[1].rocketDirectionUp,
      true,
      "the bot's launch uses its forecast direction",
    );
    assert.equal(menu.uiState.rocketDirectionUp, false, "the manual direction is restored");
    assert.equal(nuke.atomBombsLaunched, 1);
    assert.equal(wireMessages.length, 3);
    assert.deepEqual(
      wireMessages[2],
      wireMessages[0],
      "the bot reaches the same native binary intent",
    );
    const nativeBuildables = runner.playerBuildables.bind(runner);
    let raceProbes = 0;
    runner.playerBuildables = (...args) => {
      const result = nativeBuildables(...args);
      if (args[1] === game.x(raceTarget) && args[2] === game.y(raceTarget)) {
        raceProbes++;
        const atom = result.find((bu) => bu.type === UnitType.AtomBomb);
        assert.ok(atom);
        assert.equal(atom.canBuild, source, "the worker response still authorizes the silo");
        player.conquer(raceTarget);
      }
      return result;
    };
    assert.equal(await nuke.sendNuke(raceTarget, UnitType.AtomBomb, enemy), false);
    assert.equal(raceProbes, 1);
    assert.equal(launches.length, 2, "capture prevents the native menu event");
    assert.equal(nuke.atomBombsLaunched, 1, "capture preserves the successful launch count");
    assert.equal(menu.uiState.rocketDirectionUp, false);
    assert.equal(wireMessages.length, 3, "capture cannot send a binary launch frame");
    const sam = defender.buildUnit(UnitType.SAMLauncher, game.ref(80, 3), {});
    const state = bot.harness.internals.state;
    state.nukeWantSlots = {
      need: 2,
      targetSamId: sam.id(),
      targetTile: target,
      unblockedSiloIds: [silo.id()],
      at: game.ticks(),
    };
    assert.equal(await bot.nationBot.structureBehavior.maybeUpgradeSiloForNukeDemand(), true);
    assert.equal(upgrades.length, 2, "shared construction emits through the native menu");
    assert.equal(upgrades[1].unitId, silo.id());
    assert.equal(upgrades[1].unitType, UnitType.MissileSilo);
    assert.equal(wireMessages.length, 4);
    assert.deepEqual(wireMessages[3], wireMessages[1]);
    assert.equal(launches.length, 2, "servicing capacity cannot emit another bomb");
    player.conquer(target);
    assert.equal(await bot.nationBot.structureBehavior.maybeUpgradeSiloForNukeDemand(), false);
    assert.equal(state.nukeWantSlots, null);
    assert.equal(upgrades.length, 2, "obsolete construction demand cannot reach the menu");
    assert.equal(launches.length, 2, "obsolete demand cannot emit a bomb either");
    assert.equal(wireMessages.length, 4, "obsolete demand sends no additional binary frame");
  } finally {
    bot.harness.window.close();
  }
  transport.leaveGame();
  assert.equal(socketClosed, true);
  assert.equal((bus as any).listeners.get(BuildUnitIntentEvent).length, 1);
  assert.equal((bus as any).listeners.get(SendUpgradeStructureIntentEvent).length, 1);
} finally {
  dom.window.close();
}
console.log("native nuclear BuildMenu click fixture passed");
