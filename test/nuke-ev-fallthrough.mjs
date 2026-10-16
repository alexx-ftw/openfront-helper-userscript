import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";
import { readNukeBehaviorSource } from "./helpers/nuke-behavior-source.mjs";

const source = readNukeBehaviorSource();
const sharedUtilsSource = readRepositoryFile("engine/ingame/shared-utils.js");

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
  // Production bridge semantics: currentDifficulty() maps the Legendary UI
  // tier to the engine's Impossible enum; it never returns the raw string.
  currentDifficulty: () => sandbox.Difficulty.Impossible,
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: (difficulty) => difficulty === "Legendary" || difficulty === "Impossible",
  console,
};
sandbox.globalThis = sandbox;
executeClassicScript(sharedUtilsSource, sandbox, { filename: "shared-utils.vm.js" });
executeClassicScript(`${source}\nglobalThis.__NukeBehavior = NukeBehavior;`, sandbox, {
  filename: "nuke-ev-fallthrough.vm.js",
});

function makeBehavior({ clear, expectedValueMin }) {
  const behavior = Object.create(sandbox.__NukeBehavior.prototype);
  behavior.player = { gold: () => 10_000_000n };
  behavior.partitionCandidatesBySamCoverage = () => ({ clear });
  behavior.probeCanBuildNuke = async () => true;
  behavior.nukeHasPositiveExpectedValue = async (cand) => cand.value >= expectedValueMin;
  const sent = [];
  behavior.sendNuke = async (...args) => sent.push(args.slice(0, 3));
  const tail = { sam: 0, hydrogen: 0 };
  behavior.maybeDestroyEnemySam = async () => {
    tail.sam += 1;
  };
  behavior.maybeFirePostSalvoHydrogen = async () => {
    tail.hydrogen += 1;
  };
  return { behavior, sent, tail };
}

