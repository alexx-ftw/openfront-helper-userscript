  "a Post outside the engine effect radius cannot consume the threatened front's only defensive slot",
);
assert.equal(
  defenseCoverageBehavior.defensePostFrontDemand({ allowed: 1, landAttacks: [] }, [30]),
  null,
  "a Post at the engine effect-radius boundary still covers the front and consumes its slot",
);
assert.deepEqual(
  defenseCoverageBehavior.uncoveredDefensePostFrontTiles([10, 40]),
  [40],
  "an active front tile already inside the engine's Defense Post effect radius does not buy duplicate coverage",
);
assert.deepEqual(
  defenseCoverageBehavior.rankDefensePostTiles([10, 90, 45], [40, 60]),
  [45, 10, 90],
  "Defense Post placement covers the largest uncovered threatened front before secondary SAM-placement ties",
);

const quietBorderDefensePostBehavior = Object.create(sandbox.__StructureBehavior.prototype);
quietBorderDefensePostBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
quietBorderDefensePostBehavior.defensePostThreat = () => null;
let quietBorderBuildAttempted = false;
quietBorderDefensePostBehavior.tryBuildDefensePost = async () => {
  quietBorderBuildAttempted = true;
  return true;
};
assert.equal(
  await quietBorderDefensePostBehavior.handleDefensePostPriority(false),
  null,
  "a quiet border never diverts economic construction into a preventive Defense Post",
);
assert.equal(
  quietBorderBuildAttempted,
  false,
  "Defense Post placement is not probed without a live incoming land attack",
);
assert.doesNotMatch(
  structureBehaviorSource,
  /(?:preemptive|sustained)BorderDefensePostThreat|strategicBorderDefenseTopology/,
  "dead border-only Defense Post policy cannot be reconnected to bypass the live-attack gate",
);

const originalDifficultyForDefensePost = sandbox.currentDifficulty;
const originalOwnTroopsForDefensePost = own.troops;
const originalOwnIncomingForDefensePost = own.incomingAttacks;
sandbox.currentDifficulty = () => Difficulty.Legendary;
own.troops = () => 1000;
own.incomingAttacks = () => [{ troops: () => 400, target: () => own, attacker: () => enemyA }];
behavior.isLandAttack = () => true;
assert.equal(
  behavior.defensePostNeeded(),
  true,
  "Legendary treats a meaningful 40% land assault as requiring a Defense Post",
);
own.incomingAttacks = () => [{ troops: () => 300, target: () => own, attacker: () => enemyA }];
assert.equal(
  behavior.defensePostNeeded(),
  false,
  "a sub-35% probe does not trigger Defense Post construction",
);
own.incomingAttacks = () => [
  {
    troops: () => 900,
    retreating: () => true,
    target: () => own,
    attacker: () => ({ type: () => sandbox.PlayerType.Nation }),
  },
];
assert.equal(
  behavior.defensePostNeeded(),
  false,
  "a retreating land army cannot trigger a Defense Post after the attack has been cancelled",
);
own.incomingAttacks = () => [
  {
    troops: () => 150,
    target: () => own,
    attacker: () => ({ type: () => sandbox.PlayerType.Nation }),
  },
];
assert.equal(
  behavior.defensePostNeeded(),
  true,
  "a 15% Nation land push starts the first Defense Post before it becomes a siege",
);
sandbox.currentDifficulty = originalDifficultyForDefensePost;
own.troops = originalOwnTroopsForDefensePost;
own.incomingAttacks = originalOwnIncomingForDefensePost;
delete behavior.isLandAttack;

const preemptiveDefensePostBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let preemptiveIncomingAttacks = [
  {
    troops: () => 150,
    target: () => ({ smallID: () => 7 }),
    attacker: () => ({ type: () => sandbox.PlayerType.Nation }),
  },
];
preemptiveDefensePostBehavior.player = {
  smallID: () => 7,
  troops: () => 1000,
  incomingAttacks: () => preemptiveIncomingAttacks,
};
preemptiveDefensePostBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
preemptiveDefensePostBehavior.hasPriorStructureForDefensePost = () => true;
preemptiveDefensePostBehavior.isLandAttack = () => true;
preemptiveDefensePostBehavior.getConstructionCost = () => 50_000n;
preemptiveDefensePostBehavior.defensiveConstructionPressure = () => null;
const preemptivePostPressure = preemptiveDefensePostBehavior.preemptiveDefensePostPressure();
assert.equal(
  preemptivePostPressure?.type,
  UNIT.DefensePost,
  "a 15% Nation land attack reserves the next Defense Post before it becomes an active siege",
);
assert.equal(preemptivePostPressure?.cost, 50_000n);
assert.equal(
  preemptiveDefensePostBehavior.defensiveConstructionReserve(),
  50_000n,
  "the early post reserve is added to offensive-defense budgeting",
);
preemptiveDefensePostBehavior.economicConstructionPressure = () => null;
preemptiveDefensePostBehavior.spendableConstructionGold = () => 1_000_000n;
preemptiveDefensePostBehavior.getConstructionCost = () => 1_000_000n;
assert.equal(
  preemptiveDefensePostBehavior.shouldReserveEconomicGrowthForOffense(UNIT.MissileSilo),
  true,
  "a Silo cannot spend the margin needed for the imminent Defense Post",
);
preemptiveIncomingAttacks = [
  {
    troops: () => 900,
    retreating: () => true,
    target: () => ({ smallID: () => 7 }),
    attacker: () => ({ type: () => sandbox.PlayerType.Nation }),
  },
];
assert.equal(
  preemptiveDefensePostBehavior.preemptiveDefensePostPressure(),
  null,
  "a cancelled land attack cannot retain a preventive Defense Post reserve",
);
preemptiveDefensePostBehavior.player.smallID = () => 7;
preemptiveDefensePostBehavior.player.isFriendly = (attacker) => attacker?.friendly === true;
preemptiveIncomingAttacks = [
  {
    troops: () => 900,
    target: () => ({ smallID: () => 9 }),
    attacker: () => ({
      type: () => sandbox.PlayerType.Nation,
      isAlive: () => true,
    }),
  },
];
assert.equal(
  preemptiveDefensePostBehavior.preemptiveDefensePostPressure(),
  null,
  "an attack snapshot aimed at another player cannot authorize our Defense Post",
);
preemptiveIncomingAttacks = [
  {
    troops: () => 900,
    target: () => ({ smallID: () => 7 }),
    attacker: () => ({
      type: () => sandbox.PlayerType.Nation,
      isAlive: () => false,
    }),
  },
];
assert.equal(
  preemptiveDefensePostBehavior.preemptiveDefensePostPressure(),
  null,
  "a dead attacker's stale snapshot cannot authorize a Defense Post",
);
preemptiveIncomingAttacks = [
  {
    troops: () => 900,
    target: () => ({ smallID: () => 7 }),
    attacker: () => ({
      type: () => sandbox.PlayerType.Human,
      isAlive: () => true,
      friendly: true,
    }),
  },
];
assert.equal(
  preemptiveDefensePostBehavior.preemptiveDefensePostPressure(),
