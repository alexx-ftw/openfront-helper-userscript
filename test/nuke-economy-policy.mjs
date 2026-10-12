import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/nukeBehavior.js"),
  "utf8",
);
const mirvSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/mirvBehavior.js"),
  "utf8",
);
const sharedUtilsSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/shared-utils.js"),
  "utf8",
);

const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRV Warhead",
  TransportShip: "Transport Ship",
  TradeShip: "Trade Ship",
  Warship: "Warship",
};
let testDifficulty = "Impossible";
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
  currentDifficulty: () => testDifficulty,
  isLegendaryDifficulty: (difficulty) => difficulty === "Legendary",
  isAtLeastHardDifficulty: () => true,
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(sharedUtilsSource, sandbox, {
  filename: "shared-utils.vm.js",
});
executeClassicScript(
  `${source}\nglobalThis.__NukeBehavior = NukeBehavior; globalThis.__UniversalPathFinding = UniversalPathFinding;`,
  sandbox,
  {
    filename: "nuke-economy-policy.vm.js",
  },
);

let mirvBuildTile = null;
Object.assign(sandbox, {
  AllPlayers: {},
  EMOJI_NUKE: [],
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  sendAutoBotBuildOrUpgrade: (_menu, _buildable, tile) => {
    mirvBuildTile = tile;
    return true;
  },
  setLastAction() {},
  tr: (value) => value,
  respondToMIRV() {},
});
executeClassicScript(`${mirvSource}\nglobalThis.__MirvBehavior = MirvBehavior;`, sandbox, {
  filename: "mirv-economy-policy.vm.js",
});

const behavior = Object.create(sandbox.__NukeBehavior.prototype);
const target = { smallID: () => 42 };

// Production-shape value retarget: the UI's Legendary tier normalizes to the
// Impossible raw value, so the higher-value retry must run through the policy
// tier bridge — and compare candidate sets by their ranked blast score.
{
  const previousDifficulty = testDifficulty;
  const previousUnion = sandbox.isLegendaryDifficulty;
  sandbox.isLegendaryDifficulty = (difficulty) =>
    difficulty === "Legendary" || difficulty === "Impossible";
  testDifficulty = sandbox.Difficulty.Impossible;
  const ladderTarget = { smallID: () => 43 };
  const richerTarget = { smallID: () => 44 };
  // Raw-value comparison would keep the 400-value ladder shot; the ranked
  // blast score (value + coverage) favors the richer rival's 380-value tile.
  const ladderCandidates = [{ tile: 10, value: 400, score: 12_900 }];
  const richerCandidates = [{ tile: 30, value: 380, score: 45_380 }];
  const retryBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  retryBehavior.samDemandStrikeTarget = () => null;
  retryBehavior.collectNukeCandidates = async (candidateTarget) =>
    candidateTarget === richerTarget ? richerCandidates : ladderCandidates;
  retryBehavior.findHighestValueNukeTarget = () => richerTarget;
  retryBehavior.shouldDeferNukeForEconomy = async () => false;
  retryBehavior.playerStructureValue = (candidateTarget) =>
    candidateTarget === richerTarget ? 3_000_000 : 100_000;
  const normalUiRetry = await retryBehavior.collectCandidatesWithRetry(
    ladderTarget,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    sandbox.currentDifficulty(),
  );
  assert.equal(
    normalUiRetry.retargeted,
    richerTarget,
    "the normal Legendary UI tier retargets to the richer rival when the ladder is blocked",
  );
  assert.equal(normalUiRetry.list, richerCandidates);
  assert.equal(
    retryBehavior.bestCandidateValue([{ tile: 1, value: 10, score: 60 }]),
    60,
    "candidate comparison reads the ranked blast score, not the raw value",
  );
  sandbox.isLegendaryDifficulty = previousUnion;
  testDifficulty = previousDifficulty;
}

// Production-shape targeting cohesion: the normalized Impossible tier must
// partition SAM-covered candidates into the salvo lane, price blast-covered
// SAMs, and keep the structure-density fallback alive.
{
  const previousDifficulty = testDifficulty;
  const previousUnion = sandbox.isLegendaryDifficulty;
  const previousClosest = sandbox.closestTwoTiles;
  sandbox.isLegendaryDifficulty = (difficulty) =>
    difficulty === "Legendary" || difficulty === "Impossible";
  testDifficulty = sandbox.Difficulty.Impossible;
  const partitionBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  partitionBehavior.nukeSpawn = () => 5;
  partitionBehavior.isTrajectoryInterceptableBySam = (_spawn, tile, excluded) =>
    tile === 20 && !excluded?.has("sam1");
  partitionBehavior.findEnemySamsCoveringTile = () => [{ id: () => "sam1", level: () => 1 }];
  const partitioned = partitionBehavior.partitionCandidatesBySamCoverage(
    [
      { tile: 20, value: 1 },
      { tile: 30, value: 2 },
    ],
    UNIT.AtomBomb,
    sandbox.Difficulty.Impossible,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(partitioned.covered)),
    [{ tile: 20, value: 1, coveringSamLevels: 1 }],
    "the normalized tier routes SAM-covered candidates to the salvo lane",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(partitioned.clear)),
    [{ tile: 30, value: 2, coveringSamLevels: 0 }],
    "clear trajectories stay directly fireable under the normalized tier",
  );

  const scoreBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  scoreBehavior.game = {
    config: () => ({ nukeMagnitudes: () => ({ inner: 2, outer: 3 }) }),
    euclideanDistSquared: (tile, unitTile) => (unitTile === tile ? 0 : 10_000),
    nearbyUnits: () => [],
  };
  scoreBehavior.recentlySentNukes = [];
  scoreBehavior.friendlyFirePenalty = () => 0;
  sandbox.closestTwoTiles = (_game, siloTiles, targetTiles) => ({
    x: siloTiles[0],
    y: targetTiles[0],
  });
  const samBlastScore = scoreBehavior.nukeTileScore(
    100,
    [{ tile: () => 100 }],
    [{ type: () => UNIT.SAMLauncher, level: () => 1, tile: () => 100 }],
    UNIT.AtomBomb,
  );
  assert.equal(
    samBlastScore,
    100_000,
    "a blast covering a SAM prices the counterforce value instead of scoring zero",
  );

  // Target-distance ranking must use ready silo origins. A cooling near silo
  // cannot make a remote tile look like an easy delivery for a distant ready
  // tube; when every tube is cooling, preserve the prior fallback ordering.
  const siloDistanceInputs = [];
  sandbox.autoBotBuildNukeSlots = (_game, player) => player.projectedSlots;
  sandbox.closestTwoTiles = (_game, siloTiles, targetTiles) => {
    siloDistanceInputs.push(siloTiles);
    return { x: siloTiles[0], y: targetTiles[0] };
  };
  scoreBehavior.player = {
    projectedSlots: new Map([
      ["ready", 1],
      ["cooling", 0],
    ]),
  };
  const readySilo = { id: () => "ready", tile: () => 300 };
  const coolingSilo = { id: () => "cooling", tile: () => 100 };
  scoreBehavior.nukeTileScore(100, [coolingSilo, readySilo], [], UNIT.AtomBomb);
  assert.deepEqual(
    siloDistanceInputs.at(-1),
    [300],
    "target proximity is measured from the ready silo, not the closer cooling silo",
  );
  scoreBehavior.player.projectedSlots = new Map([
    ["ready", 0],
    ["cooling", 0],
  ]);
  scoreBehavior.nukeTileScore(100, [coolingSilo, readySilo], [], UNIT.AtomBomb);
  assert.deepEqual(
    siloDistanceInputs.at(-1),
    [100, 300],
    "when no silo has a ready slot, the ranking retains the live-silo fallback",
  );

  const ladderBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  ladderBehavior.random = { chance: () => false };
  ladderBehavior.attackBehavior = {
    findIncomingAttackPlayer: () => null,
    shouldAttack: () => true,
  };
  ladderBehavior.findTwoPlayerNukeTarget = () => null;
  ladderBehavior.findStrategicBorderArmyTarget = () => null;
  ladderBehavior.findDominantCrownNukeTarget = () => null;
  ladderBehavior.findAllyNukeTarget = () => null;
  ladderBehavior.findHostileNukeTarget = () => null;
  ladderBehavior.findFFACrownTarget = () => null;
  ladderBehavior.findStrongestTeamTarget = () => null;
  ladderBehavior.player = {
    smallID: () => 1,
    gold: () => 100_000_000n,
  };
  const denseOwner = {
    smallID: () => 2,
    type: () => "Human",
    isAlive: () => true,
    numTilesOwned: () => 10,
    units: () => [
      { type: () => UNIT.City, level: () => 3 },
      { type: () => UNIT.City, level: () => 2 },
    ],
  };
  const sparseOwner = {
    smallID: () => 3,
    type: () => "Human",
    isAlive: () => true,
    numTilesOwned: () => 20,
    units: () => [{ type: () => UNIT.City, level: () => 1 }],
  };
  ladderBehavior.game = { players: () => [denseOwner, sparseOwner] };
  assert.equal(
    ladderBehavior.findBestNukeTarget(),
    denseOwner,
    "the structure-density fallback stays alive under the normalized tier",
  );
  sandbox.isLegendaryDifficulty = previousUnion;
  sandbox.closestTwoTiles = previousClosest;
  testDifficulty = previousDifficulty;
}