function makeCrossTargetBehavior(
  expectedValuePasses,
  { rejectedDestinations = new Set(), unbuildableTiles = new Set() } = {},
) {
  const targetA = { label: "A", smallID: () => 7 };
  const targetB = { label: "B", smallID: () => 8 };
  const candidateA = { name: "A", tile: 20, value: 97_000 };
  const candidateB = { name: "B", tile: 10, value: 125_000 };
  const candidatesByTarget = new Map([
    [targetA, [candidateA]],
    [targetB, [candidateB]],
  ]);
  const selectedNuke = { type: UNIT.AtomBomb, cost: 750_000n };
  const silos = [{}];
  const candidateGuards = [];
  const expectedValueChecks = [];
  const finalSendGuards = [];
  const sendTargets = [];
  let originalCandidates;
  const { behavior, sent, tail } = makeBehavior({
    clear: [],
    expectedValueMin: Infinity,
  });
  const prototype = sandbox.__NukeBehavior.prototype;
  let inFinalSend = false;

  behavior.player.units = (type) => (type === UNIT.MissileSilo ? silos : []);
  behavior.hasPendingNukeLaunches = () => false;
  behavior.canConsiderNukes = () => true;
  behavior.findBestNukeTarget = () => targetA;
  behavior.selectAffordableNuke = async () => selectedNuke;
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.findHighestValueNukeTarget = () => targetB;
  behavior.findValueRankedNukeTargets = () => [{ target: targetB, value: 3_000_000 }];
  behavior.playerStructureValue = (target) => (target === targetA ? 1_000_000 : 3_000_000);
  behavior.collectNukeCandidates = async (target) => {
    const candidates = candidatesByTarget.get(target);
    if (target === targetA) originalCandidates = candidates;
    return candidates;
  };
  behavior.partitionCandidatesBySamCoverage = (candidates) => ({
    clear: candidates,
    covered: [],
  });
  behavior.probeCanBuildNuke = async (tile) => {
    candidateGuards.push(tile);
    return !unbuildableTiles.has(tile);
  };
  behavior.nukeHasPositiveExpectedValue = async (candidate, target) => {
    expectedValueChecks.push(`${candidate.name}:${target.label}`);
    return expectedValuePasses.has(candidate.name);
  };
  behavior.maybeFreezeGiantStrike = async () => false;

  let collection;
  const collectCandidatesWithRetry = behavior.collectCandidatesWithRetry;
  behavior.collectCandidatesWithRetry = async function (...args) {
    collection = await collectCandidatesWithRetry.apply(this, args);
    return collection;
  };
  let fireArguments;
  const fireNukeFromCandidates = behavior.fireNukeFromCandidates;
  behavior.fireNukeFromCandidates = async function (...args) {
    fireArguments = args;
    return fireNukeFromCandidates.apply(this, args);
  };

  behavior.observeHostileNukeThreats = () => {};
  behavior.probeNukeBuildable = async (tile, type) => {
    finalSendGuards.push(`buildable:${tile}`);
    return { type, cost: selectedNuke.cost, canBuild: true };
  };
  const nukeBuildableCanLaunch = prototype.nukeBuildableCanLaunch;
  behavior.nukeBuildableCanLaunch = function (buildable) {
    finalSendGuards.push("affordability");
    return nukeBuildableCanLaunch.call(this, buildable);
  };
  behavior.isValidNukeTarget = (target) => {
    if (inFinalSend) finalSendGuards.push(`target:${target.label}`);
    return true;
  };
  behavior.isValidNukeDestination = (tile) => {
    finalSendGuards.push(`destination:${tile}`);
    return !rejectedDestinations.has(tile);
  };
  behavior.nukeSpawn = () => 99;
  behavior.isTrajectoryInterceptableBySam = (spawn, tile) => {
    finalSendGuards.push(`trajectory:${spawn}:${tile}`);
    return false;
  };
  behavior.shouldHoldCounterforceNuke = async (tile) => {
    finalSendGuards.push(`counterforce:${tile}`);
    return false;
  };
  behavior.emitNukeBuildable = (buildable, tile) => {
    sent.push([tile, buildable.type]);
    return true;
  };
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  const sendNuke = prototype.sendNuke;
  behavior.sendNuke = async function (tile, type, target, ...rest) {
    sendTargets.push(target);
    inFinalSend = true;
    try {
      return await sendNuke.call(this, tile, type, target, ...rest);
    } finally {
      inFinalSend = false;
    }
  };

  return {
    behavior,
    targetA,
    targetB,
    candidateA,
    candidateB,
    originalCandidates: () => originalCandidates,
    collection: () => collection,
    fireArguments: () => fireArguments,
    candidateGuards,
    expectedValueChecks,
    finalSendGuards,
    sendTargets,
    sent,
    tail,
  };
}

const target = { smallID: () => 7 };
const richButEvFailing = { tile: 10, value: 125_000 };
const poorerButEvPassing = { tile: 20, value: 1_000_000 };

// 1. Legendary: the EV rejection of the top-scored candidate no longer masks
// the next ranked candidate.
{
  const { behavior, sent, tail } = makeBehavior({
    clear: [richButEvFailing, poorerButEvPassing],
    expectedValueMin: 1_000_000,
  });
  await behavior.fireNukeFromCandidates(
    [richButEvFailing, poorerButEvPassing],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Legendary",
  );
  assert.deepEqual(
    sent,
    [[20, UNIT.AtomBomb, target]],
    "Legendary walks past an EV-rejected top candidate to the EV-positive one",
  );
  assert.deepEqual(tail, { sam: 0, hydrogen: 0 });
}

// 2. The value <= -1 stop still terminates the walk before lower candidates.
{
  const { behavior, sent } = makeBehavior({
    clear: [{ tile: 1, value: -2 }, poorerButEvPassing],
    expectedValueMin: 1_000_000,
  });
  await behavior.fireNukeFromCandidates(
    [{ tile: 1, value: -2 }, poorerButEvPassing],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Legendary",
  );
  assert.deepEqual(sent, [], "a value <= -1 candidate stops the Legendary walk");
}

