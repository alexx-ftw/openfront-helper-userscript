import {
  setupNativeGameFromMap16x,
  attachNativeBot,
  createNativeLoop,
  loadUnitToLevel,
  useProductionNukeMagnitudes,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

const mapID = process.argv[2];
assert.ok(mapID === "baikalnukewars" || mapID === "luna", "run against baikalnukewars or luna");

const game = await setupNativeGameFromMap16x(mapID, ["attacker", "rich", "neighbour"]);
const attacker = game.player("attacker");
const rich = game.player("rich");
const neighbour = game.player("neighbour");
let cityTile = null;
let samTile = null;
for (let y = 0; y < game.height() && cityTile === null; y++) {
  for (let x = 0; x < game.width(); x++) {
    const candidate = game.ref(x, y);
    if (!game.isLand(candidate)) continue;
    const right = x + 1 < game.width() ? game.ref(x + 1, y) : null;
    const below = y + 1 < game.height() ? game.ref(x, y + 1) : null;
    const adjacent =
      right && game.isLand(right) ? right : below && game.isLand(below) ? below : null;
    if (adjacent !== null) {
      cityTile = candidate;
      samTile = adjacent;
      break;
    }
  }
}
assert.ok(
  cityTile !== null && samTile !== null,
  `${mapID} has adjacent land for the defense fixture`,
);

let source = null;
let farthest = -1;
for (let y = 0; y < game.height(); y++) {
  for (let x = 0; x < game.width(); x++) {
    const candidate = game.ref(x, y);
    if (!game.isLand(candidate)) continue;
    const distance = game.euclideanDistSquared(candidate, cityTile);
    if (distance > farthest) {
      source = candidate;
      farthest = distance;
    }
  }
}
assert.ok(source !== null && source !== cityTile && source !== samTile);

useProductionNukeMagnitudes(game);
attacker.addGold(100_000_000n);
attacker.conquer(source);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
loadUnitToLevel(silo, 2);
rich.conquer(cityTile);
const valuableCity = rich.buildUnit(UnitType.City, cityTile, {});
loadUnitToLevel(valuableCity, 3);
neighbour.conquer(samTile);
const neighbourSam = neighbour.buildUnit(UnitType.SAMLauncher, samTile, {});
loadUnitToLevel(neighbourSam, 2);

const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
const { runner, step } = createNativeLoop(game, `nuke-map16x-silo-${mapID}`, (update) =>
  bot.applyGameUpdate(update),
);
try {
  await attachNativeBot(bot, runner);
  step();
  const state = bot.harness.internals.state;
  state.nukeWantSlots = null;
  bot.intentBuffer.length = 0;

  await bot.nationBot.nukeBehavior.maybeSendNuke();

  assert.equal(state.nukeWantSlots?.targetSamId, neighbourSam.id());
  assert.equal(state.nukeWantSlots?.need, 3, `${mapID}: level-2 SAM needs three launch slots`);
  const aim = state.nukeWantSlots.targetTile;
  const blastRadius = game.config().nukeMagnitudes(UnitType.AtomBomb).outer;
  assert.ok(
    game.euclideanDistSquared(aim, valuableCity.tile()) < blastRadius ** 2,
    `${mapID}: normal target selection aims through the SAM at the valuable City`,
  );
  assert.equal(
    bot.intentBuffer.filter(
      (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
    ).length,
    1,
    `${mapID}: the selected target causes the Silo upgrade`,
  );
  step(bot.intentBuffer);
  assert.equal(silo.level(), 3, `${mapID}: the Silo reaches the level required for three shots`);
} finally {
  bot.harness.window.close();
}
console.log(`${mapID} map16x SAM-defense Silo-upgrade scenario passed`);
