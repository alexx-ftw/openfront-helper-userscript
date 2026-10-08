import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/nukeBehavior.js"),
  "utf8",
);
const sharedUtilsSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/shared-utils.js"),
  "utf8",
);

const UNIT = { AtomBomb: "Atom Bomb", HydrogenBomb: "Hydrogen Bomb" };
const sandbox = {
  UNIT,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  Relation: { Hostile: "Hostile" },
  PlayerType: { Bot: "Bot" },
  state: { settings: { winFixes: true }, stats: { nukes: 0 }, recentMirvHits: [] },
  currentDifficulty: () => sandbox.Difficulty.Legendary,
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: (difficulty) => difficulty === "Legendary",
  console,
};
sandbox.globalThis = sandbox;
executeClassicScript(sharedUtilsSource, sandbox, { filename: "shared-utils.vm.js" });
executeClassicScript(
  `${source}\nglobalThis.__NukeBehavior = NukeBehavior;`,
  sandbox,
  { filename: "hydrogen-finisher-retention.vm.js" },
);

const target = { smallID: () => 11, isAlive: () => true };
function makeFinisher({ gold, target: resolvedTarget = target }) {
  const behavior = Object.create(sandbox.__NukeBehavior.prototype);
  behavior.game = {
    ticks: () => 200,
    config: () => ({ isUnitDisabled: () => false }),
    players: () => [resolvedTarget ?? target].filter(Boolean),
  };
  behavior.player = { smallID: () => 1, gold: () => BigInt(gold) };
  behavior.attackBehavior = { shouldAttack: () => true };
  behavior.getPerceivedNukeCost = async () => 5_000_000n;
  behavior.player.units = () => [{ isUnderConstruction: () => false }];
  behavior.findEnemySamsCoveringTile = () => [];
  behavior._pendingNukeLaunches = [];
  const sent = [];
  behavior.sendNuke = async (...args) => {
    sent.push(args);
    return true;
  };
  sandbox.state.postSalvoHydrogen = {
    salvoId: undefined,
    targetTile: 555,
    dueTick: 100,
    targetSmallID: 11,
  };
  return { behavior, sent, pending: () => sandbox.state.postSalvoHydrogen };
}

// 1. A cost-blocked finisher survives and fires later.
{
  const { behavior, sent, pending } = makeFinisher({ gold: 1_000_000 });
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "an unaffordable finisher stands down without losing the schedule",
  );
  assert.ok(pending(), "the pending finisher survives a transient cost block");
  behavior.player.gold = () => 9_000_000n;
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), true);
  assert.deepEqual(sent, [[555, UNIT.HydrogenBomb, target]]);
  assert.equal(pending(), null, "a successful dispatch clears the schedule");
}

// 2. A dead/missing target clears the schedule (permanent condition).
{
  const { behavior, pending } = makeFinisher({
    gold: 9_000_000,
    target: { smallID: () => 11, isAlive: () => false },
  });
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.equal(pending(), null, "a dead target invalidates the finisher");
}

// 3. Disabled Hydrogen bombs clear the schedule (permanent condition).
{
  const { behavior, pending } = makeFinisher({ gold: 9_000_000 });
  behavior.game.config = () => ({ isUnitDisabled: (t) => t === UNIT.HydrogenBomb });
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.equal(pending(), null, "a disabled bomb invalidates the finisher");
}

// 4. A failed dispatch retains the schedule for retry.
{
  const { behavior, sent, pending } = makeFinisher({ gold: 9_000_000 });
  behavior.sendNuke = async () => false;
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.deepEqual(sent, []);
  assert.ok(pending(), "a failed dispatch keeps the finisher schedulable");
}

console.log("hydrogen-finisher-retention tests passed");