// 3. Total EV rejection still reaches the SAM/Hydrogen tail.
{
  const { behavior, sent, tail } = makeBehavior({
    clear: [richButEvFailing],
    expectedValueMin: 1_000_000,
  });
  await behavior.fireNukeFromCandidates(
    [richButEvFailing],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Legendary",
  );
  assert.deepEqual(sent, [], "a fully rejected list fires nothing");
  assert.equal(tail.sam, 1, "the anti-SAM tail still runs after total rejection");
  assert.equal(
    tail.hydrogen,
    1,
    "the production Legendary tier (Impossible enum) arms the hydrogen finisher tail",
  );
}

// 4. Non-Legendary keeps the faithful single-pick path (no walk).
{
  const { behavior, sent, tail } = makeBehavior({
    clear: [richButEvFailing, poorerButEvPassing],
    expectedValueMin: 1_000_000,
  });
  await behavior.fireNukeFromCandidates(
    [richButEvFailing, poorerButEvPassing],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Hard",
  );
  assert.deepEqual(sent, [], "Hard still fires nothing when its single pick fails EV");
  assert.deepEqual(
    tail,
    { sam: 1, hydrogen: 0 },
    "below the Legendary tier the hydrogen finisher tail stays dormant",
  );
}

// 5. A higher-value Legendary retry that fails EV stands down (no
// original-target fallback lane).
const crossTarget = makeCrossTargetBehavior(new Set(["A"]));
await crossTarget.behavior.maybeSendNuke();
assert.equal(crossTarget.collection().retargeted, crossTarget.targetB);
assert.equal(crossTarget.collection().fallback, undefined);
assert.deepEqual(crossTarget.expectedValueChecks, ["B:B"]);
assert.deepEqual(crossTarget.candidateGuards, [crossTarget.candidateB.tile]);
assert.deepEqual(crossTarget.sent, []);
assert.deepEqual(crossTarget.sendTargets, []);
assert.deepEqual(crossTarget.finalSendGuards, []);
assert.deepEqual(crossTarget.tail, { sam: 1, hydrogen: 1 });

// 6. A valid retarget keeps priority and stops after its successful launch.
const crossTargetAlternateWins = makeCrossTargetBehavior(new Set(["A", "B"]));
await crossTargetAlternateWins.behavior.maybeSendNuke();
assert.deepEqual(crossTargetAlternateWins.expectedValueChecks, ["B:B", "B:B"]);
assert.deepEqual(crossTargetAlternateWins.sendTargets, [crossTargetAlternateWins.targetB]);
assert.deepEqual(crossTargetAlternateWins.sent, [
  [crossTargetAlternateWins.candidateB.tile, UNIT.AtomBomb],
]);
assert.deepEqual(crossTargetAlternateWins.tail, { sam: 0, hydrogen: 0 });

// 7. If both the retargeted and original lists fail EV, the SAM/Hydrogen tail
// still runs once for the decision; the original list is never re-probed.
const crossTargetRejected = makeCrossTargetBehavior(new Set());
await crossTargetRejected.behavior.maybeSendNuke();
assert.deepEqual(crossTargetRejected.expectedValueChecks, ["B:B"]);
assert.deepEqual(crossTargetRejected.sent, []);
assert.deepEqual(crossTargetRejected.tail, { sam: 1, hydrogen: 1 });

// 8. A buildability rejection on the retarget stands down without probing
// the original target.
const crossTargetUnbuildable = makeCrossTargetBehavior(new Set(["A", "B"]), {
  unbuildableTiles: new Set([10]),
});
await crossTargetUnbuildable.behavior.maybeSendNuke();
assert.deepEqual(crossTargetUnbuildable.candidateGuards, [10]);
assert.deepEqual(crossTargetUnbuildable.expectedValueChecks, []);
assert.deepEqual(crossTargetUnbuildable.sendTargets, []);
assert.deepEqual(crossTargetUnbuildable.sent, []);

