import assert from "node:assert/strict";
import { createStructureUpgradeFixture } from "./helpers/structure-upgrade-fixture.mjs";

// Defense Post lead guard (baikal-nuke-wars survival lever): while the bot
// leads every non-team player by territory with gold headroom beyond a Post
// plus the next economy rung, the construction planner must authorize a Post
// on the most pressured border ahead of discretionary spending and cap
// offensive silo candidates while coverage sits below the front-scaled
// expectation. Not leading, tight gold, or coverage already at expectation
// must skip the guard entirely.

const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAMLauncher",
  MissileSilo: "MissileSilo",
  DefensePost: "DefensePost",
  AtomBomb: "AtomBomb",
  HydrogenBomb: "HydrogenBomb",
  MIRV: "MIRV",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const PlayerType = { Nation: "NATION", Human: "HUMAN", Bot: "BOT" };

function makeWorld({
  gold = 5_000_000n,
  ourTiles = 281_000,
  enemyTiles = 120_000,
  ourTroops = 100_000,
  enemyTroops = 50_000,
  incomingTroops = 0,
  ownDefensePosts = 0,
  enemyType = PlayerType.Nation,
  postCost = 1_000_000n,
  economyCost = 2_000_000n,
} = {}) {
  const state = {
    settings: { winFixes: true },
    stats: { builds: 0 },
    lastAction: null,
  };
  const defensePostUnits = Array.from({ length: ownDefensePosts }, (_, index) => ({
    tile: () => 100 + index,
    isUnderConstruction: () => false,
  }));
  const us = {
    isPlayer: () => true,
    isAlive: () => true,
    smallID: () => 1,
    type: () => PlayerType.Human,
    troops: () => ourTroops,
    numTilesOwned: () => ourTiles,
    gold: () => gold,
    isOnSameTeam: () => false,
    isFriendly: () => false,
    sharesBorderWith: () => true,
    borderTiles: () => [100],
    units: (type) => (type === UNIT.DefensePost ? defensePostUnits : []),
    incomingAttacks: () =>
      incomingTroops > 0
        ? [
            {
              troops: () => incomingTroops,
              retreating: () => false,
              target: () => us,
              attacker: () => enemy,
            },
          ]
        : [],
  };
  const enemy = {
    isPlayer: () => true,
    isAlive: () => true,
    smallID: () => 2,
    type: () => enemyType,
    troops: () => enemyTroops,
    numTilesOwned: () => enemyTiles,
  };
  const game = {
    ticks: () => 4200,
    config: () => ({
      gameConfig: () => ({ gameMode: "Free For All" }),
      isUnitDisabled: () => false,
      defensePostRange: () => 30,
      nukeMagnitudes: () => ({ outer: 20 }),
    }),
    players: () => [us, enemy],
    neighbors: (tile) => [tile + 1],
    hasOwner: () => true,
    ownerID: (tile) => (tile === 101 ? enemy.smallID() : us.smallID()),
    isLand: () => true,
    euclideanDistSquared: (a, b) => (a - b) ** 2,
  };
  const { behavior, emitted } = createStructureUpgradeFixture({
    UNIT,
    Difficulty,
    state,
    bindings: {
      PlayerType,
      currentDifficulty: () => Difficulty.Legendary,
      isLegendaryDifficulty: () => true,
      playersArePermanentTeammates: () => false,
      legendaryBigInt: (value) => BigInt(value || 0),
      rankLegendaryConstructionActions: (group) => group,
    },
  });
  behavior.game = game;
  behavior.player = us;
  behavior.debugStructureLaneCount = () => {};
  // Deterministic placement surface: the frontier tile probes as a legal
  // fresh construction and placement geometry is not under test here.
  behavior.cost = () => postCost;
  behavior.getConstructionCost = (type) => (type === UNIT.DefensePost ? postCost : economyCost);
  behavior.availableGoldAfterReserve = () => gold;
  behavior.buildableFor = async (_type, tile) => ({
    canBuild: tile,
    canUpgrade: false,
  });
  behavior.isDangerousStructureTile = () => false;
  behavior.isSafeBuildablePlacement = () => true;
  behavior.hasDefensePostBorderDepth = () => true;
  behavior.sampleTilesNearFront = (frontTiles) => [...frontTiles];
  behavior.rankStructureTilesBySamProtection = (tiles) => [...tiles];
  return { behavior, emitted, state };
}

{
  const { behavior } = makeWorld();
  behavior.player.numTilesOwned = undefined;
  assert.equal(
    behavior.leadGuardTerritorialLead([{ numTilesOwned: () => 1 }], {}),
    false,
    "missing territory measurements fail closed instead of breaking defense decisions",
  );
}

// The earlier landlocked arsenal backstop must obey the same guard as the
// Legendary construction ladder, while target-specific demand remains separate.
{
  const { behavior } = makeWorld();
  let arsenalAttempts = 0;
  behavior.maybeOpenLegendaryArsenal = async () => {
    arsenalAttempts++;
    return true;
  };
  assert.equal(
    await behavior.maybeOpenLandlockedLegendaryArsenal(
      { difficulty: Difficulty.Legendary, cityCount: 1 },
      null,
      false,
    ),
    false,
    "an active lead-defense shortfall defers the early offensive Silo backstop",
  );
  assert.equal(arsenalAttempts, 0, "the guarded backstop does not reach Arsenal spending");
}

