// Real-engine gate checks for the upstream 34a8fe723 targeting helpers:
// enemyLandBlastCoverage and blastHitsFriendlyLand run against the wrapped
// game API on a live map, proving the grid math (not just the unit stubs)
// distinguishes enemy land from friendly/water land through the adapter.

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
attacker.addGold(100_000_000n);
defender.addGold(100_000_000n);

// Two well-separated blocks: the attacker owns everything around its center
// tile, the defender everything around its own — no shared borders, so blast
// sampling at each center sees only one owner's land.
const ownCenter = game.ref(30, 30);
const enemyCenter = game.ref(80, 30);
for (let y = 12; y <= 48; y++) {
  for (let x = 12; x <= 48; x++) attacker.conquer(game.ref(x, y));
}
for (let y = 12; y <= 48; y++) {
  for (let x = 62; x <= 98; x++) defender.conquer(game.ref(x, y));
}
attacker.buildUnit(UnitType.City, ownCenter, {});

const runner = new GameRunner(
  game,
  new Executor(game, "nuke-targeting-gates-fixture", "attacker"),
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
  const wrappedEnemyCenter = bot.api.game.ref(
    game.x(enemyCenter),
    game.y(enemyCenter),
  );
  const wrappedOwnCenter = bot.api.game.ref(
    game.x(ownCenter),
    game.y(ownCenter),
  );

  // A blast centered deep inside the defender's block samples only enemy land.
  const enemyCoverage = nuke.enemyLandBlastCoverage(
    wrappedEnemyCenter,
    UnitType.AtomBomb,
  );
  assert.ok(
    enemyCoverage >= 0.9,
    `a blast inside the enemy block is nearly all enemy land (got ${enemyCoverage})`,
  );
  // The same blast over the attacker's own block samples zero enemy land.
  const ownCoverage = nuke.enemyLandBlastCoverage(
    wrappedOwnCenter,
    UnitType.AtomBomb,
  );
  assert.ok(
    ownCoverage <= 0.1,
    `a blast inside the attacker's own block is not enemy land (got ${ownCoverage})`,
  );
  assert.ok(
    enemyCoverage > ownCoverage,
    "enemy-land coverage separates the two territories",
  );

  // The whole-blast friendly-land filter trips on the attacker's own city
  // block and stays clear over the defender's block.
  assert.equal(
    nuke.blastHitsFriendlyLand(wrappedOwnCenter, UnitType.AtomBomb),
    true,
    "a blast over the attacker's own city block hits friendly land",
  );
  assert.equal(
    nuke.blastHitsFriendlyLand(wrappedEnemyCenter, UnitType.AtomBomb),
    false,
    "a blast deep inside the enemy block hits nothing friendly",
  );

  // No warheads in flight in this scenario: nothing suppresses the tile.
  assert.equal(
    nuke.isNukeAlreadyLandingNear(wrappedEnemyCenter, UnitType.AtomBomb),
    false,
    "with no warheads in flight the enemy-block tile is not suppressed",
  );
  step();
} finally {
  bot.harness.window.close();
}
console.log("nuke targeting gates real-engine fixture passed");

