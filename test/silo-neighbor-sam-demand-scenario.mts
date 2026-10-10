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

// End-to-end neighbour-SAM scenario: the valuable target owns no SAM, but a
// neighbouring player's launcher covers its City. The SAM-overwhelm demand must
// form against that neighbour's SAM and upgrade the Silo through the real menu.
const game = await setup(
  "big_plains",
  { instantBuild: true },
  [
    new PlayerInfo("attacker", PlayerType.Human, "attacker", "attacker"),
    new PlayerInfo("rich", PlayerType.Human, "rich", "rich"),
    new PlayerInfo("neighbour", PlayerType.Human, "neighbour", "neighbour"),
  ],
  engineTestsUtil,
);
const attacker = game.player("attacker");
const rich = game.player("rich");
const neighbour = game.player("neighbour");
const source = game.ref(1, 1);
const cityTile = game.ref(80, 1);
const samTile = game.ref(83, 1);
attacker.addGold(100_000_000n);
attacker.conquer(source);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
rich.conquer(cityTile);
const valuableCity = rich.buildUnit(UnitType.City, cityTile, {});
const runner = new GameRunner(
  game,
  new Executor(game, "silo-neighbor-sam-demand-scenario", "attacker"),
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
  const state = bot.harness.internals.state;
  const rival = bot.api.game.playerBySmallID(rich.smallID());

  // Negative control: a SAM-free target without any covering SAM forms no demand.
  await nuke.maybeDestroyEnemySam(rival);
  assert.equal(
    state.nukeWantSlots ?? null,
    null,
    "no demand without any SAM coverage",
  );

  // The neighbour's level-1 SAM covers the rich City: the demand must pin that
  // SAM, price two Atom slots, and upgrade the level-1 Silo (one slot short).
  neighbour.conquer(samTile);
  const neighbourSam = neighbour.buildUnit(UnitType.SAMLauncher, samTile, {});
  await nuke.maybeDestroyEnemySam(rival);
  assert.equal(
    state.nukeWantSlots?.targetSamId,
    neighbourSam.id(),
    "the demand pins the neighbour SAM covering the rich target",
  );
  assert.equal(
    state.nukeWantSlots?.need,
    2,
    "the level-1 neighbour SAM requires two Atom slots",
  );
  const upgrades = bot.intentBuffer.filter(
    (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(
    upgrades.length,
    1,
    "neighbour SAM coverage emits one Silo upgrade intent",
  );
  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(
    silo.level(),
    2,
    "the accepted upgrade adds the required launch slot",
  );
} finally {
  bot.harness.window.close();
}
console.log("neighbour-SAM Silo-upgrade end-to-end scenario passed");