// 9. A retarget that passes EV but fails the final destination guard also
// stands down after its rejected launch attempt.
const crossTargetGuardRejected = makeCrossTargetBehavior(new Set(["A", "B"]), {
  rejectedDestinations: new Set([10]),
});
await crossTargetGuardRejected.behavior.maybeSendNuke();
assert.deepEqual(crossTargetGuardRejected.expectedValueChecks, ["B:B"]);
assert.deepEqual(crossTargetGuardRejected.sendTargets, [crossTargetGuardRejected.targetB]);
assert.deepEqual(crossTargetGuardRejected.sent, []);
assert.deepEqual(
  crossTargetGuardRejected.finalSendGuards.filter((guard) => guard.startsWith("destination:")),
  ["destination:10"],
);

// 10. A missing shot against the highest-value target falls through to the
// next eligible rival; a richer but ineligible rival is never probed.
{
  const targetA = { label: "A", smallID: () => 7, team: () => null, isAlive: () => true };
  let targetBAlive = true;
  const targetB = {
    label: "B",
    smallID: () => 8,
    team: () => null,
    isAlive: () => targetBAlive,
  };
  const targetC = { label: "C", smallID: () => 9, team: () => null, isAlive: () => true };
  const targetD = { label: "D", smallID: () => 10, team: () => null, isAlive: () => true };
  const candidateC = { tile: 30, score: 50_000 };
  const values = new Map([
    [targetA, 1_000_000],
    [targetB, 9_000_000],
    [targetC, 4_000_000],
    [targetD, 20_000_000],
  ]);
  const candidates = new Map([
    [targetB, []],
    [targetC, [candidateC]],
    [targetD, []],
  ]);
  const probedTargets = [];
  const { behavior } = makeBehavior({ clear: [], expectedValueMin: 0 });
  behavior.player = { smallID: () => 1, team: () => null };
  behavior.game = {
    ticks: () => 100,
    players: () => [targetA, targetB, targetC, targetD],
  };
  behavior.attackBehavior = { shouldAttack: (player) => player !== targetD };
  behavior.playerStructureValue = (player) => values.get(player) ?? 0;
  behavior.samDemandMatchesTarget = () => false;
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.collectNukeCandidates = async (player) => {
    probedTargets.push(player);
    return candidates.get(player) ?? [];
  };

  const result = await behavior.collectCandidatesWithRetry(
    targetA,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Impossible",
  );
  assert.equal(result.retargeted, targetC, "the next eligible target with a shot is selected");
  assert.deepEqual(
    probedTargets,
    [targetA, targetB, targetC],
    "the ineligible highest-value rival is skipped",
  );
  assert.deepEqual(result.list, [candidateC]);

  probedTargets.length = 0;
  const afterDemand = await behavior.retryWithHigherValueTarget(
    targetA,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Impossible",
    { candidates: [], excludedTarget: targetB },
  );
  assert.equal(afterDemand?.target, targetC);
  assert.deepEqual(probedTargets, [targetC], "a serviced live-demand target is skipped");

  probedTargets.length = 0;
  candidates.set(targetB, [{ tile: 40, score: 60_000 }]);
  behavior.collectNukeCandidates = async (player) => {
    probedTargets.push(player);
    const result = candidates.get(player) ?? [];
    if (player === targetB) targetBAlive = false;
    return result;
  };
  const afterElimination = await behavior.retryWithHigherValueTarget(
    targetA,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Impossible",
    { candidates: [] },
  );
  assert.equal(afterElimination?.target, targetC);
  assert.deepEqual(
    probedTargets,
    [targetB, targetC],
    "a target eliminated during collection is skipped",
  );
}

process.stdout.write("nuke-ev-fallthrough tests passed\n");
