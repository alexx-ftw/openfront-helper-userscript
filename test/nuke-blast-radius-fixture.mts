import { useProductionNukeMagnitudes } from "./helpers/native-bot-fixture.mts";
import assert from "node:assert/strict";

import { NukeExecution } from "../openfront-engine/src/core/execution/NukeExecution";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { setupTwoPlayerGame } from "./helpers/two-player-game.mts";

// Live-engine ground truth for the auto-bot's missile blast-co-location rule.
// The bot spaces new MissileSilo/SAMLauncher tiles apart using the hydrogen
// OUTER radius (nukeMagnitudes().outer), on the engine contract that a
// detonation deletes every structure strictly within that radius while the
// inner radius only bounds terrain fallout. This fixture detonates a real
// hydrogen bomb among hostile and own cities and asserts exactly that boundary,
// so the placement penalty can never silently drift from engine behavior.
const game = await setupTwoPlayerGame("big_plains");

const defender = game.player("defender");
const attacker = game.player("attacker");

// The shared test config stubs every magnitude to {1,1} for tick
// predictability. Restore the production hydrogen magnitudes so the
// detonation runs the real engine destruction logic at real radii.
useProductionNukeMagnitudes(game);

const outerRadius = game.config().nukeMagnitudes(UnitType.HydrogenBomb).outer;
assert.equal(
  outerRadius,
  100,
  "the engine's hydrogen outer radius anchors the bot's spacing model",
);

const groundZero = game.ref(100, 100);
const cityAtGroundZero = defender.buildUnit(UnitType.City, groundZero, {});
const cityInsideBlast = defender.buildUnit(UnitType.City, game.ref(164, 163), {});
const cityBeyondBlast = defender.buildUnit(UnitType.City, game.ref(179, 179), {});
const ownCityInsideBlast = attacker.buildUnit(UnitType.City, game.ref(185, 100), {});
const ownCityOnBoundary = attacker.buildUnit(UnitType.City, game.ref(0, 100), {});
assert.ok(
  game.euclideanDistSquared(groundZero, game.ref(164, 163)) < outerRadius * outerRadius,
  "the near city sits strictly inside the outer radius",
);
assert.ok(
  game.euclideanDistSquared(groundZero, game.ref(179, 179)) > outerRadius * outerRadius,
  "the far city sits strictly outside the outer radius",
);

const source = game.ref(1, 100);
attacker.conquer(source);
attacker.buildUnit(UnitType.MissileSilo, source, {});
game.addExecution(new NukeExecution(UnitType.HydrogenBomb, attacker, groundZero, null, 1));
for (let tick = 0; tick < 150; tick++) {
  game.executeNextTick();
}

assert.equal(
  cityAtGroundZero.isActive(),
  false,
  "a city at ground zero is destroyed by the hydrogen detonation",
);
assert.equal(
  cityInsideBlast.isActive(),
  false,
  "a city within the outer radius is destroyed even though it is beyond the inner radius",
);
assert.equal(
  cityBeyondBlast.isActive(),
  true,
  "a city beyond the outer radius survives the detonation",
);
assert.equal(
  ownCityInsideBlast.isActive(),
  false,
  "our own city outside the inner radius is still destroyed inside the outer radius",
);
assert.equal(
  ownCityOnBoundary.isActive(),
  true,
  "a friendly city exactly on the outer boundary survives",
);

console.log("nuke blast radius fixture passed");