// Team-support rescue lane: a permanent teammate under invasion outranks the
// crown/density lanes; teammate attackers, null attackers and non-positive
// pressures are ignored, and the largest aggregate invader wins.
{
  const previousDifficulty = testDifficulty;
  const previousTeammates = sandbox.playersArePermanentTeammates;
  testDifficulty = sandbox.Difficulty.Legendary;
  const rescueBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  rescueBehavior.random = { chance: () => false };
  rescueBehavior.attackBehavior = {
    findIncomingAttackPlayer: () => null,
    shouldAttack: () => true,
  };
  rescueBehavior.findTwoPlayerNukeTarget = () => null;
  rescueBehavior.findStrategicBorderArmyTarget = () => null;
  rescueBehavior.findDominantCrownNukeTarget = () => null;
  rescueBehavior.findAllyNukeTarget = () => null;
  rescueBehavior.findHostileNukeTarget = () => null;
  rescueBehavior.findFFACrownTarget = () => null;
  rescueBehavior.findStrongestTeamTarget = () => null;
  rescueBehavior.findLegendaryStructureTarget = () => null;
  rescueBehavior.player = { smallID: () => 1 };
  const aggressor = { smallID: () => 7, isAlive: () => true };
  const teammateAttacker = { smallID: () => 8, isAlive: () => true };
  const underSiegeAlly = {
    smallID: () => 9,
    isAlive: () => true,
    incomingAttacks: () => [
      { attacker: () => aggressor, troops: () => 12_000 },
      { attacker: () => teammateAttacker, troops: () => 99_999 },
      { attacker: () => null, troops: () => 50_000 },
      { attacker: () => aggressor, troops: () => -5 },
    ],
  };
  const quietPlayer = { smallID: () => 10, isAlive: () => true };
  rescueBehavior.game = { players: () => [underSiegeAlly, quietPlayer] };
  sandbox.playersArePermanentTeammates = (a, b) => {
    const ids = [a.smallID(), b.smallID()];
    return ids.includes(1) && (ids.includes(8) || ids.includes(9));
  };
  assert.equal(
    rescueBehavior.findBestNukeTarget(),
    aggressor,
    "the largest teammate invader outranks the crown/density lanes",
  );
  underSiegeAlly.incomingAttacks = () => [];
  assert.equal(
    rescueBehavior.findAllyRescueNukeTarget(),
    null,
    "an uninvaded team keeps the ordinary ladder",
  );
  sandbox.playersArePermanentTeammates = previousTeammates;
  testDifficulty = previousDifficulty;
}

const policyCalls = [];
behavior.structureBehavior = {
  shouldDeferOffensiveNuke: (cost) => {
    policyCalls.push(cost);
    return true;
  },
};
behavior.attackBehavior = { findIncomingAttackPlayer: () => null };
behavior.isUnderHeavyAttack = () => false;

const legendaryHydroSpecialist = Object.create(sandbox.__NukeBehavior.prototype);
legendaryHydroSpecialist.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
legendaryHydroSpecialist.player = { gold: () => 1_000_000n };
legendaryHydroSpecialist.isHydroNation = true;
legendaryHydroSpecialist.isUnderHeavyAttack = () => false;
legendaryHydroSpecialist.getPerceivedNukeCost = async (type) =>
  type === UNIT.HydrogenBomb ? 5_000_000n : 750_000n;
testDifficulty = sandbox.Difficulty.Legendary;
const legendaryFallbackNuke = await legendaryHydroSpecialist.selectAffordableNuke();
assert.equal(legendaryFallbackNuke?.type, UNIT.AtomBomb);
assert.equal(
  legendaryFallbackNuke?.cost,
  750_000n,
  "Legendary uses an affordable Atom instead of leaving a ready Silo idle while saving for Hydrogen",
);
testDifficulty = sandbox.Difficulty.Impossible;
// Merged semantics: the atom fallback is now LEGENDARY-ONLY, so the
// Impossible hydro specialist (unaffordable Hydro, no Atom allowed)
// declines to fire rather than leaving a ready Silo idle.
const impossibleFallbackNuke = await legendaryHydroSpecialist.selectAffordableNuke();
assert.equal(impossibleFallbackNuke, null);

const nukeSelf = {
  smallID: () => 1,
  isOnSameTeam: () => false,
  isFriendly: () => false,
  allRelationsSorted: () => [],
};
const weakerHostileNation = {
  smallID: () => 2,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Bot,
};
const hostileTargetBehavior = Object.create(sandbox.__NukeBehavior.prototype);
hostileTargetBehavior.player = {
  ...nukeSelf,
  allRelationsSorted: () => [{ relation: "Hostile", player: weakerHostileNation }],
};
hostileTargetBehavior.game = {
  config: () => ({ maxTroops: (player) => (player === nukeSelf ? 200 : 50) }),
};
hostileTargetBehavior.attackBehavior = { shouldAttack: () => true };
assert.equal(
  hostileTargetBehavior.findHostileNukeTarget(),
  weakerHostileNation,
  "a weaker hostile nation remains a valid automatic nuclear target",
);
assert.equal(
  hostileTargetBehavior.isValidNukeTarget(weakerHostileNation),
  true,
  "a hostile Bot-type opponent is eligible when the normal attack policy allows it",
);