// 1. Leading with headroom: the guard authorizes a Post on the pressured
//    border and the priority lane builds it before discretionary spending.
{
  const { behavior, emitted, state } = makeWorld();
  assert.equal(await behavior.handleDefensePostPriority(false), true);
  assert.equal(emitted.length, 1, "the guarded Post reaches the menu");
  assert.equal(state.stats.builds, 1, "the Post counts as a build action");
  assert.equal(state.lastAction.text, "🛡️ Defense post");
  const threat = behavior.leadGuardDefensePostThreat(Difficulty.Legendary);
  assert.equal(threat.leadGuard, true);
  assert.equal(threat.allowed, 2, "the front-scaled expectation applies");
  assert.deepEqual([...threat.frontTiles], [100]);
}

// 1b. A moving exposed perimeter cannot keep opening new lead-guard quotas.
{
  const { behavior } = makeWorld({ ownDefensePosts: 2 });
  behavior.getLeadGuardBorderFrontTiles = () => [5000];
  behavior.countDefensePostsNearFront = () => 0;
  assert.equal(
    behavior.computeLeadGuardDefensePostThreat(Difficulty.Legendary),
    null,
    "the preemptive lead guard stops after two owned Posts even when its front shifts",
  );
}

// 2. Not leading by territory: no guard threat, the lane falls through.
{
  const { behavior, emitted } = makeWorld({ enemyTiles: 300_000 });
  assert.equal(behavior.leadGuardDefensePostThreat(Difficulty.Legendary), null);
  assert.equal(await behavior.handleDefensePostPriority(false), null);
  assert.equal(emitted.length, 0, "no Post without the territorial lead");
}

// 2b. The territorial lead can be separated from large rivals by a tribe
//     belt. Any hostile land owner on the exposed perimeter is still covered.
{
  const { behavior, emitted, state } = makeWorld({ enemyType: PlayerType.Bot });
  const threat = behavior.leadGuardDefensePostThreat(Difficulty.Legendary);
  assert.equal(threat.leadGuard, true, "a tribe border still gets lead protection");
  assert.deepEqual([...threat.frontTiles], [100]);
  assert.equal(await behavior.handleDefensePostPriority(false), true);
  assert.equal(emitted.length, 1, "the post covers the exposed hostile edge");
  assert.equal(state.lastAction.text, "🛡️ Defense post");
}

// 3. Tight gold (Post plus the next economy rung unaffordable): guard skips.
{
  const { behavior, emitted } = makeWorld({ gold: 2_500_000n });
  assert.equal(behavior.leadGuardDefensePostThreat(Difficulty.Legendary), null);
  assert.equal(await behavior.handleDefensePostPriority(false), null);
  assert.equal(emitted.length, 0, "no Post without the gold headroom");
}

// 4. Coverage already at the front-scaled expectation: no further demand.
{
  const { behavior } = makeWorld({ ownDefensePosts: 2 });
  assert.equal(behavior.leadGuardDefensePostThreat(Difficulty.Legendary), null);
}

// 4b. War-agnostic reach: the strongest border opponent IS already attacking
//     us (sub-threshold ratio, so the native live-attack lane declines) —
//     while leading, the guard must still authorize the Post on that front.
{
  const { behavior, emitted, state } = makeWorld({ incomingTroops: 5_000 });
  // Match the runtime failure: reconstructed border-owner IDs omit the
  // attacker even though the live attack and its owned front tile are visible.
  behavior.borderingLandOwnerIds = () => new Set();
  const threat = behavior.leadGuardDefensePostThreat(Difficulty.Legendary);
  assert.equal(threat.leadGuard, true, "an active attacker does not mute the guard");
  assert.deepEqual([...threat.frontTiles], [100]);
  assert.equal(await behavior.handleDefensePostPriority(false), true);
  assert.equal(emitted.length, 1, "the guarded Post is built despite the live attack");
  assert.equal(state.lastAction.text, "🛡️ Defense post");
}

// 4c. A hard-reserved invasion keeps first claim on the structure action, but
//     a validated SAM-overwhelm Silo request may use gold beyond defensive
//     reserves after the Post placement attempt fails.
{
  const { behavior } = makeWorld();
  const actions = [];
  behavior.defensePostThreat = () => ({ landAttacks: [] });
  behavior.shouldHardReserveFailedDefensePost = () => true;
  behavior.shouldDeferHardDefensePostRetry = () => false;
  behavior.tryBuildDefensePost = async () => {
    actions.push("defense-post");
    return false;
  };
  behavior.maybeUpgradeSiloForNukeDemand = async () => {
    actions.push("sam-demand-silo");
    return true;
  };
  assert.equal(await behavior.handleDefensePostPriority(false), true);
  assert.deepEqual(actions, ["defense-post", "sam-demand-silo"]);
}

