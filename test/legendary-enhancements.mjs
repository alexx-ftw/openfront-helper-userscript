// Enhancements to the Legendary construction planner and related auto-bot
// heuristics. Each block exercises one new signal in isolation against a
// synthetic game/player stub, then asserts the observable decision matches the
// documented intent of the enhancement. These are unit-level checks; the
// in-game simulator fixtures (sam-launcher-claim, nuke-launch-stagger, etc.)
// cover the integrated behavior end-to-end.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

// ── Legendary planner primitives (salvo budget ceiling) ──────────────────────
const plannerSandbox = {};
executeClassicScript(read("engine/ingame/auto-bot/legendaryPlanner.js"), plannerSandbox, {
  filename: "legendaryPlanner.js",
});

// ── structureBehavior sandbox (placement + salvo budget methods) ─────────────
const structureSource = read("engine/ingame/auto-bot/structureBehavior.js");
const structureSandbox = {
  UNIT: {
    City: "City",
    Factory: "Factory",
    Port: "Port",
    Warship: "Warship",
    MissileSilo: "MissileSilo",
    SAMLauncher: "SAMLauncher",
    AtomBomb: "AtomBomb",
    HydrogenBomb: "HydrogenBomb",
    MIRV: "MIRV",
    MIRVWarhead: "MIRV Warhead",
    DefensePost: "DefensePost",
    TransportShip: "TransportShip",
    TradeShip: "TradeShip",
  },
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  currentDifficulty: () => "Legendary",
  isLegendaryDifficulty: () => true,
  state: { settings: { winFixes: true } },
  BigInt,
  Math,
  Number,
  isFinite,
  isNaN,
  Array,
  Object,
  Map,
  Set,
  Date,
  JSON,
  Error,
  Reflect,
  Symbol,
  Promise,
  performance: { now: () => 0 },
  console,
  Infinity,
  NaN,
  undefined,
};
structureSandbox.globalThis = structureSandbox;
structureSandbox.window = structureSandbox;
executeClassicScript(
  `${structureSource}\nglobalThis.StructureBehavior = StructureBehavior;`,
  structureSandbox,
  {
    filename: "structureBehavior.js",
  },
);

// ── naval-interception planner (threat-weighted prioritization) ──────────────
const navalSandbox = {};
executeClassicScript(read("engine/ingame/auto-bot/naval-interception.js"), navalSandbox, {
  filename: "naval-interception.js",
});