testDifficulty = sandbox.Difficulty.Legendary;
const makeArmyPlayer = (id, troops) => ({
  smallID: () => id,
  team: () => null,
  isAlive: () => true,
  troops: () => troops,
});
const makeThreatSelector = ({ threatTroops = 1_000_000, targetable = true } = {}) => {
  const self = makeArmyPlayer(1, 1_000_000);
  const relationTarget = makeArmyPlayer(2, 1_250_000);
  const borderLeader = makeArmyPlayer(3, threatTroops);
  const selector = Object.create(sandbox.__NukeBehavior.prototype);
  selector.player = self;
  selector.game = {
    ticks: () => 2083,
    players: () => [self, relationTarget, borderLeader],
  };
  selector.attackBehavior = {
    findIncomingAttackPlayer: () => null,
    shouldAttack: () => targetable,
    getPendingOutboundAttackTroops: () => 0,
  };
  selector.structureBehavior = {
    strongestQuietStrategicBorderOpponent: () => ({
      opponentSid: 3,
      troops: threatTroops,
    }),
  };
  selector.isRichestNation = () => true;
  selector.random = { chance: () => true };
  selector.findHighDensityTarget = () => relationTarget;
  selector.findDominantCrownNukeTarget = () => null;
  selector.findAllyNukeTarget = () => null;
  selector.findHostileNukeTarget = () => null;
  selector.findFFACrownTarget = () => null;
  selector.findStrongestTeamTarget = () => null;
  selector.findLegendaryStructureTarget = () => null;
  return { selector, relationTarget, borderLeader };
};
{
  const { selector, borderLeader } = makeThreatSelector();
  assert.equal(
    selector.findBestNukeTarget(),
    borderLeader,
    "Legendary prioritizes a hostile border army at parity over the generic density target",
  );
}
{
  const { selector, borderLeader } = makeThreatSelector({ threatTroops: 800_000 });
  selector.attackBehavior.getPendingOutboundAttackTroops = (forceRefresh) => {
    assert.equal(forceRefresh, true, "border priority refreshes pending debits in the same tick");
    return 250_000;
  };
  assert.equal(
    selector.findBestNukeTarget(),
    borderLeader,
    "a border army above the unreflected garrison preempts density while an attack debit is pending",
  );
}
{
  const { selector, relationTarget } = makeThreatSelector({ threatTroops: 0 });
  selector.attackBehavior.getPendingOutboundAttackTroops = () => 1_000_000;
  assert.equal(
    selector.findBestNukeTarget(),
    relationTarget,
    "an empty border army is not treated as a threat when no garrison troops remain",
  );
}
{
  const { selector, relationTarget } = makeThreatSelector();
  selector.attackBehavior.findIncomingAttackPlayer = () => relationTarget;
  assert.equal(
    selector.findBestNukeTarget(),
    relationTarget,
    "an active retaliation target remains ahead of the preemptive border-force target",
  );
  selector.attackBehavior.findIncomingAttackPlayer = () => null;
  selector.structureBehavior.strongestQuietStrategicBorderOpponent = () => ({
    opponentSid: 3,
    troops: 999_999,
  });
  assert.equal(
    selector.findBestNukeTarget(),
    relationTarget,
    "a border force below our troop count does not preempt the ordinary target ladder",
  );
  selector.structureBehavior.strongestQuietStrategicBorderOpponent = () => ({
    opponentSid: 3,
    troops: 1_000_000,
  });
  selector.attackBehavior.shouldAttack = () => false;
  assert.equal(
    selector.findBestNukeTarget(),
    relationTarget,
    "the counterforce target must still pass the normal attackability policy",
  );
}

testDifficulty = sandbox.Difficulty.Legendary;
const observedSelf = makeArmyPlayer(1, 1_000_000);
const ordinaryNukeTarget = makeArmyPlayer(2, 1_250_000);
const nuclearAttacker = makeArmyPlayer(3, 900_000);
const unrelatedMissileOwner = makeArmyPlayer(4, 800_000);
const neutralBlastAttacker = makeArmyPlayer(5, 700_000);
const friendlyAlly = makeArmyPlayer(6, 600_000);
observedSelf.team = () => "Alpha";
friendlyAlly.team = () => "Alpha";
const friendlyAllyCity = { tile: () => 46 };
friendlyAlly.units = (type) => (type === UNIT.City ? [friendlyAllyCity] : []);
let activeHostileMissiles = [];
let observedTick = 8205;
nuclearAttacker.units = () => [];
unrelatedMissileOwner.units = () => [];
neutralBlastAttacker.units = () => [];
const threatObserver = Object.create(sandbox.__NukeBehavior.prototype);
threatObserver.player = observedSelf;
threatObserver.game = {
  ticks: () => observedTick,
  players: () => [
    observedSelf,
    ordinaryNukeTarget,
    nuclearAttacker,
    unrelatedMissileOwner,
    neutralBlastAttacker,
    friendlyAlly,
  ],
  units: () => activeHostileMissiles,
  owner: (tile) => {
    if (tile === 20) return observedSelf;
    if (tile === 30) return ordinaryNukeTarget;
    return null;
  },
  config: () => ({ nukeMagnitudes: () => ({ outer: 15 }) }),
  euclideanDistSquared: (from, to) => (from - to) ** 2,
};
threatObserver.attackBehavior = {
  findIncomingAttackPlayer: () => null,
  shouldAttack: () => true,
};
threatObserver.structureBehavior = {
  strongestQuietStrategicBorderOpponent: () => null,
};
threatObserver.isRichestNation = () => false;
threatObserver.random = { chance: () => false };
threatObserver.findDominantCrownNukeTarget = () => null;
threatObserver.findAllyNukeTarget = () => null;
threatObserver.findHostileNukeTarget = () => null;
threatObserver.findFFACrownTarget = () => null;
threatObserver.findStrongestTeamTarget = () => null;
threatObserver.findLegendaryStructureTarget = () => ordinaryNukeTarget;
threatObserver._hostileNukeThreats = new Map();
activeHostileMissiles = [
  { owner: () => nuclearAttacker, targetTile: () => 20 },
  { owner: () => unrelatedMissileOwner, targetTile: () => 30 },
  { owner: () => observedSelf, targetTile: () => 20 },
  { owner: () => neutralBlastAttacker, targetTile: () => 40, type: () => UNIT.AtomBomb },
];
assert.equal(
  threatObserver.findBestNukeTarget(),
  ordinaryNukeTarget,
  "an incoming nuke without a live attacker silo leaves the ordinary target selected",
);
assert.equal(
  threatObserver._hostileNukeThreats.get(3),
  8205,
  "the bot remembers the owner of a hostile nuke aimed at its territory",
);
assert.equal(
  threatObserver._hostileNukeThreats.has(4),
  false,
  "a nuke aimed at a different opponent does not create a counterforce threat",
);
assert.equal(
  threatObserver._hostileNukeThreats.get(5),
  8205,
  "a hostile nuke centered on neutral land is remembered when its blast reaches a permanent teammate structure",
);
const replacementSilo = {
  isActive: () => true,
  isUnderConstruction: () => false,
};
nuclearAttacker.units = (type) => (type === UNIT.MissileSilo ? [replacementSilo] : []);
activeHostileMissiles = [];
observedTick = 8871;
assert.equal(
  threatObserver.findBestNukeTarget(),
  ordinaryNukeTarget,
  "the remembered attacker does not override normal target selection when its replacement silo appears",
);
observedTick = 9106;
threatObserver.observeHostileNukeThreats();
assert.equal(
  threatObserver._hostileNukeThreats.has(3),
  false,
  "counterforce reserve expires 901 ticks after the last observed missile",
);

