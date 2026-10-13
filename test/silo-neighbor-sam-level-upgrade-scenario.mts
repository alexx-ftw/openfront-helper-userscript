import {
  setupNativeGame,
  attachNativeBot,
  createNativeLoop,
  loadUnitToLevel,
  useProductionNukeMagnitudes,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

const game = await setupNativeGame(["attacker", "rich", "neighbour"]);
const attacker = game.player("attacker");
const rich = game.player("rich");
const neighbour = game.player("neighbour");
const source = game.ref(1, 1);
const cityTile = game.ref(80, 1);
const samTile = game.ref(83, 1);
useProductionNukeMagnitudes(game);
attacker.addGold(100_000_000n);
attacker.conquer(source);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
loadUnitToLevel(silo, 2);
rich.conquer(cityTile);
const valuableCity = rich.buildUnit(UnitType.City, cityTile, {});
for (let level = 1; level < 3; level++) valuableCity.increaseLevel();
neighbour.conquer(samTile);
const neighbourSam = neighbour.buildUnit(UnitType.SAMLauncher, samTile, {});
loadUnitToLevel(neighbourSam, 2);

const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
const { runner, step } = createNativeLoop(
  game,
  "silo-neighbor-sam-level-upgrade-scenario",
  (update) => bot.applyGameUpdate(update),
);
try {
  await attachNativeBot(bot, runner);
  step();
  bot.nationBot.initializeBehaviors();
  const state = bot.harness.internals.state;
  state.nukeWantSlots = null;
  bot.intentBuffer.length = 0;
  assert.equal(silo.level(), 2, "the starting Silo has two loaded launch slots");
  assert.equal(neighbourSam.level(), 2, "the defending SAM is level 2");
  await bot.nationBot.nukeBehavior.maybeSendNuke();

  assert.equal(
    state.nukeWantSlots?.targetSamId,
    neighbourSam.id(),
    "normal target selection retains the neighbour SAM covering the rich target",
  );
  assert.equal(state.nukeWantSlots?.need, 3, "a level-2 SAM requires three Atom slots");
  const aim = state.nukeWantSlots.targetTile;
  const blastRadius = game.config().nukeMagnitudes(UnitType.AtomBomb).outer;
  assert.ok(
    game.euclideanDistSquared(aim, valuableCity.tile()) < blastRadius ** 2,
    "the SAM-demand aim includes the selected rich target's City",
  );
  assert.equal(
    bot.intentBuffer.filter(
      (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
    ).length,
    1,
    "normal nuke selection emits one Silo upgrade intent",
  );

  step(bot.intentBuffer);
  assert.equal(silo.level(), 3, "the accepted upgrade adds the third required launch slot");
} finally {
  bot.harness.window.close();
}
console.log("neighbour-SAM level-2 Silo-upgrade scenario passed");
