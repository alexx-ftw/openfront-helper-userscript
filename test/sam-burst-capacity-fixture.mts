import assert from "node:assert/strict";

import { NukeExecution } from "../openfront-engine/src/core/execution/NukeExecution";
import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution";
import { UnitType } from "../openfront-engine/src/core/game/Game";
import { setupTwoPlayerGame } from "./helpers/two-player-game.mts";

// Live-engine validation of the auto-bot's SAM-overwhelm arithmetic. The bot's
// createSamOverwhelmPlan sizes a penetrating salvo as sum(coveringSamLevels)+1
// atoms on the theory that a level-N SAM holds N in-flight interceptors and
// only reloads a slot after SAMCooldown()=90 ticks. This fixture drives a real
// level-2 SAM against a real four-bomb salvo (actual NukeExecutions flying
// real trajectories) and asserts the engine enforces exactly that capacity:
// two bombs are shot down, two land, and one slot frees up only after a full
// cooldown.
const game = await setupTwoPlayerGame("big_plains");

const defender = game.player("defender");
const attacker = game.player("attacker");

// The launcher sits on the flight path from the attacker's silo to the target.
// increaseLevel() parks a spent slot in the missile queue; reloadMissile()
// clears it so the level-2 launcher starts with both interceptors ready.
const sam = defender.buildUnit(UnitType.SAMLauncher, game.ref(50, 1), {});
sam.increaseLevel();
sam.reloadMissile();
assert.equal(sam.level(), 2, "the fixture SAM is level 2 (two interceptor slots)");
game.addExecution(new SAMLauncherExecution(defender, null, sam));

const source = game.ref(1, 1);
attacker.conquer(source);
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
// Level 4 with all four launch slots ready, mirroring the bot's multi-slot
// overwhelm salvo.
for (let index = 0; index < 3; index++) {
  silo.increaseLevel();
  silo.reloadMissile();
}

const target = game.ref(60, 1);
for (let index = 0; index < 4; index++) {
  game.addExecution(new NukeExecution(UnitType.AtomBomb, attacker, target, null, 1));
}
game.executeNextTick();
game.executeNextTick();

const salvo = attacker.units(UnitType.AtomBomb);
assert.equal(salvo.length, 4, "all four salvo bombs are in flight");

for (let tick = 0; tick < 75; tick++) {
  game.executeNextTick();
}

const intercepted = salvo.filter((bomb) => bomb.wasDestroyedByEnemy());
const landed = salvo.filter((bomb) => !bomb.isActive() && !bomb.wasDestroyedByEnemy());
assert.equal(
  intercepted.length,
  2,
  "a level-2 SAM intercepts exactly two bombs of a same-window salvo before saturating",
);
assert.equal(
  landed.length,
  2,
  "the bombs beyond the interceptor capacity fly through and detonate",
);
assert.equal(
  sam.missileTimerQueue().length,
  2,
  "both interceptor slots remain occupied after the opening exchange",
);
assert.equal(
  sam.isInCooldown(),
  true,
  "the saturated launcher is in cooldown while the remaining bombs fly through",
);

// The sustained rate the bot's defense model assumes: one slot per launcher
// level per 90-tick cooldown. Advance to the first reload, then confirm a
// fresh bomb is intercepted again.
const launchTick = sam.missileTimerQueue()[0];
// game.ticks() reports the last executed tick + 1; the cooldown expires while
// executing tick launchTick + 90, so advance until that tick has run.
while (game.ticks() <= launchTick + 90) {
  game.executeNextTick();
}
assert.equal(
  sam.missileTimerQueue().length,
  1,
  "exactly one interceptor slot reloads after one full SAM cooldown",
);

// Free a silo slot directly: this fixture validates the launcher's burst
// capacity, not the silo's own cadence.
while (silo.isInCooldown()) {
  silo.reloadMissile();
}
game.addExecution(new NukeExecution(UnitType.AtomBomb, attacker, target, null, 1));
game.executeNextTick();
game.executeNextTick();
const followUp = attacker.units(UnitType.AtomBomb).find((bomb) => bomb.isActive());
assert.ok(followUp !== undefined, "the follow-up bomb is in flight");
for (let tick = 0; tick < 75; tick++) {
  game.executeNextTick();
}
assert.equal(
  followUp.wasDestroyedByEnemy(),
  true,
  "after one cooldown the reloaded launcher intercepts the next single bomb",
);

console.log("SAM burst capacity fixture passed");