let counterforceGold = 1_160_315n;
let siloTargets = [];
let emittedNukes = 0;
const counterforceTarget = {
  ...makeArmyPlayer(3, 900_000),
  units: (type) => (type === UNIT.MissileSilo ? siloTargets : []),
};
const counterforceSender = Object.create(sandbox.__NukeBehavior.prototype);
counterforceSender.player = {
  ...observedSelf,
  gold: () => counterforceGold,
  buildables: async () => [{ type: UNIT.AtomBomb, canBuild: true, cost: 750_000n }],
};
counterforceSender.game = {
  ticks: () => 8859,
  units: () => [],
  owner: () => null,
  euclideanDistSquared: (first, second) => (first - second) ** 2,
  config: () => ({ nukeMagnitudes: () => ({ outer: 100 }) }),
};
counterforceSender.attackBehavior = {
  findIncomingAttackPlayer: () => null,
  shouldAttack: () => true,
};
counterforceSender._hostileNukeThreats = new Map([[3, 8205]]);
counterforceSender._pendingNukeLaunches = [];
counterforceSender.isValidNukeTarget = () => true;
counterforceSender.isValidNukeDestination = () => true;
counterforceSender.nukeSpawn = () => 1;
counterforceSender.isTrajectoryInterceptableBySam = () => false;
counterforceSender.isUnderHeavyAttack = () => false;
counterforceSender.isRetaliationNukeTarget = () => false;
counterforceSender.getPerceivedNukeCost = async () => 750_000n;
counterforceSender.rememberSuccessfulNukeLaunch = async () => {};
const originalNukeEmitter = sandbox.sendAutoBotBuildOrUpgrade;
sandbox.sendAutoBotBuildOrUpgrade = () => {
  emittedNukes++;
  return true;
};
assert.equal(
  await counterforceSender.shouldHoldCounterforceNuke(
    1000,
    UNIT.AtomBomb,
    counterforceTarget,
    750_000n,
  ),
  true,
  "the shared launch policy reserves a second Atom cost after a hostile nuclear attack",
);
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget),
  false,
  "an ordinary city shot cannot spend the last Atom held for the nuclear attacker",
);
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget, 20),
  false,
  "a delayed city shot is not queued when it would spend the reserved Atom",
);
assert.equal(counterforceSender._pendingNukeLaunches.length, 0);
siloTargets = [{ tile: () => 1010, isActive: () => true }];
assert.equal(
  await counterforceSender.sendNuke(1005, UNIT.AtomBomb, counterforceTarget),
  true,
  "the reserved Atom can launch when its blast covers the remembered attacker's silo",
);
assert.equal(emittedNukes, 1);
siloTargets = [];
const unrelatedCounterforceTarget = {
  ...makeArmyPlayer(4, 900_000),
  units: (type) => (type === UNIT.MissileSilo ? [{ tile: () => 1010 }] : []),
};
assert.equal(
  await counterforceSender.sendNuke(1005, UNIT.AtomBomb, unrelatedCounterforceTarget),
  false,
  "a different owner's silo cannot consume the remembered attacker's reserve",
);
assert.equal(
  await counterforceSender.firePendingNukeLaunch(
    {
      tile: 1000,
      nukeType: UNIT.AtomBomb,
      targetPlayer: counterforceTarget,
      salvo: null,
    },
    0,
    false,
  ),
  "drop",
  "a queued city shot is dropped if a new threat makes it consume the reserved Atom",
);
counterforceGold = 1_500_000n;
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget),
  true,
  "surplus gold may fund an ordinary shot while leaving one Atom cost in reserve",
);
counterforceGold = 1_160_315n;
counterforceSender.isUnderHeavyAttack = () => true;
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget),
  true,
  "the existing heavy-attack emergency may spend the counterforce reserve",
);
const originalWinFixes = sandbox.state.settings.winFixes;
sandbox.state.settings.winFixes = false;
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget),
  true,
  "disabling winFixes restores ordinary nuke launches",
);
sandbox.state.settings.winFixes = originalWinFixes;
sandbox.sendAutoBotBuildOrUpgrade = originalNukeEmitter;

testDifficulty = sandbox.Difficulty.Impossible;

assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  true,
  "An ordinary offensive nuke yields to the shared economy/defense reserve",
);

testDifficulty = sandbox.Difficulty.Legendary;
const valueGuard = Object.create(sandbox.__NukeBehavior.prototype);
valueGuard.player = { gold: () => 10_000_000n };
valueGuard.game = {
  euclideanDistSquared: () => 0,
  config: () => ({
    nukeMagnitudes: () => ({ outer: 100 }),
  }),
};
valueGuard.isUnderHeavyAttack = () => false;
valueGuard.isRetaliationNukeTarget = () => false;
const cheapTarget = {
  smallID: () => 2,
  team: () => null,
  isAlive: () => true,
  units: () => [{ type: () => UNIT.City, level: () => 1, tile: () => 20 }],
};
valueGuard.nukeStructureValue = () => 25_000;
valueGuard.findEnemySamsCoveringTile = () => [];
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [{ isUnderConstruction: () => false, level: () => 1 }],
  ),
  false,
  "Legendary skips an ordinary nuke whose vulnerable value is below its launch cost",
);
const counterforceValueGuard = Object.create(sandbox.__NukeBehavior.prototype);
const counterforcePlayer = makeArmyPlayer(1, 1_000_000);
counterforceValueGuard.player = {
  ...counterforcePlayer,
  gold: () => 10_000_000n,
};
counterforceValueGuard.game = {
  ticks: () => 2083,
  players: () => [counterforceValueGuard.player, cheapTarget],
  euclideanDistSquared: () => 0,
  config: () => ({ nukeMagnitudes: () => ({ outer: 100 }) }),
};
counterforceValueGuard.attackBehavior = { shouldAttack: () => true };
counterforceValueGuard.structureBehavior = {
  strongestQuietStrategicBorderOpponent: () => ({
    opponentSid: 2,
    troops: 1_000_000,
  }),
};
counterforceValueGuard.isUnderHeavyAttack = () => false;
counterforceValueGuard.isRetaliationNukeTarget = () => false;
counterforceValueGuard.nukeStructureValue = () => 25_000;
assert.equal(
  await counterforceValueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "the selected parity-level strategic border force is a Legendary counterforce payoff even below structure replacement value",
);
const unrelatedTarget = { ...cheapTarget, smallID: () => 4 };
assert.equal(
  await counterforceValueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    unrelatedTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  false,
  "the counterforce expected-value bypass does not leak to an unrelated target",
);
valueGuard.isUnderHeavyAttack = () => true;
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "heavy defense keeps the emergency nuke path available despite negative value",
);
valueGuard.isUnderHeavyAttack = () => false;
valueGuard.isRetaliationNukeTarget = () => true;
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  false,
  "plain retaliation no longer bypasses the expected-value guard",
);

// Deliverable-capacity realism: a covered salvo is only authorized when the
// tubes can actually deliver it this window. Nominal levels parked behind
// missileTimerQueue cooldowns are not capacity (mirrors getAvailableSiloEntries).
const coolingCoveredTarget = {
  smallID: () => 9,
  team: () => null,
  isAlive: () => true,
  units: () => [{ type: () => UNIT.City, level: () => 3, tile: () => 20 }],
};
const richValue = () => 10_000_000;
const coveredSilo = (queueLength) => ({
  isUnderConstruction: () => false,
  level: () => 3,
  missileTimerQueue: () => Array.from({ length: queueLength }),
});
valueGuard.nukeStructureValue = richValue;
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 2 },
    coolingCoveredTarget,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [coveredSilo(3)],
  ),
  false,
  "a covered salvo is declined when every tube is cooling regardless of nominal levels",
);
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 2 },
    coolingCoveredTarget,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [coveredSilo(0)],
  ),
  true,
  "the same covered salvo is authorized once the tubes actually hold ready shots",
);
valueGuard.nukeStructureValue = () => 25_000;

// Production shape (cycle 14): currentDifficulty() maps the Legendary user
// setting to the Impossible raw value, so the policy-tier bridge — not raw
// equality — is what arms the expected-value guard in real runs.
sandbox.isLegendaryDifficulty = (difficulty) =>
  difficulty === "Legendary" || difficulty === "Impossible";
testDifficulty = sandbox.Difficulty.Impossible;
const prodShapeGuard = Object.create(sandbox.__NukeBehavior.prototype);
prodShapeGuard.player = { gold: () => 10_000_000n };
prodShapeGuard.game = {
  euclideanDistSquared: () => 0,
  config: () => ({ nukeMagnitudes: () => ({ outer: 100 }) }),
};
prodShapeGuard.isUnderHeavyAttack = () => false;
prodShapeGuard.isRetaliationNukeTarget = () => false;
prodShapeGuard.nukeStructureValue = () => 25_000;
const prodTarget = {
  smallID: () => 2,
  team: () => null,
  isAlive: () => true,
  units: () => [{ type: () => UNIT.City, level: () => 1, tile: () => 20 }],
};
assert.equal(
  await prodShapeGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    prodTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [{ isUnderConstruction: () => false, level: () => 1 }],
  ),
  false,
  "the Legendary policy tier evaluates the expected-value guard through the production Impossible alias",
);
const prodCounterforce = Object.create(sandbox.__NukeBehavior.prototype);
prodCounterforce.player = { gold: () => 10_000_000n };
prodCounterforce.game = {
  euclideanDistSquared: () => 0,
  config: () => ({ nukeMagnitudes: () => ({ outer: 100 }) }),
};
prodCounterforce.isUnderHeavyAttack = () => false;
prodCounterforce.isRetaliationNukeTarget = () => false;
prodCounterforce.nukeStructureValue = () => 25_000;
prodCounterforce.findStrategicBorderArmyTarget = () => ({ smallID: () => 2 });
assert.equal(
  await prodCounterforce.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    prodTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "the strategic-border counterforce bypass survives the production-shape bridge",
);
testDifficulty = sandbox.Difficulty.Hard;
assert.equal(
  await prodShapeGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    prodTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "Hard stays a pass-through tier under the production-shape bridge",
);
assert.deepEqual(
  policyCalls,
  [5_000_000n],
  "The nuke policy receives the selected nuke's actual perceived cost",
);

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
  return sent;
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
  // Engine Player.allies() deliberately omits permanent teammates.
  allies: () => [],
  targets: () => [],
};
behavior.player = me;
behavior.game = { players: () => [me, deadTeammate, teammate] };
assert.equal(
  behavior.findAllyNukeTarget(),
  teammateTarget,
  "nuclear targeting supports a permanent teammate's marked enemy",
);

