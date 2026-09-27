// Cap-pressure strike: a frozen at-cap army with no actionable ordinary
// target must convert its surplus into a forced strike on the weakest
// bordering enemy after a bounded freeze confirmation window.

import assert from "node:assert/strict";
import { createAttackBehaviorSandbox } from "./helpers/attack-behavior-sandbox.mjs";

const sandbox = createAttackBehaviorSandbox({
  unit: {},
  gameMode: { FFA: "FFA", Team: "Team" },
});
assert.equal(typeof sandbox.AttackBehavior, "function");

function makeEnemy(smallID, troops) {
  return {
    isPlayer: () => true,
    smallID: () => smallID,
    name: () => "enemy-" + smallID,
    isAlive: () => true,
    troops: () => troops,
  };
}

function makeBehavior({
  gameMode = "FFA",
  winFixes = true,
  tiles = 32_600,
  troops = 1_370_000,
  maxTroops = 1_400_000,
} = {}) {
  const behavior = Object.create(sandbox.AttackBehavior.prototype);
  behavior.player = {
    isPlayer: () => true,
    smallID: () => 1,
    numTilesOwned: () => tiles,
    troops: () => troops,
  };
  behavior.game = {
    config: () => ({
      gameConfig: () => ({ gameMode }),
      maxTroops: () => maxTroops,
    }),
  };
  sandbox.state.settings.winFixes = winFixes;
  const strikes = [];
  behavior.forceSendAttack = async (target, fraction, options) => {
    strikes.push({ target, fraction, options });
    return true;
  };
  behavior.canAttackPlayerNow = () => true;
  behavior.currentAttackDecisionTick = () => 4242;
  return { behavior, strikes };
}

function confirmFreeze(behavior, decisions = 6) {
  // The first decision only establishes the tile baseline.
  for (let i = 0; i <= decisions; i++) behavior.updateCapPressureStrikeState();
  return behavior.capStrikeFrozenDecisions >= 6;
}

// 1. The lane stays closed before the freeze window completes.
{
  const { behavior } = makeBehavior();
  for (let i = 0; i < 5; i++) behavior.updateCapPressureStrikeState();
  assert.equal(
    await behavior.maybeCapPressureStrike({
      expandOn: true,
      borderingEnemies: [makeEnemy(3, 900_000)],
    }),
    false,
    "five frozen decisions must not strike yet",
  );
}

// 2. At the threshold it strikes the WEAKEST bordering enemy with the full
// surplus fraction (forceSendAttack clamps to the defensive-reserve surplus).
{
  const { behavior, strikes } = makeBehavior();
  assert.equal(confirmFreeze(behavior), true);
  const strong = makeEnemy(2, 1_700_000);
  const weak = makeEnemy(3, 900_000);
  assert.equal(
    await behavior.maybeCapPressureStrike({
      expandOn: true,
      borderingEnemies: [strong, weak],
    }),
    true,
  );
  // The options literal is created inside the engine's VM realm; compare
  // fields instead of crossing-realm deep equality.
  assert.equal(strikes.length, 1);
  assert.equal(strikes[0].target, weak);
  assert.equal(strikes[0].fraction, 1);
  assert.deepEqual({ ...strikes[0].options }, { capStrike: true });
  const strongerA = makeEnemy(4, 1_700_000);
  const strongerB = makeEnemy(5, 1_500_000);
  assert.equal(
    behavior.capStrikeTarget([strongerA, strongerB]),
    strongerB,
    "the live reserve, not an unsupported strength filter, controls safety",
  );
  // Telemetry contract consumed by scripts/headless/run-match.mts.
  assert.equal(behavior.capStrikeArmedHighWater, 6);
  assert.equal(behavior.capStrikeAttempts, 1);
  assert.equal(behavior.capStrikeLaunches, 1);
  assert.equal(behavior.capStrikeLastLaunchTick, 4242);
}

// 2b. The strike retains half the strongest OTHER border threat plus the
// live acceleration reserve, while other forced callers keep the full hold.
{
  const behavior = Object.create(sandbox.AttackBehavior.prototype);
  const holds = [];
  behavior.getStrongestStrategicBorderOpponentTroopsExcluding = (target) => {
    holds.push(target);
    return 1_000;
  };
  behavior.getEarlyGameLiveReserveTroops = () => 111;
  behavior.getEarlyGameTargetReserveTroops = (target) => {
    holds.push(target);
    return 999_999;
  };
  assert.equal(
    behavior.capStrikeReserveTroops({ capStrike: true }, "target"),
    500,
    "cap-strike retains half the other threat as defense",
  );
  assert.equal(behavior.capStrikeReserveTroops(null, "target"), 999_999);
  assert.deepEqual(holds, ["target", "target"]);
}

// 3. Growth resets the freeze; a shrinking territory is not frozen either.
{
  const { behavior } = makeBehavior();
  confirmFreeze(behavior, 3);
  behavior.player.numTilesOwned = () => 33_100;
  assert.equal(behavior.updateCapPressureStrikeState(), 0);
}

// 4. Below the cap ratio the counter never arms.
{
  const { behavior } = makeBehavior({ troops: 1_200_000 });
  assert.equal(confirmFreeze(behavior), false);
}

// 5. Team mode and winFixes-off never strike (commerce stall stays
// authoritative on team rows; faithful mode stays untouched).
{
  const team = makeBehavior({ gameMode: "Team" });
  confirmFreeze(team.behavior);
  assert.equal(
    await team.behavior.maybeCapPressureStrike({
      expandOn: true,
      borderingEnemies: [makeEnemy(3, 900_000)],
    }),
    false,
  );
  assert.equal(team.strikes.length, 0);

  const faithful = makeBehavior({ winFixes: false });
  confirmFreeze(faithful.behavior);
  assert.equal(
    await faithful.behavior.maybeCapPressureStrike({
      expandOn: true,
      borderingEnemies: [makeEnemy(3, 900_000)],
    }),
    false,
  );
  assert.equal(faithful.strikes.length, 0);
}

// 6. A dead or unauthorized target fails the lane without emitting.
{
  const { behavior, strikes } = makeBehavior();
  confirmFreeze(behavior);
  const dead = makeEnemy(3, 900_000);
  dead.isAlive = () => false;
  assert.equal(
    await behavior.maybeCapPressureStrike({
      expandOn: true,
      borderingEnemies: [dead],
    }),
    false,
  );
  assert.equal(strikes.length, 0);
  // The dead-target bail happens before any attempt is recorded.
  assert.equal(Number(behavior.capStrikeAttempts ?? 0), 0);
}
