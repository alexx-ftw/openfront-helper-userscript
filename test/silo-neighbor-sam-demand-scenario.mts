import {
  setupNativeGame,
  attachNativeBot,
  createNativeLoop,
  useProductionNukeMagnitudes,
} from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { createMaxDifficultyOpponent } from "../scripts/headless/opponent-adapter.js";

// End-to-end neighbour-SAM scenario: the valuable target owns no SAM, but a
// neighbouring player's launcher covers its City. The SAM-overwhelm demand must
// form against that neighbour's SAM and upgrade the Silo through the real menu.
const game = await setupNativeGame(["attacker", "rich", "neighbour"]);
const attacker = game.player("attacker");
const rich = game.player("rich");
const neighbour = game.player("neighbour");
const source = game.ref(1, 1);
const cityTile = game.ref(80, 1);
const samTile = game.ref(83, 1);
const decoyCityTile = game.ref(140, 1);
useProductionNukeMagnitudes(game);
attacker.addGold(100_000_000n);
attacker.conquer(source);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
rich.conquer(cityTile);
const valuableCity = rich.buildUnit(UnitType.City, cityTile, {});
for (let level = 1; level < 4; level++) valuableCity.increaseLevel();
const { runner, step } = createNativeLoop(game, "silo-neighbor-sam-demand-scenario", (update) =>
  bot.applyGameUpdate(update),
);
const bot = createMaxDifficultyOpponent({ clientID: "attacker" });
try {
  const { menu, nuke } = await attachNativeBot(bot, runner);
  const state = bot.harness.internals.state;
  const rival = bot.api.game.playerBySmallID(rich.smallID());

  // Negative control: a SAM-free target without any covering SAM forms no demand.
  await nuke.maybeDestroyEnemySam(rival);
  assert.equal(state.nukeWantSlots ?? null, null, "no demand without any SAM coverage");

  // The neighbour's level-1 SAM covers the rich City: the demand must pin that
  // SAM, price two Atom slots, and upgrade the level-1 Silo (one slot short).
  neighbour.conquer(samTile);
  const neighbourSam = neighbour.buildUnit(UnitType.SAMLauncher, samTile, {});
  neighbour.conquer(decoyCityTile);
  const decoyCity = neighbour.buildUnit(UnitType.City, decoyCityTile, {});
  decoyCity.increaseLevel();
  decoyCity.increaseLevel();
  // gameApi caches unit snapshots per authoritative tick; a launcher built
  // mid-tick is only observable after the next one, like in a real match.
  step();
  await nuke.maybeDestroyEnemySam(rival);
  assert.equal(
    state.nukeWantSlots?.targetSamId,
    neighbourSam.id(),
    "the demand pins the neighbour SAM covering the rich target",
  );
  assert.equal(state.nukeWantSlots?.need, 2, "the level-1 neighbour SAM requires two Atom slots");
  const aim = state.nukeWantSlots.targetTile;
  const blastRadius = game.config().nukeMagnitudes(UnitType.AtomBomb).outer;
  assert.ok(
    game.euclideanDistSquared(aim, valuableCity.tile()) < blastRadius ** 2,
    "the SAM-demand aim includes the selected rich target's City",
  );
  assert.ok(
    game.euclideanDistSquared(aim, decoyCity.tile()) >= blastRadius ** 2,
    "the aim does not follow the neighbour's valuable decoy away from the selected target",
  );
  const upgrades = bot.intentBuffer.filter(
    (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(upgrades.length, 1, "neighbour SAM coverage emits one Silo upgrade intent");

  // Keep the direct-call assertions above, then start a clean decision through
  // the production selector with the same native game state.
  state.nukeWantSlots = null;
  bot.intentBuffer.length = 0;
  bot.nationBot.initializeBehaviors();
  const normalNuke = bot.nationBot.nukeBehavior;
  assert.equal(state.nukeWantSlots, null, "normal target selection starts without SAM demand");
  await normalNuke.maybeSendNuke();
  assert.equal(
    state.nukeWantSlots?.targetSamId,
    neighbourSam.id(),
    "normal target selection reaches the neighbour SAM covering the rich target",
  );
  assert.equal(state.nukeWantSlots?.need, 2, "the selected neighbour SAM still needs two slots");
  const normalAim = state.nukeWantSlots.targetTile;
  assert.ok(
    game.euclideanDistSquared(normalAim, valuableCity.tile()) < blastRadius ** 2,
    "normal target selection aims the SAM demand at the selected rich City",
  );
  assert.ok(
    game.euclideanDistSquared(normalAim, decoyCity.tile()) >= blastRadius ** 2,
    "normal target selection does not follow the neighbour's decoy City",
  );
  const normalUpgrades = bot.intentBuffer.filter(
    (intent) => intent.type === "upgrade_structure" && intent.unit === UnitType.MissileSilo,
  );
  assert.equal(normalUpgrades.length, 1, "normal nuke selection emits one Silo upgrade intent");

  step(bot.intentBuffer);
  bot.intentBuffer.length = 0;
  assert.equal(silo.level(), 2, "the accepted normal-path upgrade adds the required launch slot");
} finally {
  bot.harness.window.close();
}
console.log("neighbour-SAM Silo-upgrade end-to-end scenario passed");
