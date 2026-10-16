  null,
  "a now-friendly attack snapshot cannot authorize a Defense Post",
);
assert.equal(
  preemptiveDefensePostBehavior.shouldReserveEconomicGrowthForOffense(UNIT.City),
  false,
  "the preemptive Defense Post reserve never blocks productive City construction",
);
preemptiveIncomingAttacks = [
  {
    troops: () => 300,
    target: () => ({ smallID: () => 7 }),
    attacker: () => ({ type: () => sandbox.PlayerType.Tribe }),
  },
];
assert.equal(
  preemptiveDefensePostBehavior.preemptiveDefensePostPressure(),
  null,
  "a much larger Tribe attack cannot freeze the opening economy's offensive budget",
);

// ── Preemptive strategic-border Defense Post authorization ───────────────────
// A frontier shared with an army-sized Nation/Human must authorize Posts
// BEFORE the dogpile starts, capped at two concurrent Posts, while weaker
// neighbors and live-attack budgets keep their original behavior.
let strategicBorderTick = 5_000;
let strategicBorderPlayersReads = 0;
let strategicBorderPosts = [];
const strategicBorderMe = {
  smallID: () => 21,
  isPlayer: () => true,
  isAlive: () => true,
  isFriendly: () => false,
  isOnSameTeam: () => false,
  troops: () => 100_000,
  incomingAttacks: () => [],
  borderTiles: () => new Set([101, 901, 111]),
  units: (type) => (type === UNIT.DefensePost ? strategicBorderPosts : []),
};
const strongBorderNation = {
  smallID: () => 22,
  isPlayer: () => true,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Nation,
  troops: () => 250_000,
};
const weakBorderNation = {
  smallID: () => 23,
  isPlayer: () => true,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Nation,
  troops: () => 40_000,
};
const hugeBorderBot = {
  smallID: () => 24,
  isPlayer: () => true,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Bot,
  troops: () => 900_000,
};
const strategicBorderBehavior = Object.create(sandbox.__StructureBehavior.prototype);
strategicBorderBehavior.player = strategicBorderMe;
// The foundational City must win the early gold race: before any City exists
// the quiet strategic frontier must NOT divert construction into posts.
assert.equal(
  strategicBorderBehavior.defensePostThreat(Difficulty.Impossible),
  null,
  "a pre-City economy never buys preemptive Defense Posts",
);
strategicBorderMe.units = (type) => {
  if (type === UNIT.DefensePost) return strategicBorderPosts;
  if (type === UNIT.City) {
    return [{ id: () => 7, isUnderConstruction: () => false }];
  }
  return [];
};
strategicBorderBehavior.game = {
  ticks: () => strategicBorderTick,
  players: () => {
    strategicBorderPlayersReads++;
    return [strategicBorderMe, strongBorderNation, weakBorderNation, hugeBorderBot];
  },
  config: () => ({
    isUnitDisabled: () => false,
    defensePostRange: () => 30,
  }),
  neighbors: (tile) => ({ 101: [102], 901: [902], 111: [112] })[tile] ?? [],
  isLand: () => true,
  hasOwner: (tile) => tile === 102 || tile === 902 || tile === 112,
  ownerID: (tile) => ({ 102: 22, 902: 22, 112: 23 })[tile] ?? null,
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
strategicBorderBehavior.spacingConstants = () => ({
  borderSpacing: 30,
  structureSpacing: 60,
});

const strategicThreat = strategicBorderBehavior.defensePostThreat(Difficulty.Impossible);
assert.equal(
  strategicThreat?.strategicBorder,
  true,
  "a bordering army-sized Nation with no attack at all is a strategic Defense Post threat",
);
assert.equal(
  strategicThreat?.allowed,
  2,
  "the quiet strategic frontier authorizes two preemptive Defense Posts",
);
assert.deepEqual(
  Array.from(strategicThreat?.landAttacks ?? []),
  [],
  "the preemptive authorization carries no live attacks",
);
assert.deepEqual(
  Array.from(strategicThreat?.frontTiles ?? []),
  [101, 901],
  "preemptive placement targets only the frontier tiles shared with the strong neighbor",
);
assert.notEqual(
  strategicBorderBehavior.defensePostFrontDemand(strategicThreat, strategicThreat.frontTiles),
  null,
  "with no Posts built the preemptive budget is live",
);
strategicBorderPosts = [{ tile: () => 101 }];
assert.notEqual(
  strategicBorderBehavior.defensePostFrontDemand(strategicThreat, strategicThreat.frontTiles),
  null,
  "the second preemptive Post stays authorized while one frontier half is uncovered",
);
strategicBorderPosts = [{ tile: () => 101 }, { tile: () => 901 }];
assert.equal(
  strategicBorderBehavior.defensePostFrontDemand(strategicThreat, strategicThreat.frontTiles),
  null,
  "a third Post is never authorized once two already hold the strategic frontier",
);
strategicBorderPosts = [];

// A live tribe (Bot) land attack never authorizes a Defense Post (goal
// rule): tribes mount no sustained strategic pressure, so a Post on a tribe
// front is pure gold waste. The strategic-border Nation front above still
// holds.
const tribeAttack = {
  attacker: () => hugeBorderBot,
  target: () => strategicBorderMe,
  troops: () => 900_000,
  retreating: () => false,
};
const tribeAttackSave = strategicBorderBehavior.player.incomingAttacks;
const tribeAttackSaveBorder = strategicBorderBehavior.player.sharesBorderWith;
strategicBorderBehavior.player.incomingAttacks = () => [tribeAttack];
strategicBorderBehavior.player.sharesBorderWith = () => true;
strategicBorderTick++;
const tribeThreat = strategicBorderBehavior.defensePostThreat(Difficulty.Impossible);
assert.equal(
  Array.from(tribeThreat?.landAttacks ?? []).length,
  0,
  "a tribe land attack carries no Defense Post threat",
);
assert.equal(
  tribeThreat?.strategicBorder === true,
  true,
  "only the Nation/Human strategic frontier can still authorize Posts",
);
strategicBorderBehavior.player.incomingAttacks = tribeAttackSave;
strategicBorderBehavior.player.sharesBorderWith = tribeAttackSaveBorder;

strategicBorderTick++;
assert.equal(
  strategicBorderBehavior.defensePostThreat(Difficulty.Medium)?.allowed,
  1,
  "Medium keeps its single-Post cap under the strategic border rule",
);
assert.equal(
  strategicBorderBehavior.defensePostThreat(Difficulty.Easy),
  null,
  "Easy never authorizes Defense Posts, preemptive or not",
);

const originalStrongNationTroops = strongBorderNation.troops;
strongBorderNation.troops = () => 40_000;
strategicBorderTick++;
assert.equal(
  strategicBorderBehavior.defensePostThreat(Difficulty.Impossible),
  null,
  "a weaker bordering Nation authorizes no preventive Post even while a huge Bot shares the border",
);
strongBorderNation.troops = originalStrongNationTroops;

strategicBorderTick++;
strategicBorderPlayersReads = 0;