const breakableAllyTarget = { smallID: () => 75 };
const breakableAlly = {
  smallID: () => 4,
  team: () => null,
  isAlive: () => true,
  targets: () => [breakableAllyTarget],
};
behavior.game = { players: () => [me, breakableAlly, teammate] };
assert.equal(
  behavior.findAllyNukeTarget(),
  teammateTarget,
  "a breakable diplomatic ally is not treated as a permanent nuclear ally",
);

const diplomaticNukeOwner = {
  smallID: () => 2,
  team: () => null,
};
const teamNukeOwner = {
  smallID: () => 3,
  team: () => "blue",
};
behavior.player = {
  smallID: () => 1,
  isFriendly: () => true,
  team: () => null,
};
behavior.game = {
  units: () => [
    {
      owner: () => diplomaticNukeOwner,
      targetTile: () => 0,
      type: () => UNIT.AtomBomb,
    },
  ],
  config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "a diplomatic ally's nuke suppresses our overlapping launch (upstream 34a8fe723)",
);
behavior.player.team = () => "blue";
behavior.game.units = () => [
  {
    owner: () => teamNukeOwner,
    targetTile: () => 0,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "a permanent teammate's nuke prevents a duplicate overlapping launch",
);
behavior.game.units = () => [
  {
    owner: () => ({ smallID: () => 1 }),
    targetTile: () => 0,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "our own in-flight nuke suppresses a duplicate overlapping launch",
);
behavior.game.units = () => [
  {
    owner: () => ({ smallID: () => 9 }),
    targetTile: () => 0,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "an enemy nuke in FFA suppresses a duplicate overlapping launch",
);
behavior.game.units = () => [
  {
    owner: () => ({ smallID: () => 9 }),
    targetTile: () => 0,
    type: () => UNIT.MIRVWarhead,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "an in-flight MIRV warhead suppresses a duplicate overlapping launch",
);
behavior.game.units = () => [
  {
    owner: () => ({ smallID: () => 9 }),
    targetTile: () => null,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  false,
  "a warhead without a target tile does not suppress",
);

// ── Upstream 34a8fe723 delta 2: enemyLandBlastCoverage grid math ────────────
{
  const tileOf = (x, y) => y * 100 + x;
  const own = { smallID: () => 1, isPlayer: () => true };
  const enemy = { smallID: () => 7, isPlayer: () => true };
  const terrain = {};
  const covBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  covBehavior.game = {
    x: (tile) => tile % 100,
    y: (tile) => Math.floor(tile / 100),
    isValidCoord: (x, y) => x >= 0 && x < 100 && y >= 0 && y < 100,
    ref: (x, y) => tileOf(x, y),
    owner: (tile) => (tile in terrain ? terrain[tile] : enemy),
    config: () => ({ nukeMagnitudes: () => ({ inner: 1, outer: 2 }) }),
  };
  covBehavior.player = { smallID: () => 1, isFriendly: (o) => o === own };
  const center = tileOf(50, 50);
  // Disk totals (inner 1, outer 2): 18 sampled weight; inner tiles count double.
  terrain[center] = own;
  assert.equal(
    covBehavior.enemyLandBlastCoverage(center, UNIT.AtomBomb),
    16 / 18,
    "own land at the blast center is wasted weight",
  );
  terrain[tileOf(50, 49)] = null;
  terrain[tileOf(50, 51)] = null;
  const innerWaste = covBehavior.enemyLandBlastCoverage(center, UNIT.AtomBomb);
  delete terrain[tileOf(50, 49)];
  delete terrain[tileOf(50, 51)];
  terrain[tileOf(52, 50)] = null;
  terrain[tileOf(48, 50)] = null;
  const outerWaste = covBehavior.enemyLandBlastCoverage(center, UNIT.AtomBomb);
  assert.equal(innerWaste, 12 / 18, "two wasted inner tiles lose double weight");
  assert.equal(outerWaste, 14 / 18, "two wasted outer tiles lose single weight");
  assert.ok(innerWaste < outerWaste, "inner-radius coverage counts double versus the outer ring");
}

// ── Upstream 34a8fe723 delta 2: coverage thresholds gate isScorableNukeTile ─
{
  sandbox.boundingBoxTiles = (gm, center) => [center];
  sandbox.randTerritoryTileArray = () => [1, 2];
  const gate = Object.create(sandbox.__NukeBehavior.prototype);
  gate.game = {
    owner: () => null,
    config: () => ({ gameConfig: () => ({ gameMode: "Free For All" }) }),
  };
  gate.player = { smallID: () => 1, isFriendly: () => false };
  gate.nukeSpawn = () => 7;
  gate.isNukeAlreadyLandingNear = () => false;
  gate.isTrajectoryInterceptableBySam = () => false;
  const ctx = (type) => ({
    range: 2,
    target: { smallID: () => 42 },
    type,
    difficulty: sandbox.Difficulty.Hard,
  });
  gate.enemyLandBlastCoverage = () => 0.2;
  assert.equal(
    gate.isScorableNukeTile(5, ctx(UNIT.AtomBomb)),
    -1,
    "an atom below 0.25 enemy-land coverage is not scorable",
  );
  gate.enemyLandBlastCoverage = () => 0.3;
  assert.equal(
    gate.isScorableNukeTile(5, ctx(UNIT.AtomBomb)),
    0.3,
    "an atom at 0.3 enemy-land coverage is scorable",
  );
  gate.enemyLandBlastCoverage = () => 0.3;
  assert.equal(
    gate.isScorableNukeTile(5, ctx(UNIT.HydrogenBomb)),
    -1,
    "a hydrogen below 0.4 enemy-land coverage is not scorable",
  );
  gate.enemyLandBlastCoverage = () => 0.5;
  assert.equal(
    gate.isScorableNukeTile(5, ctx(UNIT.HydrogenBomb)),
    0.5,
    "a hydrogen at 0.5 enemy-land coverage is scorable",
  );
}

// ── Upstream 34a8fe723 delta 2: per-tile value gate + coverage ranking ──────
{
  const col = Object.create(sandbox.__NukeBehavior.prototype);
  col.game = {
    ensureBorderTiles: async () => {},
    ticks: () => 100,
    config: () => ({ nukeMagnitudes: () => ({ outer: 2 }) }),
  };
  col.recentlySentNukes = [];
  col.isScorableNukeTile = (tile) => (tile === 1 ? 0.9 : 0.2);
  col.nukeTileScore = () => 0;
  const colTarget = { smallID: () => 42, units: () => [] };
  const previousDifficulty = testDifficulty;
  testDifficulty = sandbox.Difficulty.Hard;
  const hardList = await col.collectNukeCandidates(
    colTarget,
    UNIT.AtomBomb,
    [],
    sandbox.Difficulty.Hard,
  );
  assert.deepEqual(
    Array.from(hardList, (cand) => cand.tile),
    [1, 2],
    "Hard keeps value-0 tiles and ranks coverage-boosted score first",
  );
  assert.equal(hardList[0].value, 0, "the kept Hard candidate keeps its pure value");
  testDifficulty = sandbox.Difficulty.Impossible;
  const impossibleList = await col.collectNukeCandidates(
    colTarget,
    UNIT.AtomBomb,
    [],
    sandbox.Difficulty.Impossible,
  );
  assert.equal(
    impossibleList.length,
    0,
    "Impossible rejects every value-0 tile regardless of coverage",
  );
  testDifficulty = previousDifficulty;
}

// ── Upstream 34a8fe723 delta 4: allied-land eligibility + winner filter ─────
{
  testDifficulty = sandbox.Difficulty.Hard;
  const d4 = Object.create(sandbox.__NukeBehavior.prototype);
  const thirdParty = { smallID: () => 9, isPlayer: () => true };
  const afkAlly = { smallID: () => 8, isPlayer: () => true };
  const d4Target = { smallID: () => 42 };
  d4.player = {
    smallID: () => 1,
    // Honors treatAFKFriendly like the engine's PlayerImpl.isFriendly(other, n).
    isFriendly: (o, n) => o === afkAlly && n === true,
  };
  d4.game = {
    owner: (t) => {
      if (t === 3) return thirdParty;
      if (t === 4) return afkAlly;
      return null;
    },
  };
  assert.equal(
    d4.isValidNukeTile(3, d4Target),
    true,
    "a Hard FFA tile owned by a non-allied third player is eligible",
  );
  assert.equal(d4.isValidNukeTile(4, d4Target), false, "an AFK ally's tile is protected on Hard");
  const tileOf = (x, y) => y * 100 + x;
  const own = { smallID: () => 1 };
  const grid = {};
  const d4b = Object.create(sandbox.__NukeBehavior.prototype);
  d4b.player = { smallID: () => 1, isFriendly: () => true };
  d4b.game = {
    players: () => [own],
    x: (tile) => tile % 100,
    y: (tile) => Math.floor(tile / 100),
    isValidCoord: (x, y) => x >= 0 && x < 100 && y >= 0 && y < 100,
    ref: (x, y) => tileOf(x, y),
    ownerID: (tile) => grid[tile] ?? 999,
    config: () => ({ nukeMagnitudes: () => ({ outer: 2 }) }),
  };
  assert.equal(
    d4b.blastHitsFriendlyLand(tileOf(50, 50), UNIT.AtomBomb),
    false,
    "a blast over pure enemy land hits nothing friendly",
  );
  grid[tileOf(52, 50)] = 1;
  assert.equal(
    d4b.blastHitsFriendlyLand(tileOf(50, 50), UNIT.AtomBomb),
    true,
    "an own enclave at the blast edge trips the friendly-land filter",
  );
  const walk = Object.create(sandbox.__NukeBehavior.prototype);
  walk.blastHitsFriendlyLand = (tile) => tile === 1;
  const probed = [];
  walk.probeCanBuildNuke = async (tile) => {
    probed.push(tile);
    return true;
  };
  const picked = await walk.selectBuildableNukeCandidate(
    [
      { tile: 1, value: 10 },
      { tile: 2, value: 5 },
    ],
    UNIT.AtomBomb,
  );
  assert.equal(picked.tile, 2, "the async probe walk skips a friendly-blast candidate");
  assert.deepEqual(probed, [2], "the friendly-blast candidate is never probed");
}

const breakableSamOwner = {
  smallID: () => 4,
  team: () => null,
};
const permanentSamOwner = {
  smallID: () => 5,
  team: () => "blue",
};
const samUnit = (owner, id) => ({
  owner: () => owner,
  id: () => id,
  level: () => 1,
});
const breakableSam = samUnit(breakableSamOwner, "breakable-sam");
const permanentSam = samUnit(permanentSamOwner, "team-sam");
const samRangeGame = {
  config: () => ({
    samRange: () => 10,
    maxSamRange: () => 10,
  }),
  nearbyUnits: () => [{ unit: breakableSam, distSquared: 1 }],
};
behavior.player = me;
behavior.game = samRangeGame;
assert.equal(
  behavior.isHostileSamIntercept({ unit: breakableSam, distSquared: 1 }, new Set()),
  true,
  "a breakable diplomatic ally's SAM can intercept a nuclear trajectory",
);
assert.deepEqual(
  Array.from(behavior.findEnemySamsCoveringTile(0), (sam) => sam.id()),
  ["breakable-sam"],
  "hostile-SAM search includes a breakable diplomatic ally's SAM",
);
behavior.game = {
  ...samRangeGame,
  nearbyUnits: () => [{ unit: permanentSam, distSquared: 1 }],
};
assert.equal(
  behavior.isHostileSamIntercept({ unit: permanentSam, distSquared: 1 }, new Set()),
  false,
  "a permanent teammate's SAM cannot intercept our nuclear trajectory",
);
assert.deepEqual(
  Array.from(behavior.findEnemySamsCoveringTile(0), (sam) => sam.id()),
  [],
  "hostile-SAM search excludes a permanent teammate's SAM",
);

const mirvEnemy = {
  id: () => "enemy-2",
  smallID: () => 2,
  isPlayer: () => true,
  type: () => "Human",
};
const mirvPlayer = {
  smallID: () => 1,
  isFriendly: () => false,
  units: () => [
    {
      isActive: () => true,
      isUnderConstruction: () => false,
      level: () => 1,
      missileTimerQueue: () => [],
    },
  ],
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvBehavior = new sandbox.__MirvBehavior(
  {},
  {
    ticks: () => 123,
    units: () => [],
    config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  },
  mirvPlayer,
  {
    maybeSendAttackEmoji() {},
    sendEmoji() {},
  },
);
mirvBehavior.calculateTerritoryCenter = async () => 0;
await mirvBehavior.maybeSendMIRV(mirvEnemy);
assert.equal(mirvBuildTile, 0, "a valid territory centre at tile zero still launches the MIRV");
assert.equal(
  sandbox.state.recentMirvHits.at(-1)?.tile,
  0,
  "the tile-zero MIRV impact is retained for the follow-up invasion",
);

mirvPlayer.smallID = () => 1;
const inboundTileZero = new sandbox.__MirvBehavior(
  {},
  {
    hasOwner: () => true,
    owner: () => ({ isPlayer: () => true, smallID: () => 1 }),
  },
  mirvPlayer,
  {},
);
assert.equal(
  inboundTileZero.isInboundMIRVFrom({
    units: () => [{ targetTile: () => 0 }],
  }),
  true,
  "an inbound MIRV aimed at owned tile zero is recognized as a threat",
);

const alliedMirvTarget = {
  smallID: () => 2,
  isPlayer: () => true,
  type: () => "Human",
};
const hostileMirvTarget = {
  smallID: () => 3,
  isPlayer: () => true,
  type: () => "Human",
};
const relationAwareMirvPlayer = {
  smallID: () => 1,
  isFriendly: (player) => player === alliedMirvTarget,
};
const relationAwareMirv = new sandbox.__MirvBehavior(
  {},
  { players: () => [relationAwareMirvPlayer, alliedMirvTarget, hostileMirvTarget] },
  relationAwareMirvPlayer,
  {},
);
assert.deepEqual(
  relationAwareMirv.getValidMirvTargetPlayers(),
  [hostileMirvTarget],
  "MIRV strategy excludes active allies as well as permanent teammates",
);

let mirvTargetFriendly = false;
const staleMirvTarget = {
  id: () => "stale-mirv-target",
  smallID: () => 4,
  isPlayer: () => true,
  type: () => "Human",
};
const staleMirvPlayer = {
  smallID: () => 1,
  isFriendly: () => mirvTargetFriendly,
  units: () => [
    {
      isActive: () => true,
      isUnderConstruction: () => false,
      level: () => 1,
      missileTimerQueue: () => [],
    },
  ],
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const staleMirvBehavior = new sandbox.__MirvBehavior(
  {},
  {
    ticks: () => 124,
    units: () => [],
    config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  },
  staleMirvPlayer,
  {
    maybeSendAttackEmoji() {},
    sendEmoji() {},
  },
);
staleMirvBehavior.calculateTerritoryCenter = async () => 7;
mirvBuildTile = null;
const pendingStaleMirv = staleMirvBehavior.maybeSendMIRV(staleMirvTarget);
mirvTargetFriendly = true;
await pendingStaleMirv;
assert.equal(
  mirvBuildTile,
  null,
  "a MIRV target that becomes friendly during async planning is not launched upon",
);

let distanceChecks = 0;
behavior.game = {
  config: () => ({ defaultNukeTargetableRange: () => 2 }),
  euclideanDistSquared: (left, right) => {
    distanceChecks += 1;
    return (left - right) ** 2;
  },
};
assert.deepEqual(
  { ...behavior.findUntargetableTrajectoryRange([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0, 10) },
  { start: 3, end: 9 },
  "The trajectory scan finds the bounded mid-air untargetable segment",
);
assert.ok(
  distanceChecks <= 22,
  "The trajectory scan terminates after a bounded number of distance checks",
);

const timingAwareSam = {
  id: () => "timing-sam",
  level: () => 1,
  tile: () => 10,
  owner: () => ({ smallID: () => 2 }),
};
const timingTrajectory = [0, 6, 7];
let timingSamSpeed = 2;
sandbox.__UniversalPathFinding.Parabola = () => ({
  findPath: () => timingTrajectory,
});
behavior.player = { smallID: () => 1 };
behavior.game = {
  config: () => ({
    defaultNukeSpeed: () => 10,
    defaultNukeTargetableRange: () => 100,
    defaultSamMissileSpeed: () => timingSamSpeed,
    maxSamRange: () => 5,
    samRange: () => 5,
  }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  manhattanDist: (left, right) => Math.abs(left - right),
  nearbyUnits: (tile) => {
    const distSquared = (tile - timingAwareSam.tile()) ** 2;
    return distSquared <= 25 ? [{ unit: timingAwareSam, distSquared }] : [];
  },
};
assert.equal(
  behavior.isTrajectoryInterceptableBySam(0, 7),
  false,
  "a SAM in geometric range cannot intercept when its missile arrives after the final in-flight tick",
);
timingSamSpeed = 4;
assert.equal(
  behavior.isTrajectoryInterceptableBySam(0, 7),
  true,
  "a SAM remains able to intercept when its missile reaches the in-flight tile on the exact same tick",
);

let resolveNukeProbe;
let nukeBuilds = 0;
let staleNukeTargetAlive = true;
const staleNukeTarget = {
  smallID: () => 8,
  type: () => "Human",
  isAlive: () => staleNukeTargetAlive,
};
const staleNukePlayer = {
  buildables: () =>
    new Promise((resolve) => {
      resolveNukeProbe = resolve;
    }),
  gold: () => 10n,
  isOnSameTeam: () => false,
};
const staleNukeBehavior = Object.create(sandbox.__NukeBehavior.prototype);
staleNukeBehavior.game = { ticks: () => 500 };
staleNukeBehavior.player = staleNukePlayer;
staleNukeBehavior.attackBehavior = {
  shouldAttack: () => true,
};
sandbox.sendAutoBotBuildOrUpgrade = () => {
  nukeBuilds += 1;
  return true;
};
assert.equal(staleNukeBehavior.isEligibleNukeTarget(staleNukeTarget), true);
const pendingStaleNuke = staleNukeBehavior.sendNuke(12, UNIT.AtomBomb, staleNukeTarget);
staleNukeTargetAlive = false;
resolveNukeProbe([{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }]);
await pendingStaleNuke;
assert.equal(nukeBuilds, 0, "a target that becomes invalid during the worker probe is not nuked");

let scheduledTick = 600;
const scheduledBuilds = [];
sandbox.sendAutoBotBuildOrUpgrade = (_menu, buildable, tile) => {
  scheduledBuilds.push({ tick: scheduledTick, type: buildable.type, tile });
  return true;
};
const scheduledSilo = {
  id: () => "silo-1",
  tile: () => 0,
  level: () => 1,
  isActive: () => true,
  isUnderConstruction: () => false,
  ticksLeftInCooldown: () => 0,
  missileTimerQueue: () => [],
};
const scheduledPlayer = {
  smallID: () => 1,
  isOnSameTeam: () => false,
  buildables: async () => [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true, canUpgrade: false }],
  gold: () => 10n,
  units: (type) => (type === UNIT.MissileSilo ? [scheduledSilo] : []),
};
const scheduledTarget = {
  smallID: () => 2,
  isAlive: () => true,
};
const scheduledSalvoBehavior = new sandbox.__NukeBehavior(
  { chance: () => false },
  { ticks: () => scheduledTick, manhattanDist: () => 1 },
  scheduledPlayer,
  { shouldAttack: () => true },
  { maybeSendEmoji() {} },
);
scheduledSalvoBehavior.cost = async () => 1n;
scheduledSalvoBehavior.isTrajectoryInterceptableBySam = () => false;
// This schedule test uses the plan's flight ticks, not a second pathfinding pass.
scheduledSalvoBehavior.getAvailableSiloEntries = () => [];
scheduledSalvoBehavior.getSamSalvo = () => ({
  bombsToFire: 2,
  waits: [0, 7],
});
const scheduledPlan = {
  targetTile: 20,
  totalBombs: 2,
  coveringSamIds: new Set(["enemy-sam"]),
  siloEntries: [{ silo: { id: () => "silo-1" }, interceptable: false }],
};
sandbox.state.nukeWantSlots = null;
assert.equal(
  await scheduledSalvoBehavior.fireSamSalvo(scheduledPlan, scheduledTarget, 1n),
  true,
  "a valid staggered salvo is accepted as one pending launch plan",
);
assert.deepEqual(
  scheduledBuilds,
  [{ tick: 600, type: UNIT.AtomBomb, tile: 20 }],
  "only the zero-wait bomb launches on the planning tick",
);
assert.equal(
  sandbox.state.nukeWantSlots?.pendingLaunches,
  true,
  "the silo reservation remains active until every delayed bomb is emitted",
);
scheduledTick = 607;
assert.equal(
  await scheduledSalvoBehavior.processPendingNukeLaunches(),
  true,
  "the delayed salvo bomb launches when its exact game tick becomes due",
);
assert.deepEqual(scheduledBuilds, [
  { tick: 600, type: UNIT.AtomBomb, tile: 20 },
  { tick: 607, type: UNIT.AtomBomb, tile: 20 },
]);
assert.equal(sandbox.state.nukeWantSlots, null);

const mirvStateReserve = 987n;
const readyMirvSilo = {
  isActive: () => true,
  isUnderConstruction: () => false,
  level: () => 1,
  missileTimerQueue: () => [],
};
const exhaustedMirvSilo = {
  isActive: () => true,
  isUnderConstruction: () => false,
  level: () => 1,
  missileTimerQueue: () => [123],
};
const mirvActuationTarget = {
  id: () => "mirv-actuation-target",
  smallID: () => 9,
  isPlayer: () => true,
  type: () => "Human",
};
const mirvActuationPlayer = {
  smallID: () => 1,
  isFriendly: () => false,
  units: () => [readyMirvSilo],
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvActuationBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 700,
    units: () => [],
    config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  },
  mirvActuationPlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
mirvActuationBehavior.calculateTerritoryCenter = async () => 11;
assert.equal(
  await mirvActuationBehavior.maybeSendMIRV(mirvActuationTarget),
  true,
  "a successful MIRV build intent reports success",
);

const exhaustedMirvPlayer = {
  ...mirvActuationPlayer,
  units: () => [exhaustedMirvSilo],
};
const exhaustedMirvBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 701,
    units: () => [],
    config: () => ({
      isUnitDisabled: () => false,
      nukeMagnitudes: () => ({ inner: 10 }),
    }),
  },
  exhaustedMirvPlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await exhaustedMirvBehavior.considerMIRV(),
  false,
  "an exhausted Silo does not claim that MIRV consideration succeeded",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "an exhausted Silo preserves the MIRV reserve state",
);

exhaustedMirvBehavior.teamHasWon = () => true;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await exhaustedMirvBehavior.considerWinFixMIRV(1n),
  false,
  "a secured team victory does not need a ready MIRV slot",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  0n,
  "a secured team victory releases the MIRV reserve even while every Silo reloads",
);

const rejectedProbePlayer = {
  ...mirvActuationPlayer,
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: false }],
};
const rejectedProbeBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 702,
    units: () => [],
    config: () => ({ gameConfig: () => ({ gameMode: "FFA" }) }),
  },
  rejectedProbePlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
rejectedProbeBehavior.calculateTerritoryCenter = async () => 12;
rejectedProbeBehavior.selectWinFixMirvTarget = () => mirvActuationTarget;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await rejectedProbeBehavior.considerWinFixMIRV(1n),
  false,
  "a rejected MIRV probe does not claim that the win-fix launch succeeded",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "a rejected MIRV probe preserves the win-fix MIRV reserve state",
);

const firstEligibleRejectedBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 703,
    units: () => [],
    config: () => ({ gameConfig: () => ({ gameMode: "FFA" }) }),
  },
  rejectedProbePlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