// 4d. During the Post retry cooldown, only the same target-driven demand lane
//     may use the otherwise reserved construction decision.
{
  const { behavior } = makeWorld();
  let postAttempts = 0;
  let demandAttempts = 0;
  behavior.defensePostThreat = () => ({ landAttacks: [] });
  behavior.shouldHardReserveFailedDefensePost = () => true;
  behavior.shouldDeferHardDefensePostRetry = () => true;
  behavior.tryBuildDefensePost = async () => {
    postAttempts++;
    return false;
  };
  behavior.maybeUpgradeSiloForNukeDemand = async () => {
    demandAttempts++;
    return true;
  };
  assert.equal(await behavior.handleDefensePostPriority(false), true);
  assert.equal(postAttempts, 0, "the failed Post placement remains in cooldown");
  assert.equal(demandAttempts, 1, "target-driven Silo demand can still progress");
}

// 5. The cap: while the guard holds, discretionary silo spending waits —
//    the arsenal/first-Silo lanes are not attempted and MissileSilo
//    candidates are filtered from the discretionary ladder.
{
  const { behavior } = makeWorld();
  const arsenalAttempts = [];
  const firstSiloAttempts = [];
  const plannedGroups = [];
  behavior.legendaryMissileDefenseUrgent = () => false;
  behavior.maybeOpenLegendaryArsenal = async () => {
    arsenalAttempts.push(true);
    return false;
  };
  behavior.ownProjectedSamCapacity = () => 1;
  behavior.maybeSpawnHostileSiloSam = async () => false;
  behavior.hostileSiloSamActionBlocked = () => false;
  behavior.maybeUpgradeLegendarySam = async () => false;
  behavior.maybeOpenLegendaryFirstSilo = async () => {
    firstSiloAttempts.push(true);
    return false;
  };
  behavior.maybeArmFreezeStrikeSilo = async () => false;
  behavior.maybeUpgradeSiloForNuclearSlotPressure = async () => false;
  behavior.computeTroopCapPressure = () => false;
  behavior.refreshLegendaryCityUpgradeCandidate = async () => {};
  behavior.legendaryConstructionCandidates = async () => [
    { type: UNIT.MissileSilo, cost: 1n },
    { type: UNIT.Factory, cost: 1n },
  ];
  behavior.legendaryConstructionActionGroupResult = async (actions) => {
    plannedGroups.push(actions.map((candidate) => candidate.type));
    return "built";
  };
  assert.equal(
    await behavior.doHandleLegendaryStructures({
      config: behavior.game.config(),
      citiesDisabled: false,
      cityCount: 1,
      difficulty: Difficulty.Legendary,
      hasCoastalTiles: false,
      hasOceanPortTiles: false,
      missileSilosEnabled: true,
      nukesEnabled: true,
      economyGrowthPriority: false,
    }),
    true,
  );
  assert.deepEqual(
    { arsenalAttempts, firstSiloAttempts, plannedGroups },
    { arsenalAttempts: [], firstSiloAttempts: [], plannedGroups: [[UNIT.Factory]] },
    "the guarded leader defers discretionary offense to the Defense Post",
  );
}

// 6. Without the lead, the same planner still considers the silo candidates.
{
  const { behavior } = makeWorld({ enemyTiles: 300_000 });
  const plannedGroups = [];
  behavior.legendaryMissileDefenseUrgent = () => false;
  behavior.maybeOpenLegendaryArsenal = async () => false;
  behavior.ownProjectedSamCapacity = () => 1;
  behavior.maybeSpawnHostileSiloSam = async () => false;
  behavior.hostileSiloSamActionBlocked = () => false;
  behavior.maybeUpgradeLegendarySam = async () => false;
  behavior.maybeOpenLegendaryFirstSilo = async () => false;
  behavior.maybeArmFreezeStrikeSilo = async () => false;
  behavior.maybeUpgradeSiloForNuclearSlotPressure = async () => false;
  behavior.computeTroopCapPressure = () => false;
  behavior.refreshLegendaryCityUpgradeCandidate = async () => {};
  behavior.legendaryConstructionCandidates = async () => [
    { type: UNIT.MissileSilo, cost: 1n },
    { type: UNIT.Factory, cost: 1n },
  ];
  behavior.legendaryConstructionActionGroupResult = async (actions) => {
    plannedGroups.push(actions.map((candidate) => candidate.type));
    return "built";
  };
  await behavior.doHandleLegendaryStructures({
    config: behavior.game.config(),
    citiesDisabled: false,
    cityCount: 1,
    difficulty: Difficulty.Legendary,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: false,
  });
  assert.deepEqual(
    plannedGroups,
    [[UNIT.MissileSilo, UNIT.Factory]],
    "offense candidates stay available without the guard",
  );
}

// 7. The headless engine names the UI's Legendary policy tier Impossible;
//    the existing isLegendaryDifficulty helper treats them identically.
{
  const { behavior } = makeWorld();
  assert.equal(
    behavior.leadGuardDefensePostThreat(Difficulty.Impossible)?.leadGuard,
    true,
    "the normalized Impossible tier still activates Legendary guard policy",
  );
}

process.stdout.write("defense post lead guard tests passed\n");
