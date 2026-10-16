// Score-zero release must be confined to the real top tier, keep the
// existing expected-value veto, and hold a 100k gold buffer above cost.
sandbox.isLegendaryDifficulty = (difficulty) =>
  difficulty === "Legendary" || difficulty === "Impossible";
let firingGold = 0n;
async function fireCandidateAtDifficulty(difficulty, value, expectedValue) {
  testDifficulty = difficulty;
  const candidate = { tile: 10, value };
  const firing = Object.create(sandbox.__NukeBehavior.prototype);
  const sent = [];
  // probeCanBuildNuke (DIVERGENCE B1, landed 2026-10-04) probes the async
  // buildables gate before affordability; the mock must answer it.
  firing.player = {
    gold: () => firingGold,
    buildables: async () => [{ type: UNIT.AtomBomb, canBuild: true }],
  };
  firing.partitionCandidatesBySamCoverage = () => ({ clear: [candidate] });
  firing.selectBuildableNukeCandidate = async () => candidate;
  firing.nukeHasPositiveExpectedValue = async () => expectedValue;
  firing.sendNuke = async (...args) => sent.push(args);
  firing.maybeDestroyEnemySam = async () => {};
  firing.maybeFirePostSalvoHydrogen = async () => {};
  await firing.fireNukeFromCandidates(
    [candidate],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    difficulty,
  );
  return sent.map((args) => args.slice(0, 3));
}
assert.deepEqual(
  await fireCandidateAtDifficulty("Impossible", 0, true),
  [],
  "a bufferless score-zero candidate stays sheathed",
);
firingGold = 840_000n;
assert.deepEqual(
  await fireCandidateAtDifficulty("Impossible", 0, true),
  [],
  "a score-zero candidate below the 100k gold buffer stays sheathed",
);
firingGold = 860_000n;
assert.deepEqual(
  await fireCandidateAtDifficulty("Impossible", 0, true),
  [[10, UNIT.AtomBomb, target]],
  "a score-zero candidate above the 100k gold buffer fires",
);
assert.deepEqual(
  await fireCandidateAtDifficulty("Hard", 0, true),
  [[10, UNIT.AtomBomb, target]],
  "a score-zero candidate fires at Hard (upstream 34a8fe723 moved the strict per-tile gate to Impossible)",
);
assert.deepEqual(
  await fireCandidateAtDifficulty("Impossible", 0, false),
  [],
  "a score-zero Legendary candidate remains blocked when expected value fails",
);
firingGold = 0n;
testDifficulty = sandbox.Difficulty.Legendary;

behavior.isUnderHeavyAttack = () => true;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "A heavy assault keeps the emergency nuke path available",
);

behavior.isUnderHeavyAttack = () => false;
behavior.attackBehavior.findIncomingAttackPlayer = () => ({ smallID: () => 42 });
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "A direct retaliation keeps the nuke path available",
);

behavior.attackBehavior.findIncomingAttackPlayer = () => null;
behavior.structureBehavior.shouldDeferOffensiveNuke = () => false;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "Offensive fire is allowed when the policy reports enough surplus",
);

behavior.structureBehavior = {
  hasActiveMaritimeInvasion: () => true,
  shouldDeferOffensiveNuke: () => false,
};
behavior.isUnderHeavyAttack = () => true;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  true,
  "a maritime invasion reserves gold even when the ordinary nuke path is urgent",
);

behavior.structureBehavior = null;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "The nuke behavior remains compatible when no structure policy is wired",
);

delete behavior.isUnderHeavyAttack;
behavior.player = {
  troops: () => 100,
  incomingAttacks: () => [
    { troops: () => 80, retreating: () => false },
    { troops: () => 900, retreating: () => true },
    { troops: () => 700, retreating: true },
  ],
};
assert.equal(
  behavior.isUnderHeavyAttack(),
  false,
  "cancelled method and boolean waves cannot trigger emergency nuke spending",
);
behavior.player.incomingAttacks = () => [
  { troops: () => 60, retreating: () => false },
  { troops: () => 40, retreating: false },
];
assert.equal(
  behavior.isUnderHeavyAttack(),
  true,
  "simultaneous live waves still aggregate into genuine heavy pressure",
);

const teammateTarget = { smallID: () => 73 };
const teammate = {
  smallID: () => 2,
  team: () => "blue",
  isAlive: () => true,
  targets: () => [teammateTarget],
};
const deadTeammate = {
  smallID: () => 3,
  team: () => "blue",
  isAlive: () => false,
  targets: () => [{ smallID: () => 74 }],
};
const me = {
  smallID: () => 1,
  team: () => "blue",
  isFriendly: (other) => other?.smallID?.() === 2 || other?.smallID?.() === 4,