firstEligibleRejectedBehavior.calculateTerritoryCenter = async () => 13;
firstEligibleRejectedBehavior.selectCounterMirvTarget = () => mirvActuationTarget;
firstEligibleRejectedBehavior.selectVictoryDenialTarget = () => null;
firstEligibleRejectedBehavior.selectSteamrollStopTarget = () => null;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await firstEligibleRejectedBehavior.sendFirstEligibleMIRV(),
  false,
  "the first eligible MIRV path reports false when its probe is rejected",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "a rejected first-eligible MIRV probe preserves decision state",
);

// ── Freeze-giant strike gates (FFA endgame survival lane) ──────────────────
{
  const giant = {
    isPlayer: () => true,
    isAlive: () => true,
    troops: () => 6_000_000,
  };
  const mk = ({
    mode = "FFA",
    tiles = 120_000,
    troops = 3_000_000,
    max = 3_200_000,
    winFixes = true,
    difficulty = "Legendary",
  }) => {
    const behavior = Object.create(sandbox.__NukeBehavior.prototype);
    behavior.game = {
      config: () => ({ gameConfig: () => ({ gameMode: mode }) }),
      players: () => [giant],
    };
    behavior.player = {
      numTilesOwned: () => tiles,
      troops: () => troops,
      maxTroops: () => max,
      isFriendly: (o) => o === behavior.player,
    };
    sandbox.state.settings.winFixes = winFixes;
    testDifficulty = difficulty;
    return behavior;
  };
  const fullSignature = mk({});
  assert.equal(
    fullSignature.freezeGiantStrikeTarget(),
    giant,
    "the full freeze signature nominates the strongest enemy",
  );
  assert.equal(
    mk({ tiles: 49_000 }).freezeGiantStrikeTarget(),
    null,
    "below endgame scale the lane stays dormant",
  );
  assert.equal(
    mk({ troops: 2_000_000, max: 3_200_000 }).freezeGiantStrikeTarget(),
    null,
    "an army with growth room keeps its options",
  );
  assert.equal(
    mk({ troops: 4_500_000 }).freezeGiantStrikeTarget(),
    null,
    "a non-outmuscling board never strikes first",
  );
  assert.equal(
    mk({ mode: "Team" }).freezeGiantStrikeTarget(),
    null,
    "team games keep their coordinated win clock",
  );
  assert.equal(
    mk({ winFixes: false }).freezeGiantStrikeTarget(),
    null,
    "the lane is win-fixes gated",
  );
  assert.equal(
    mk({ difficulty: "Impossible" }).freezeGiantStrikeTarget(),
    null,
    "the strike is Legendary-only",
  );
  sandbox.state.settings.winFixes = true;
  testDifficulty = "Impossible";
}

