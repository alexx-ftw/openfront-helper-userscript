import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EventBus } from "../openfront-engine/src/core/EventBus";
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
]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
try {
  const { BuildUnitIntentEvent, SendUpgradeStructureIntentEvent } =
    await import("../openfront-engine/src/client/Transport");
  await import("../openfront-engine/src/client/hud/layers/BuildMenu");
  const game = await setup(
    "big_plains",
    { instantBuild: true },
    [new PlayerInfo("attacker", PlayerType.Human, "attacker", "attacker")],
    engineTestsUtil,
  );
  const player = game.player("attacker");
  const source = game.ref(1, 1);
  const target = game.ref(80, 1);
  player.conquer(source);
  player.addGold(100_000_000n);
  const silo = player.buildUnit(UnitType.MissileSilo, source, {});
  const pagePlayer = Object.create(player);
  pagePlayer.buildables = async (tile) => player.buildableUnits(tile);
  pagePlayer.totalUnitLevels = (type) =>
    player.units(type).reduce((sum, unit) => sum + unit.level(), 0);
  const menu = dom.window.document.createElement("build-menu") as any;
  const bus = new EventBus();
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
} finally {
  dom.window.close();
}
console.log("native nuclear BuildMenu click fixture passed");