// Helper: build a fake game for the structure-behavior prototype.
function makeFakeGame(overrides = {}) {
  return {
    ticks: () => 0,
    x: (tile) => Number(tile % 1000),
    y: (tile) => Math.floor(Number(tile) / 1000),
    ref: (x, y) => Math.floor(y) * 1000 + Math.floor(x),
    isValidCoord: (x, y) => x >= 0 && y >= 0 && x < 1000 && y < 1000,
    width: () => 1000,
    height: () => 1000,
    isLand: () => true,
    magnitude: () => 10,
    manhattanDist: (a, b) => Math.abs(Number(a) - Number(b)),
    euclideanDistSquared: (a, b) => {
      const ax = Number(a) % 1000;
      const ay = Math.floor(Number(a) / 1000);
      const bx = Number(b) % 1000;
      const by = Math.floor(Number(b) / 1000);
      return (ax - bx) ** 2 + (ay - by) ** 2;
    },
    config: () => ({
      defaultSamRange: () => 150,
      samRange: () => 150,
      trainStationMinRange: () => 20,
      trainStationMaxRange: () => 200,
      maxTroops: () => 100000,
    }),
    units: () => [],
    players: () => [],
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Silo salvo budget is capped by enemy silo capacity, not just gold
// ════════════════════════════════════════════════════════════════════════════
{
  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  behavior.game = makeFakeGame();
  // Enemy has a single level-1 silo but a treasury that could buy 100 atoms.
  // Without the capacity ceiling the budget would model a 100-missile chain.
  const fakeSilo = {
    isUnderConstruction: () => false,
    isActive: () => true,
    level: () => 1,
    tile: () => 0,
    id: () => 1,
  };
  behavior.legendarySiloCooldownTicks = () => 90;
  behavior.legendaryEligibleEnemyMissileSilo = (silo) => Boolean(silo);
  behavior.normalizedStructureLevel = (lvl) => Math.max(1, Math.floor(Number(lvl ?? 1)));

  const ceiling = behavior.legendaryEnemySiloSalvoCeiling([fakeSilo]);
  assert.ok(
    ceiling <= 2,
    `a single level-1 silo caps the salvo ceiling at its slot count plus one reload (got ${ceiling})`,
  );

  // The budget then bounds the atom count by this ceiling even when gold is huge.
  const budget = behavior.legendaryMissileSalvoBudget(
    30_000_000n, // enough gold for 40 atoms at 750k each
    750_000n, // atom cost
    0n, // no hydrogen
    { siloCapacityCeiling: ceiling },
  );
  assert.ok(
    budget.atomCount <= ceiling,
    `the salvo budget atom count respects the silo capacity ceiling (got ${budget.atomCount})`,
  );
  assert.ok(
    budget.atomCount < 40,
    `a single level-1 silo cannot launch a forty-missile chain regardless of gold (got ${budget.atomCount})`,
  );

  // Sanity: without the ceiling, gold alone governs.
  const goldOnlyBudget = behavior.legendaryMissileSalvoBudget(30_000_000n, 750_000n, 0n, {
    siloCapacityCeiling: null,
  });
  assert.ok(
    goldOnlyBudget.atomCount > budget.atomCount,
    "without the capacity ceiling the budget is governed by gold alone",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. SAM placement rewards covering a spatially spread cluster (diversity)
// ════════════════════════════════════════════════════════════════════════════
{
  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  behavior.game = makeFakeGame();
  // Two uncovered structures far apart vs two close together. A SAM placed to
  // cover the spread pair should score higher than one covering the tight pair
  // because the spread bonus rewards genuine multi-target coverage.
  behavior.legendaryCriticalStructureValue = () => 5;
  behavior.legendarySamImpactMarginScore = () => 0;
  behavior.getMissileDefenseContext = () => ({ critical: false });
  behavior.spacingConstants = () => ({ structureSpacing: 100, borderSpacing: 100 });

  const rangeSquared = 150 * 150;
  // Spread pair: structures at (100,0) and (250,0). Candidate SAM at (175,0).
  const spreadContext = {
    rangeSquared,
    candidateSamRange: 150,
    uncoveredStructures: [
      { structure: {}, tile: 100 },
      { structure: {}, tile: 250 },
    ],
    criticalValueCache: new Map(),
    spacing: 100,
  };
  // Tight pair: structures at (100,0) and (105,0). Candidate SAM at (102,0).
  const tightContext = {
    rangeSquared,
    candidateSamRange: 150,
    uncoveredStructures: [
      { structure: {}, tile: 100 },
      { structure: {}, tile: 105 },
    ],
    criticalValueCache: new Map(),
    spacing: 100,
  };
  const spreadScore = behavior.legendarySamCoveragePlacementScore(175, null, spreadContext);
  const tightScore = behavior.legendarySamCoveragePlacementScore(102, null, tightContext);
  assert.ok(
    spreadScore > tightScore,
    `a SAM covering a spread cluster outscores one covering a tight pair (spread ${spreadScore} > tight ${tightScore})`,
  );

  // Bonus is bounded by one spacing unit.
  const bonus = behavior.legendarySamCoverageSpreadBonus(0, [100, 250], 100);
  assert.ok(
    bonus <= 100 && bonus > 0,
    `the spread bonus is bounded by one spacing unit and positive for a spread pair (got ${bonus})`,
  );
  const clumpBonus = behavior.legendarySamCoverageSpreadBonus(0, [100, 101], 100);
  assert.equal(clumpBonus, 0, "a tight clump earns no spread bonus");
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Silo placement adds an offensive reach bonus toward hostile centers
// ════════════════════════════════════════════════════════════════════════════
{
  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  behavior.game = makeFakeGame();
  behavior.spacingConstants = () => ({ structureSpacing: 50, borderSpacing: 50 });

  const context = { centers: [{ x: 100, y: 0 }], referenceDistance: 120 };
  // A candidate at the hostile center doorstep earns the full bonus.
  const closeScore = behavior.legendarySiloOffensiveReachScore(100, context, 50);
  // A candidate far beyond the reference distance earns nothing. Tile 300
  // encodes to (300, 0), which is 200 from the center at (100, 0) — well
  // beyond the 120-tile reference.
  const farScore = behavior.legendarySiloOffensiveReachScore(300, context, 50);
  assert.ok(
    closeScore > farScore && closeScore > 0 && farScore === 0,
    `a silo closer to a hostile center earns a larger offensive reach bonus (close ${closeScore} > far ${farScore})`,
  );

  // No hostile centers → no bonus.
  const emptyScore = behavior.legendarySiloOffensiveReachScore(
    0,
    { centers: [], referenceDistance: 120 },
    50,
  );
  assert.equal(emptyScore, 0, "no hostile centers yields no offensive reach bonus");

  // Bonus is bounded by spacing.
  assert.ok(closeScore <= 50, "the offensive reach bonus is bounded by one spacing unit");
}

// ════════════════════════════════════════════════════════════════════════════
// 4. City placement now gets the same rail-connectivity bonus as Port
// ════════════════════════════════════════════════════════════════════════════
{
  // The enhancement is structural parity: legendaryStructureSpawnTileValue
  // applies legendaryRailConnectivityPlacementScore for City as well as Port.
  // We verify the City branch is exercised by checking the value function
  // calls the connectivity scorer. Build a minimal behavior stub.
  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  let connectivityCalls = 0;
  behavior.game = makeFakeGame();
  behavior.spacingConstants = () => ({ structureSpacing: 100, borderSpacing: 100 });
  behavior.structureSpawnTileValue = () => () => 0;
  behavior.getMissileDefenseContext = () => ({ critical: false });
  behavior.legendaryMissilePlacementRisk = () => 0;
  behavior.legendaryAllyPlacementContext = () => null;
  behavior.legendaryTeamCenterPlacementContext = () => null;
  behavior.legendaryAllySupportPlacementScore = () => 0;
  behavior.legendaryTeamCenterPlacementScore = () => 0;
  behavior.legendaryRailConnectivityPlacementScore = () => {
    connectivityCalls++;
    return 50;
  };
  behavior.legendaryTrainStationRanges = () => ({
    minRangeSquared: 400,
    maxRangeSquared: 40000,
    maxRange: 200,
  });
  behavior.getOrBuildReachableStations = () => [];
  behavior.computeConnectivityScore = () => 0.5;
  behavior.legendarySiloReachContext = () => null;

  const cityValueFn = behavior.legendaryStructureSpawnTileValue("City");
  const cityValue = cityValueFn(0);
  assert.ok(connectivityCalls > 0, "City placement now invokes the rail connectivity scorer");
  assert.ok(cityValue > 0, "City placement value includes the rail connectivity bonus");
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Naval interception prioritizes the higher-threat landing in a near-simultaneous window
// ════════════════════════════════════════════════════════════════════════════
{
  const { planNavalInterceptions } = navalSandbox;
  // One warship in the middle, two invasions arriving from opposite sides,
  // both reachable. The warship can only commit to one before both land. The
  // heavier invasion (more troops) should be the one covered.
  const tile = (x, y) => y * 1000 + x;
  const ship = { id: "warship-1", tile: tile(50, 0) };
  // Light invasion approaches from the west, lands at tile(60,0) at tick 10.
  const lightInvasion = {
    id: "light",
    threat: 100,
    path: Array.from({ length: 11 }, (_, i) => tile(50 + i, 0)),
  };
  // Heavy invasion approaches from the east, lands at tile(40,0) at tick 10.
  // Same landing tick → within the threat bucket → threat breaks the tie.
  const heavyInvasion = {
    id: "heavy",
    threat: 1000,
    path: Array.from({ length: 11 }, (_, i) => tile(50 - i, 0)),
  };
  const result = planNavalInterceptions({
    ships: [ship],
    invasions: [lightInvasion, heavyInvasion],
    route: (from, to) => [from, to],
    distance: (a, b) => Math.abs(Number(a) - Number(b)),
    targetDistanceSquared: (a, b) => {
      const d = Math.abs(Number(a) - Number(b));
      return d * d;
    },
    boatSpeed: 1,
    warshipSpeed: 1,
    attackRange: 5,
  });
  assert.ok(
    result.coveredIds.includes("heavy"),
    `the heavier invasion is covered when both land in the same window (covered: ${JSON.stringify(result.coveredIds)})`,
  );

  // When the lighter invasion lands clearly earlier (outside the bucket), the
  // earlier landing is covered first regardless of threat.
  const earlyLight = {
    id: "early-light",
    threat: 100,
    // Lands at tick 3.
    path: [tile(50, 0), tile(51, 0), tile(52, 0), tile(53, 0)],
  };
  const lateHeavy = {
    id: "late-heavy",
    threat: 1000,
    // Lands at tick 30 — well outside the 10-tick bucket.
    path: Array.from({ length: 31 }, (_, i) => tile(50 - i, 0)),
  };
  const earlyResult = planNavalInterceptions({
    ships: [{ id: "warship-2", tile: tile(50, 0) }],
    invasions: [earlyLight, lateHeavy],
    route: (from, to) => [from, to],
    distance: (a, b) => Math.abs(Number(a) - Number(b)),
    targetDistanceSquared: (a, b) => {
      const d = Math.abs(Number(a) - Number(b));
      return d * d;
    },
    boatSpeed: 1,
    warshipSpeed: 1,
    attackRange: 5,
  });
  assert.ok(
    earlyResult.coveredIds.includes("early-light"),
    `an earlier landing keeps priority over a later heavier one outside the threat bucket (covered: ${JSON.stringify(earlyResult.coveredIds)})`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Warship fleet focus-fire picks the most-reachable enemy as primary target
// ════════════════════════════════════════════════════════════════════════════
{
  // Load warshipBehavior in a minimal sandbox. We only exercise the pure
  // chooseFleetFocusTarget helper, which takes unit lists and returns an id.
  const warshipSource = read("engine/ingame/auto-bot/warshipBehavior.js");
  const warshipSandbox = {
    UNIT: {
      Warship: "Warship",
      TransportShip: "TransportShip",
      TradeShip: "TradeShip",
      Port: "Port",
    },
    Difficulty: { Legendary: "Legendary" },
    currentDifficulty: () => "Legendary",
    state: { settings: { winFixes: true, features: { warship: true } } },
    BigInt,
    Math,
    Number,
    isFinite,
    isNaN,
    Array,
    Object,
    Map,
    Set,
    Date,
    JSON,
    Error,
    Reflect,
    Symbol,
    Promise,
    performance: { now: () => 0 },
    console,
    Infinity,
    NaN,
    undefined,
  };
  warshipSandbox.globalThis = warshipSandbox;
  warshipSandbox.window = warshipSandbox;
  executeClassicScript(
    `${warshipSource}\nglobalThis.WarshipBehavior = WarshipBehavior;`,
    warshipSandbox,
    {
      filename: "warshipBehavior.js",
    },
  );
  const behavior = Object.create(warshipSandbox.WarshipBehavior.prototype);
  behavior.game = makeFakeGame();
  behavior.player = { smallID: () => 0 };

  // Three of my warships near enemy A (tile 100), one near enemy B (tile 500).
  // Enemy A is lower HP. Primary should be A (more votes, lower HP tie-break).
  const myWarships = [
    { id: () => "w1", tile: () => 90, health: () => 1000, maxHealth: () => 1000 },
    { id: () => "w2", tile: () => 95, health: () => 1000, maxHealth: () => 1000 },
    { id: () => "w3", tile: () => 98, health: () => 1000, maxHealth: () => 1000 },
    { id: () => "w4", tile: () => 490, health: () => 1000, maxHealth: () => 1000 },
  ];
  const enemyWarships = [
    { id: () => "A", tile: () => 100, health: () => 200 },
    { id: () => "B", tile: () => 500, health: () => 800 },
  ];
  const primary = behavior.chooseFleetFocusTarget(myWarships, enemyWarships);
  assert.equal(
    primary,
    "A",
    "the fleet focus target is the enemy the most warships can reach, tie-broken by lowest HP",
  );

  // When no enemy is reachable, no primary is nominated.
  const farEnemies = [{ id: () => "far", tile: () => 9000, health: () => 100 }];
  assert.equal(
    behavior.chooseFleetFocusTarget(myWarships, farEnemies),
    null,
    "no reachable enemy yields no fleet focus target",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Donation ranker tie-breaks toward the ally with higher outgoing commitment
// ════════════════════════════════════════════════════════════════════════════
{
  // rankTeamDonationCandidates lives in attackBehavior's shared scope. Load it.
  const attackSource = read("engine/ingame/auto-bot/attackBehavior.js");
  const attackSandbox = {
    UNIT: {
      Warship: "Warship",
      TransportShip: "TransportShip",
      MissileSilo: "MissileSilo",
      SAMLauncher: "SAMLauncher",
      City: "City",
      Factory: "Factory",
      Port: "Port",
    },
    Difficulty: {
      Easy: "Easy",
      Medium: "Medium",
      Hard: "Hard",
      Impossible: "Impossible",
      Legendary: "Legendary",
    },
    PlayerType: { Bot: "Bot", Nation: "Nation", Human: "Human" },
    Relation: { Hostile: -1, Neutral: 0, Friendly: 1 },
    GameMode: { FFA: "FFA", Team: "Team" },
    currentDifficulty: () => "Legendary",
    state: { settings: { winFixes: true } },
    BigInt,
    Math,
    Number,
    isFinite,
    isNaN,
    Array,
    Object,
    Map,
    Set,
    Date,
    JSON,
    Error,
    Reflect,
    Symbol,
    Promise,
    performance: { now: () => 0 },
    console,
    Infinity,
    NaN,
    undefined,
    EARLY_EXPAND_COMMIT: 0.1,
    EARLY_EXPAND_OPENING_LIMIT: 0.4,
    EARLY_EXPAND_FOLLOWUP_COMMIT: 0.1,
    EARLY_EXPAND_MINIMUM_MARGIN: 1.25,
    EARLY_EXPAND_OPENING_REBASE_RATIO: 1.25,
  };
  attackSandbox.globalThis = attackSandbox;
  attackSandbox.window = attackSandbox;
  executeClassicScript(
    `${attackSource}\nglobalThis.__rankTeamDonationCandidates = rankTeamDonationCandidates;`,
    attackSandbox,
    {
      filename: "attackBehavior.js",
    },
  );
  const rank = attackSandbox.__rankTeamDonationCandidates;

  // Two allies: identical on every prior axis, differ only in outgoing troops.
  const passive = {
    underAttack: false,
    frontline: false,
    distance: 50,
    troopPercentage: 0.3,
    sameClan: false,
    outgoingTroops: 0,
  };
  const aggressive = {
    underAttack: false,
    frontline: false,
    distance: 50,
    troopPercentage: 0.3,
    sameClan: false,
    outgoingTroops: 5000,
  };
  const ranked = rank([passive, aggressive]);
  assert.equal(
    ranked[0],
    aggressive,
    "an ally with higher outgoing attack commitment wins the offensive-value tie-break",
  );

  // Offensive value is a pure tie-breaker: a closer ally wins regardless.
  const close = {
    underAttack: false,
    frontline: false,
    distance: 10,
    troopPercentage: 0.3,
    sameClan: false,
    outgoingTroops: 0,
  };
  const far = {
    underAttack: false,
    frontline: false,
    distance: 100,
    troopPercentage: 0.3,
    sameClan: false,
    outgoingTroops: 99999,
  };
  const distanceRanked = rank([far, close]);
  assert.equal(
    distanceRanked[0],
    close,
    "offensive value never overrides the distance axis (closer ally still wins)",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 5. SAM placement extends the umbrella instead of stacking a duplicate circle
// ════════════════════════════════════════════════════════════════════════════
{
  const UNIT = structureSandbox.UNIT;
  const tileAt = (x, y) => y * 1000 + x;
  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  behavior.game = makeFakeGame({
    config: () => ({
      defaultSamRange: () => 150,
      samRange: (level) => 150 - 480 / (Number(level || 1) + 5),
    }),
  });
  // City A is already defended by an existing friendly SAM; city B is exposed.
  behavior.player = {
    units: (type) =>
      type === UNIT.City
        ? [{ tile: () => tileAt(200, 200) }, { tile: () => tileAt(500, 200) }]
        : [],
  };
  behavior.legendaryFriendlySamUnits = () => [{ tile: () => tileAt(200, 200), level: () => 1 }];
  behavior.hasObservedHostileMissileLaunch = () => false;

  const ranker = behavior.structurePlacementCompactnessRanker(UNIT.SAMLauncher);
  assert.ok(ranker !== null, "winFixes SAM placement now produces a coverage ranker");
  const stackedNearCoveredCity = ranker(tileAt(210, 200));
  const extendingTowardExposedCity = ranker(tileAt(490, 200));
  assert.equal(
    stackedNearCoveredCity.samIncrementalCoverage,
    0,
    "a tile whose only protectable city is already covered adds nothing",
  );
  assert.equal(
    stackedNearCoveredCity.samDuplicateCoverage,
    1,
    "redundant coverage is recorded as a duplicate, not as new protection",
  );
  assert.equal(
    extendingTowardExposedCity.samIncrementalCoverage,
    1,
    "a tile covering the exposed city adds one new protected structure",
  );
  assert.equal(
    extendingTowardExposedCity.samDuplicateCoverage,
    0,
    "covering new ground is not counted as duplicate coverage",
  );
  // The comparator sends the launcher to the exposed flank even when the
  // stacked tile has the higher raw placement value.
  const ordering = behavior.compareStructurePlacementScores(
    {
      v: 100,
      compactness: stackedNearCoveredCity,
    },
    {
      v: 1,
      compactness: extendingTowardExposedCity,
    },
  );
  assert.ok(
    ordering > 0,
    "the exposed-flank SAM ranks above the stacked duplicate despite lower tile value",
  );

  // First-SAM case: with no existing launcher, a central tile covering both
  // cities (each within the level-1 range of 70) beats a flank tile covering
  // one.
  behavior.legendaryFriendlySamUnits = () => [];
  behavior.player = {
    units: (type) =>
      type === UNIT.City
        ? [{ tile: () => tileAt(320, 200) }, { tile: () => tileAt(380, 200) }]
        : [],
  };
  const centralRanker = behavior.structurePlacementCompactnessRanker(UNIT.SAMLauncher);
  const betweenBothCities = centralRanker(tileAt(350, 200));
  assert.equal(
    betweenBothCities.samIncrementalCoverage,
    2,
    "a first launcher between both cities protects all of them",
  );
  const flankBeyondOneCity = centralRanker(tileAt(600, 200));
  assert.equal(
    flankBeyondOneCity.samIncrementalCoverage,
    0,
    "a tile covering neither city adds no protection",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Missile structures refuse hydrogen blast co-location once nukes fly
// ════════════════════════════════════════════════════════════════════════════
{
  const UNIT = structureSandbox.UNIT;
  const tileAt = (x, y) => y * 1000 + x;
  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  behavior.game = makeFakeGame({
    config: () => ({
      defaultSamRange: () => 150,
      samRange: (level) => 150 - 480 / (Number(level || 1) + 5),
      nukeMagnitudes: (type) =>
        type === UNIT.HydrogenBomb ? { inner: 80, outer: 100 } : { inner: 12, outer: 30 },
    }),
  });
  behavior.player = {
    units: (type) => (type === UNIT.MissileSilo ? [{ tile: () => tileAt(200, 200) }] : []),
  };
  behavior.legendaryFriendlySamUnits = () => [];
  let hostileLaunchObserved = false;
  behavior.hasObservedHostileMissileLaunch = () => hostileLaunchObserved;

  const profileIdle = behavior.missileBlastColocationProfile(UNIT.MissileSilo);
  assert.equal(
    profileIdle,
    null,
    "before any observed hostile launch the co-location profile stays inactive",
  );

  hostileLaunchObserved = true;
  const profile = behavior.missileBlastColocationProfile(UNIT.MissileSilo);
  assert.ok(typeof profile === "function", "an observed launch activates the blast profile");
  assert.ok(
    profile(tileAt(240, 200)) > 0.59 && profile(tileAt(240, 200)) < 0.61,
    "a tile 40 tiles from the existing silo takes a 0.6 penalty against the 100-tile outer radius",
  );
  assert.equal(
    profile(tileAt(200, 200)),
    1,
    "building on the existing silo's tile takes the full penalty",
  );
  assert.equal(
    profile(tileAt(600, 200)),
    0,
    "a tile outside the hydrogen outer radius takes no penalty",
  );
  assert.equal(
    behavior.missileBlastColocationProfile(UNIT.City),
    null,
    "economic structures are not blast-spaced",
  );

  // Blast separation outranks umbrella clustering: a spaced tile wins even
  // when the clustered tile offers higher value and more shared SAM coverage.
  const clustered = {
    v: 100,
    compactness: {
      existingSamCoverage: 1,
      upgradeSamCoverage: 1,
      currentSamDistanceSquared: 4,
      samDistanceSquared: 4,
      sharedSamCoverage: 9,
      missileBlastColocationPenalty: 0.5,
    },
  };
  const spaced = {
    v: 1,
    compactness: {
      existingSamCoverage: 0,
      upgradeSamCoverage: 0,
      currentSamDistanceSquared: Number.POSITIVE_INFINITY,
      samDistanceSquared: Number.POSITIVE_INFINITY,
      sharedSamCoverage: 0,
      missileBlastColocationPenalty: 0,
    },
  };
  assert.ok(
    behavior.compareStructurePlacementScores(clustered, spaced) > 0,
    "a spaced missile structure beats a clustered one even with worse value and coverage",
  );
  // Without the penalty field the old ordering (value first) is preserved.
  const clusteredNoPenalty = {
    v: 100,
    compactness: { ...clustered.compactness, missileBlastColocationPenalty: undefined },
  };
  assert.ok(
    behavior.compareStructurePlacementScores(clusteredNoPenalty, spaced) < 0,
    "economic placements without the blast field still order by value",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 7. MIRV perceived cost tracks the global launch escalation
// ════════════════════════════════════════════════════════════════════════════
{
  const UNIT = structureSandbox.UNIT;
  const mirvGame = (mirvUnits) =>
    makeFakeGame({
      units: (type) => (type === UNIT.MIRV ? mirvUnits : []),
    });
  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  behavior.player = { units: () => [] };
  behavior.game = mirvGame([{ id: () => 11 }, { id: () => 12 }]);

  assert.equal(
    behavior.cost(UNIT.MIRV),
    25_000_000n + 2n * 15_000_000n,
    "two observed MIRV launches raise the perceived price to 55M",
  );
  assert.equal(
    behavior.cost(UNIT.MIRV),
    25_000_000n + 2n * 15_000_000n,
    "re-observing the same in-flight MIRVs does not double-count launches",
  );
  behavior.game = mirvGame([{ id: () => 11 }, { id: () => 12 }, { id: () => 13 }]);
  assert.equal(
    behavior.cost(UNIT.MIRV),
    25_000_000n + 3n * 15_000_000n,
    "a newly observed MIRV raises the perceived price by one 15M increment",
  );
  behavior.game = mirvGame([]);
  assert.equal(
    behavior.cost(UNIT.MIRV),
    25_000_000n + 3n * 15_000_000n,
    "observed launches are never forgotten while the flight history is retained",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// N. Arm-on-freeze strike silo (FFA mode-A survival lane)
// ════════════════════════════════════════════════════════════════════════════
{
  // Freeze-signature stub: FFA, endgame scale (50k+ tiles), troops pinned at
  // the cap, and a giant 1.5x our pool — the nuke-side survival signature.
  const freezeGame = (gameMode) =>
    makeFakeGame({
      config: () => ({
        gameConfig: () => ({ gameMode }),
        isUnitDisabled: () => false,
      }),
      players: () => [{ isPlayer: () => true, isAlive: () => true, troops: () => 200_000 }],
    });
  const freezePlayer = {
    numTilesOwned: () => 60_000,
    troops: () => 90_000,
    maxTroops: () => 100_000,
    gold: () => 20_000_000n,
    isFriendly: () => false,
  };
  const armBehavior = (gameMode, overrides = {}) => {
    const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
    behavior.game = freezeGame(gameMode);
    behavior.player = freezePlayer;
    behavior.ownedLevels = () => 0;
    behavior.safeConstructionCost = (type) =>
      type === structureSandbox.UNIT.MissileSilo ? 1_500_000n : 750_000n;
    behavior.spendableConstructionGold = () => 20_000_000n;
    behavior.spawned = [];
    behavior.maybeSpawnStructure = async (type, options) => {
      behavior.spawned.push({ type, options });
      return true;
    };
    for (const [key, value] of Object.entries(overrides)) {
      behavior[key] = value;
    }
    return behavior;
  };

  // Full signature + abundant treasury: the lane must buy the strike silo
  // through the economic reserve (the reserve is what froze mode-A builds).
  const armed = armBehavior("Free For All");
  assert.equal(
    await armed.maybeArmFreezeStrikeSilo(),
    true,
    "freeze signature + treasury buys the strike silo",
  );
  assert.equal(armed.spawned.length, 1, "exactly one arm buy is attempted");
  assert.equal(
    armed.spawned[0].type,
    structureSandbox.UNIT.MissileSilo,
    "the arm buy targets a MissileSilo",
  );
  assert.equal(
    armed.spawned[0].options?.ignoreEconomicReserve,
    true,
    "the arm buy bypasses the economic reserve",
  );

  // Team mode must exit at the gameMode gate without probing anything else.
  const teamProbe = armBehavior("team", {
    ownedLevels: () => {
      throw new Error("team mode must not probe silo ownership");
    },
  });
  assert.equal(
    await teamProbe.maybeArmFreezeStrikeSilo(),
    false,
    "team mode never arms the freeze lane",
  );

  // An existing launcher means the strike already has its tool: no second silo.
  assert.equal(
    await armBehavior("FFA", { ownedLevels: () => 1 }).maybeArmFreezeStrikeSilo(),
    false,
    "no second silo while a launcher exists",
  );

  // The 2-launchers + 1-bomb threshold is the abundance proof: below it the
  // lane must not divert the treasury the ordinary ladder is spending.
  assert.equal(
    await armBehavior("FFA", {
      spendableConstructionGold: () => 3_700_000n,
    }).maybeArmFreezeStrikeSilo(),
    false,
    "below 2 launchers + 1 bomb the lane stands down",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 9. Beachhead clearance ledger — landed sea invasions stay attackable after
// the invasion AttackExecution expires (the counterattack lane only cancels
// in-flight waves; the landing tile then sat hostile forever and 25/35 era
// rows failed the all-invasions-recaptured gate because of it).
{
  const attackSource = read("engine/ingame/auto-bot/attackBehavior.js");
  const attackSandbox = {
    UNIT: {
      Warship: "Warship",
      TransportShip: "TransportShip",
      MissileSilo: "MissileSilo",
      SAMLauncher: "SAMLauncher",
      City: "City",
      Factory: "Factory",
      Port: "Port",
    },
    Difficulty: {
      Easy: "Easy",
      Medium: "Medium",
      Hard: "Hard",
      Impossible: "Impossible",
      Legendary: "Legendary",
    },
    PlayerType: { Bot: "Bot", Nation: "Nation", Human: "Human" },
    Relation: { Hostile: -1, Neutral: 0, Friendly: 1 },
    GameMode: { FFA: "FFA", Team: "Team" },
    currentDifficulty: () => "Legendary",
    state: { settings: { winFixes: true } },
    BigInt,
    Math,
    Number,
    isFinite,
    isNaN,
    Array,
    Object,
    Map,
    Set,
    Date,
    JSON,
    Error,
    Reflect,
    Symbol,
    Promise,
    performance: { now: () => 0 },
    console,
    Infinity,
    NaN,
    undefined,
  };
  attackSandbox.globalThis = attackSandbox;
  attackSandbox.window = attackSandbox;
  executeClassicScript(
    attackSource +
      "\nglobalThis.__updateBeachheadLedger = updateBeachheadLedger;" +
      "\nglobalThis.__nextBeachheadRetakeCandidate = nextBeachheadRetakeCandidate;",
    attackSandbox,
    { filename: "attackBehavior.js" },
  );
  const updateLedger = attackSandbox.__updateBeachheadLedger;
  const nextCandidate = attackSandbox.__nextBeachheadRetakeCandidate;

  const ledger = new Map();
  updateLedger(ledger, [{ tile: 111, attackerKey: "k-foe", tick: 5000 }], () => false);
  assert.ok(ledger.has(111), "a hostile sea-invasion landing tile is recorded");

  // The invasion attack expires (no fresh observation) while the tile stays
  // hostile-held: the ledger must keep it actionable.
  updateLedger(ledger, [], () => false);
  assert.ok(
    ledger.has(111),
    "an expired invasion's beachhead stays actionable while hostile-held",
  );

  // Our side holds the tile again: recaptured, pruned.
  updateLedger(ledger, [], (tile) => tile === 111);
  assert.ok(!ledger.has(111), "a recaptured beachhead leaves the ledger");

  // Candidate selection: longest-standing beachhead first, per-tile cooldown.
  const ledger2 = new Map();
  updateLedger(
    ledger2,
    [
      { tile: 222, attackerKey: "a", tick: 100 },
      { tile: 333, attackerKey: "b", tick: 200 },
    ],
    () => false,
  );
  const attempts = new Map();
  let pick = nextCandidate(ledger2, 1000, 30, attempts);
  assert.ok(pick !== null && pick.tile === 222, "the longest-standing beachhead is retaken first");
  attempts.set(222, 990);
  pick = nextCandidate(ledger2, 1000, 30, attempts);
  assert.ok(pick !== null && pick.tile === 333, "a cooling tile defers to the next candidate");
  attempts.set(333, 980);
  assert.equal(
    nextCandidate(ledger2, 1000, 30, attempts),
    null,
    "an all-cooldown ledger yields no candidate",
  );
}

process.stdout.write("Legendary enhancements tests passed\n");
