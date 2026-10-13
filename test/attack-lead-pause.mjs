// Attack-lead pause: Legendary survival pacing refuses NEW discretionary
// player conquests while owned territory keeps shrinking below its recent
// peak, and releases once the ring-buffer window stabilizes. Forced
// retaliation/defense and Terra Nullius growth stay open while paused.

import assert from "node:assert/strict";
import { createAttackBehaviorSandbox, Difficulty } from "./helpers/attack-behavior-sandbox.mjs";

const sandbox = createAttackBehaviorSandbox({
  unit: {},
  gameMode: { FFA: "FFA", Team: "Team" },
});
assert.equal(typeof sandbox.AttackBehavior, "function");

function makeBehavior(context = sandbox) {
  const behavior = Object.create(context.AttackBehavior.prototype);
  const world = { tiles: 0, tick: 3000 };
  behavior.player = {
    isPlayer: () => true,
    smallID: () => 1,
    numTilesOwned: () => world.tiles,
    troops: () => 1_000_000,
    units: () => [],
  };
  behavior.game = { ticks: () => world.tick };
  behavior.currentAttackDecisionTick = () => world.tick;
  behavior.getLiveOutboundAttackTroopsForTarget = () => 0;
  behavior.getPendingOutboundAttackTroopsForTarget = () => 0;
  const enemy = {
    isPlayer: () => true,
    smallID: () => 2,
    type: () => context.PlayerType.Human,
    isAlive: () => true,
  };
  const terraNullius = { isPlayer: () => false };
  return { behavior, world, enemy, terraNullius };
}

function feedDecisions(behavior, world, tileSeries) {
  for (const tiles of tileSeries) {
    world.tiles = tiles;
    world.tick += 40;
    behavior.observeAttackLeadTrajectory();
  }
}

// 1. Growth never arms the pause.
{
  const { behavior, world, enemy } = makeBehavior();
  feedDecisions(behavior, world, [10_000, 11_000, 12_000, 13_000, 14_000]);
  assert.equal(
    behavior.attackLeadPauseSparesConquest({ target: enemy }),
    false,
    "a growing territory must keep attacking",
  );
}

// 2. A shrink beyond the threshold pauses new conquests at the
// authorization tail, while forced defense and Terra Nullius stay open.
{
  const { behavior, world, enemy, terraNullius } = makeBehavior();
  feedDecisions(behavior, world, [100_000, 101_000, 100_500, 98_000, 90_000]);
  assert.equal(
    behavior.attackLeadPauseSparesConquest({ target: enemy }),
    true,
    "a shrinking territory pauses new discretionary conquests",
  );
  assert.equal(
    behavior.sendAttackTargetIsAuthorized({ target: enemy }, false),
    false,
    "the sendAttack tail refuses the discretionary conquest",
  );
  assert.equal(
    behavior.sendAttackTargetIsAuthorized({ target: enemy, force: true }, true),
    true,
    "forced retaliation/defense still fires while paused",
  );
  assert.equal(
    behavior.sendAttackTargetIsAuthorized({ target: terraNullius }, false),
    true,
    "Terra Nullius growth stays open while paused",
  );
}

// 3. Stabilization releases the pause: the 8-sample window rolls off the
// old peak without any extra hysteresis state.
{
  const { behavior, world, enemy } = makeBehavior();
  feedDecisions(behavior, world, [100_000, 101_000, 92_000, 90_000, 90_000]);
  assert.equal(
    behavior.attackLeadPauseSparesConquest({ target: enemy }),
    true,
    "an active shrink holds the pause",
  );
  feedDecisions(behavior, world, [90_000, 90_000, 90_500, 90_000, 91_000]);
  assert.equal(
    behavior.attackLeadPauseSparesConquest({ target: enemy }),
    false,
    "a stabilized territory releases the pause",
  );
}

// 4. The absolute tile floor keeps opening-phase noise from arming.
{
  const { behavior, world, enemy } = makeBehavior();
  feedDecisions(behavior, world, [500, 501, 470, 465, 460]);
  assert.equal(
    behavior.attackLeadPauseSparesConquest({ target: enemy }),
    false,
    "opening-territory noise does not arm the pause",
  );
}

// 5. The divergence is opt-in only: non-Legendary and faithful winFixes=false
//    runs must keep the native attack policy even while territory shrinks.
{
  const context = createAttackBehaviorSandbox({
    unit: {},
    difficulty: Difficulty.Impossible,
    gameMode: { FFA: "FFA", Team: "Team" },
  });
  const { behavior, world, enemy } = makeBehavior(context);
  feedDecisions(behavior, world, [100_000, 101_000, 100_500, 98_000, 90_000]);
  assert.equal(
    behavior.attackLeadPauseSparesConquest({ target: enemy }),
    false,
    "non-Legendary difficulty keeps the native conquest policy",
  );
}

{
  const context = createAttackBehaviorSandbox({
    unit: {},
    difficulty: Difficulty.Legendary,
    gameMode: { FFA: "FFA", Team: "Team" },
  });
  context.state.settings.winFixes = false;
  const { behavior, world, enemy } = makeBehavior(context);
  feedDecisions(behavior, world, [100_000, 101_000, 100_500, 98_000, 90_000]);
  assert.equal(
    behavior.attackLeadPauseSparesConquest({ target: enemy }),
    false,
    "winFixes=false keeps the faithful native conquest policy",
  );
}