// Anti-SAM aim scoring must move the blast center with each candidate.
{
  const aimBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  const structures = [];
  const sam = {
    tile: () => ({ x: 0, y: 0 }),
    type: () => UNIT.SAMLauncher,
    level: () => 1,
    owner: () => ({ units: () => structures }),
  };
  structures.push(sam, {
    tile: () => ({ x: 8, y: 0 }),
    type: () => UNIT.MissileSilo,
    level: () => 1,
  });
  aimBehavior.game = {
    ticks: () => 1,
    players: () => [],
    config: () => ({ nukeMagnitudes: () => ({ outer: 5 }) }),
    x: (tile) => tile.x,
    y: (tile) => tile.y,
    ref: (x, y) => ({ x, y }),
    isValidCoord: () => true,
    euclideanDistSquared: (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2,
  };
  let friendlyStructures = [];
  aimBehavior.player = { smallID: () => 1, units: () => friendlyStructures };
  const ownPlayer = aimBehavior.player;
  ownPlayer.isFriendly = (other) => other.smallID?.() === ownPlayer.smallID();
  aimBehavior.game.players = () => [ownPlayer];
  aimBehavior.game.ownerID = (tile) =>
    friendlyStructures.some((unit) => {
      const unitTile = unit.tile();
      return unitTile.x === tile.x && unitTile.y === tile.y;
    })
      ? ownPlayer.smallID()
      : 0;
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 4, y: 0 },
    "aim between the SAM and silo to destroy both, instead of scoring every blast at the SAM",
  );
  friendlyStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => ({ x: 8, y: 1 }) },
  ];
  aimBehavior.game.ticks = () => 2;
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "replacement-value aim scoring must not trade our silo for an equally priced enemy silo",
  );
  friendlyStructures = [
    { type: () => UNIT.MissileSilo, level: () => 5, tile: () => ({ x: 8, y: 1 }) },
    { type: () => UNIT.SAMLauncher, level: () => 5, tile: () => ({ x: 8, y: 2 }) },
  ];
  aimBehavior.game.ticks = () => 3;
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "a salvo prefers destroying the SAM alone over the extra enemy silo plus a more valuable friendly defense cluster",
  );
  structures.splice(
    1,
    structures.length - 1,
    ...Array.from({ length: 12 }, () => ({
      tile: () => ({ x: 8, y: 0 }),
      type: () => UNIT.MissileSilo,
      level: () => 1,
    })),
  );
  friendlyStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => ({ x: 7, y: 0 }) },
  ];
  aimBehavior.game.ticks = () => 4;
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "a high-value enemy cluster cannot make the salvo aim inside friendly land",
  );
  friendlyStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => ({ x: 0, y: 4 }) },
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => ({ x: 4, y: 3 }) },
  ];
  aimBehavior.game.ticks = () => 5;
  assert.equal(
    aimBehavior.samSalvoAimTile(sam),
    null,
    "no aim is returned when every candidate blast reaches friendly land",
  );
  friendlyStructures = [];
  aimBehavior.game.ticks = () => 6;
  aimBehavior.game.config = () => ({ nukeMagnitudes: () => ({ outer: 4 }) });
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "the SAM must be strictly inside the blast, not on its indestructible outer boundary",
  );
  structures[1].tile = () => ({ x: 8, y: 8 });
  aimBehavior.game.config = () => ({ nukeMagnitudes: () => ({ outer: 6 }) });
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 4, y: 4 },
    "diagonal aim points use the engine's circular blast rather than Manhattan distance",
  );
}

