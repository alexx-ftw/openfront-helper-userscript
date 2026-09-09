import assert from "node:assert/strict";
import {
  createBuildMenu,
  createBundledOpponentHarness,
  playersShareSide,
} from "../scripts/headless/opponent-adapter.js";
import { GameMode, PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import { engineTestsUtil, setupTwoPlayerGame } from "./helpers/two-player-game.mts";

const ffa = await setupTwoPlayerGame("big_plains");
const attacker = ffa.player("attacker");
const defender = ffa.player("defender");
assert.equal(playersShareSide(attacker, defender), false, "null teams are not allies");
assert.equal(playersShareSide(attacker, attacker), true, "our own beachhead is recaptured");
assert.equal(
  playersShareSide(attacker, ffa.playerBySmallID(0)),
  false,
  "neutral ground is not a friendly recapture",
);
assert.equal(playersShareSide(null, defender), false);
const teamGame = await setup(
  "big_plains",
  { gameMode: GameMode.Team, playerTeams: 2 },
  Array.from({ length: 4 }, (_, i) => new PlayerInfo(`p${i}`, PlayerType.Human, null, `p${i}`)),
  engineTestsUtil,
);
const me = teamGame.player("p0");
const teammate = teamGame.allPlayers().find((p) => p !== me && p.team() === me.team());
const enemy = teamGame.allPlayers().find((p) => p.team() !== me.team());
assert.ok(teammate);
assert.ok(enemy);
assert.equal(playersShareSide(me, teammate), true);
assert.equal(playersShareSide(me, enemy), false);

const harness = createBundledOpponentHarness();
const bot = { harness, game: {}, clientID: "build-fixture", intentBuffer: [] };
const menu = createBuildMenu(bot);
harness.current.buildMenu = menu;
harness.current.eventBus = menu.eventBus;
const buildCtor = harness.internals.discoverCtors(menu.eventBus).buildUnit;
assert.equal(typeof buildCtor, "function", "headless exposes the native build event constructor");
menu.eventBus.emit(new buildCtor("City", 0, false));
assert.deepEqual(
  bot.intentBuffer,
  [{ type: "build_unit", unit: "City", tile: 0, rocketDirectionUp: false }],
  "a direct zero-tile build must not be misclassified as a spawn intent",
);
bot.intentBuffer.length = 0;
attacker.conquer(ffa.ref(1, 1));
defender.conquer(ffa.ref(2, 1));
const request = attacker.createAllianceRequest(defender);
assert.ok(request);
request.accept();
assert.equal(attacker.isAlliedWith(defender), true);
const diplomacy = new harness.internals.AllianceBehavior({}, ffa, attacker, {});
assert.equal(diplomacy.betray(defender), true, "the bundled bot can break a real alliance");
assert.deepEqual(bot.intentBuffer, [{ type: "breakAlliance", recipient: defender.id() }]);
bot.intentBuffer.length = 0;
const cancelCtor = harness.internals.discoverCtors(menu.eventBus).cancelAttack;
assert.equal(typeof cancelCtor, "function", "the bot can discover attack cancellation");
menu.eventBus.emit(new cancelCtor("attack-fixture"));
assert.deepEqual(bot.intentBuffer, [{ type: "cancel_attack", attackID: "attack-fixture" }]);
assert.equal(
  createBuildMenu(bot).eventBus,
  menu.eventBus,
  "successive decisions must preserve native event-constructor identity",
);
for (let tick = 0; tick < 10; tick++) {
  let resumed = false;
  harness.window.setTimeout(() => {
    resumed = true;
  }, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumed, true, "a cooperative slice must resume before the next engine tick");
}
let cancelledRan = false;
const cancelled = harness.window.setTimeout(() => {
  cancelledRan = true;
}, 0);
harness.window.clearTimeout(cancelled);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(cancelledRan, false, "cancelled cooperative callbacks must not execute");
harness.window.close();
console.log("headless cooperative timer checks passed");
