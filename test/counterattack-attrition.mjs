// Attrition-aware forced counterattacks. A peer attacker keeps the historical
// one-to-one mirror, while a materially superior nation receives bounded
// partial interdiction under a per-war commitment cap so a protracted siege
// can no longer donate the whole army wave by wave. The in-game simulator
// fixtures (attack-spawn-immunity, donation-headroom) cover the integrated
// land-attack path end-to-end.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");

const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const sandbox = {
  UNIT: {},
  Difficulty,
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  currentDifficulty: () => Difficulty.Legendary,
  state: { settings: { winFixes: true }, stats: {} },
};
executeClassicScript(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
  filename: sourcePath,
});
assert.equal(typeof sandbox.AttackBehavior, "function");

let nowTick = 1_000;
function makeBehavior({ ownTroops, attackerTroops }) {
  const behavior = Object.create(sandbox.AttackBehavior.prototype);
  behavior.initializeIncomingCounterattackWarState();
  behavior.game = { ticks: () => nowTick };
  behavior.player = {
    smallID: () => 1,
    troops: () => ownTroops,
    isFriendly: () => false,
    incomingAttacks: () => [],
  };
  const attacker = {
    isPlayer: () => true,
    smallID: () => 7,
    troops: () => attackerTroops,
  };
  return { behavior, attacker };
}

function contextFor(behavior, attacker, { wave, spendable }) {
  return {
    target: attacker,
    force: true,
    incomingCounterattackTroops: wave,
    finalSpendableTroops: spendable,
    attackBlocked: false,
  };
}

// 1. A peer attacker keeps the exact one-to-one mirror.
{
  const { behavior, attacker } = makeBehavior({
    ownTroops: 500_000,
    attackerTroops: 400_000,
  });
  const context = contextFor(behavior, attacker, {
    wave: 120_000,
    spendable: 300_000,
  });
  assert.equal(
    behavior.calculateIncomingCounterattackTroops(context),
    120_000,
    "a peer attacker still receives the full mirrored counterattack",
  );
  assert.equal(context.attackBlocked, false);
}

// 2. An attacker of unreadable strength keeps the mirror (fail-open).
{
  const { behavior, attacker } = makeBehavior({
    ownTroops: 500_000,
    attackerTroops: 0,
  });
  const context = contextFor(behavior, attacker, {
    wave: 120_000,
    spendable: 300_000,
  });
  assert.equal(
    behavior.calculateIncomingCounterattackTroops(context),
    120_000,
    "unknown attacker strength preserves the parity mirror",
  );
}

// 3. A materially superior attacker gets bounded partial interdiction:
//    min(wave * 0.6, spendable * 0.35, remaining per-war cap).
{
  const { behavior, attacker } = makeBehavior({
    ownTroops: 200_000,
    attackerTroops: 4_000_000,
  });
  const context = contextFor(behavior, attacker, {
    wave: 100_000,
    spendable: 150_000,
  });
  assert.equal(
    behavior.calculateIncomingCounterattackTroops(context),
    75_000,
    "a superior attacker is interdicted with a bounded share of spendable troops",
  );
  assert.equal(context.attackBlocked, false);

  // A wave-driven bound below the spendable bound caps the interdiction.
  const smallWave = contextFor(behavior, attacker, {
    wave: 20_000,
    spendable: 150_000,
  });
  assert.equal(
    behavior.calculateIncomingCounterattackTroops(smallWave),
    17_000,
    "interdiction never exceeds six-sevenths of the hostile wave",
  );
}

// 4. The per-war attrition cap turns further mirrors into a defense hold.
{
  const { behavior, attacker } = makeBehavior({
    ownTroops: 200_000,
    attackerTroops: 4_000_000,
  });
  behavior.recordIncomingCounterattackCommitment(attacker, 95_000);
  const context = contextFor(behavior, attacker, {
    wave: 100_000,
    spendable: 150_000,
  });
  assert.equal(
    behavior.calculateIncomingCounterattackTroops(context),
    5_000,
    "interdiction shrinks to the remaining per-war cap",
  );

  behavior.recordIncomingCounterattackCommitment(attacker, 5_000);
  const exhausted = contextFor(behavior, attacker, {
    wave: 100_000,
    spendable: 150_000,
  });
  assert.equal(
    behavior.calculateIncomingCounterattackTroops(exhausted),
    0,
    "an exhausted war ledger refuses further counterattack commitments",
  );
  assert.equal(exhausted.attackBlocked, true);
}

// 5. The ledger window rolls over: last war's cap does not haunt a new one.
{
  const { behavior, attacker } = makeBehavior({
    ownTroops: 200_000,
    attackerTroops: 4_000_000,
  });
  behavior.recordIncomingCounterattackCommitment(attacker, 100_000);
  nowTick += 901;
  const context = contextFor(behavior, attacker, {
    wave: 100_000,
    spendable: 150_000,
  });
  assert.equal(
    behavior.calculateIncomingCounterattackTroops(context),
    75_000,
    "a stale attrition window is forgotten so a renewed war can defend again",
  );
}

// 6. Containment mode reports the superior siege without spending anything.
{
  const { behavior, attacker } = makeBehavior({
    ownTroops: 200_000,
    attackerTroops: 4_000_000,
  });
  behavior.findIncomingAttackPlayer = () => attacker;
  assert.equal(
    behavior.incomingDefenseContainmentMode(),
    true,
    "a superior siege is flagged for containment so growth lanes keep running",
  );

  const peer = makeBehavior({
    ownTroops: 500_000,
    attackerTroops: 400_000,
  });
  peer.behavior.findIncomingAttackPlayer = () => peer.attacker;
  assert.equal(
    peer.behavior.incomingDefenseContainmentMode(),
    false,
    "a parity siege keeps the dedicated defense lane in charge",
  );

  behavior.findIncomingAttackPlayer = () => null;
  assert.equal(
    behavior.incomingDefenseContainmentMode(),
    false,
    "no incoming attacker means no containment mode",
  );
}

// 7. A small homeland cannot trade space for time: containment returns to
//    the full mirror while the territory is tiny.
{
  const { behavior, attacker } = makeBehavior({
    ownTroops: 200_000,
    attackerTroops: 4_000_000,
  });
  behavior.player.numTilesOwned = () => 1_500;
  const context = contextFor(behavior, attacker, {
    wave: 100_000,
    spendable: 150_000,
  });
  assert.equal(
    behavior.calculateIncomingCounterattackTroops(context),
    100_000,
    "a small homeland mirrors the full hostile wave even against a stronger attacker",
  );
  assert.equal(context.attackBlocked, false);
}

process.stdout.write("counterattack attrition tests passed\n");