// Idle-lane realism: with every tube cooling, maybeSendNuke must skip the
// full target ladder and candidate sweep instead of probing into a refusal.
{
  const idleBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  idleBehavior.player = { gold: () => 10_000_000n, units: () => [] };
  idleBehavior.hasPendingNukeLaunches = () => false;
  idleBehavior.canConsiderNukes = () => true;
  idleBehavior.findBestNukeTarget = () => {
    throw new Error("target ladder must not run with zero ready silo slots");
  };
  const emptyTubeBehavior = Object.create(idleBehavior);
  emptyTubeBehavior.readySiloShotCapacity = () => 0;
  await emptyTubeBehavior.maybeSendNuke();
  assert.equal(
    emptyTubeBehavior.decisionTelemetry.tubesEmpty,
    1,
    "an all-tubes-cooling decision records tubesEmpty and skips the ladder",
  );
  assert.equal(
    emptyTubeBehavior.decisionTelemetry.runs,
    1,
    "the idle decision still counts as a run for the durable harness counters",
  );
  const readyBehavior = Object.create(idleBehavior);
  readyBehavior.readySiloShotCapacity = () => 2;
  await assert.rejects(
    () => readyBehavior.maybeSendNuke(),
    /target ladder must not run/,
    "ready tubes still reach the target ladder",
  );
}

process.stdout.write("nuke economy policy tests passed\n");
