import assert from "node:assert/strict";
import { createStructureUpgradeFixture } from "./helpers/structure-upgrade-fixture.mjs";

// Live-cadence surplus scenario. Income accrues 2000/tick; the Factory rung
// consumes the first five 1M crossings (ticks 500-2500) and then stops, while
// the pressure quote and defensive reserve stay active. Gold therefore climbs
// back through the combined-reserve band [1M, 3.5M) from tick 3000 before
// reaching the 3.5M fire threshold (1M silo + 1M factory pressure + 1.5M SAM
// reserve): fires at ticks 4250 and 4750, and tick 5000 ends mid-band at 3M.

const UNIT = {
  MissileSilo: "MissileSilo",
  AtomBomb: "AtomBomb",
  HydrogenBomb: "HydrogenBomb",
  MIRV: "MIRV",
  Factory: "Factory",
  Port: "Port",
  City: "City",
  SAMLauncher: "SAMLauncher",
};
const Difficulty = { Easy: "Easy", Legendary: "Legendary" };
const SILO_COST = 1_000_000n;
const FACTORY_COST = 1_000_000n;
const SAM_RESERVE = 1_500_000n;
const GOLD_PER_TICK = 2_000n;
const TICKS = 5_000;
const FACTORY_RUNG_CAP = 5;

let gold = 0n;
let tick = 0;
let siloLevel = 1;
const state = { settings: { winFixes: true }, stats: { builds: 0 } };
const silo = {
  id: () => 1,
  level: () => siloLevel,
  isUnderConstruction: () => false,
  tile: () => 100,
  type: () => UNIT.MissileSilo,
};
const factories = Array.from({ length: 4 }, () => ({
  isUnderConstruction: () => false,
  level: () => 1,
}));
const config = {
  isUnitDisabled: () => false,
  gameConfig: () => ({ gameMode: "FFA" }),
};
const { behavior, emitted } = createStructureUpgradeFixture({
  UNIT,
  Difficulty,
  state,
  bindings: {
    currentDifficulty: () => Difficulty.Legendary,
    isLegendaryDifficulty: () => true,
    playersArePermanentTeammates: () => false,
    // portutil.js defines GameMode ahead of these parts in the real build
    // scope; the fixture's structure-behavior-only source filter drops it.
    GameMode: { FFA: "Free For All", Team: "Team" },
  },
});

behavior.game = { ticks: () => tick, config: () => config };
behavior.player = {
  gold: () => gold,
  numTilesOwned: () => 1_000,
  units: (type) => {
    if (type === UNIT.MissileSilo) return [silo];
    return type === UNIT.Factory ? factories : [];
  },
};
behavior.cost = (type) =>
  ({
    [UNIT.MissileSilo]: SILO_COST,
    [UNIT.Factory]: FACTORY_COST,
    [UNIT.SAMLauncher]: SAM_RESERVE,
  })[type] ?? 0n;
behavior.shouldBuildStructure = () => true;
behavior.availableGoldAfterReserve = () => gold;
behavior.probeUpgradableStructures = async (silos) => ({
  upgradable: silos,
  buByUnitId: new Map([[1, { canUpgrade: true, cost: SILO_COST }]]),
});
behavior.genericStructureUpgradeAllowed = () => true;
behavior.hasObservedHostileMissileLaunch = () => true;
behavior.hasDefensiveSamPressure = () => true;
behavior.hydrogenCoverageNeedsSam = () => false;
behavior.preemptiveDefensePostPressure = () => null;

const economicPressure = behavior.economicConstructionPressure();
const defensiveReserve = behavior.defensiveConstructionReserve();
assert.equal(economicPressure?.type, UNIT.Factory);
assert.equal(economicPressure?.cost, FACTORY_COST);
assert.equal(defensiveReserve, SAM_RESERVE);

let economyBuilds = 0;
let laneAttempts = 0;
let fired = 0;
let blocked = 0;
let blockedBelowUpgradeCost = 0;
let blockedByCombinedReserve = 0;
let skippedForNewBuild = 0;
const threshold = SILO_COST + economicPressure.cost + defensiveReserve;

for (tick = 1; tick <= TICKS; tick++) {
  gold += GOLD_PER_TICK;
  const pressure = behavior.economicConstructionPressure();
  if (pressure && economyBuilds < FACTORY_RUNG_CAP && gold >= pressure.cost) {
    gold -= pressure.cost;
    economyBuilds++;
    skippedForNewBuild++;
    continue;
  }

  laneAttempts++;
  if (await behavior.maybeUpgradeSiloFromSurplus()) {
    fired++;
    gold -= SILO_COST;
    siloLevel++;
    assert.equal(emitted.length, fired);
  } else {
    blocked++;
    if (gold < SILO_COST) blockedBelowUpgradeCost++;
    else if (gold < threshold) blockedByCombinedReserve++;
  }
}

// The exact curve is deterministic: reserves push the fire threshold to 3.5M,
// so the silo may only fire on a full cost+pressure+reserve treasury. Removing
// the combined-reserve comparison in nukeSiloUpgradeBudgetAvailable would let
// tick 3000 (gold exactly 1M) fire and break every count below.
assert.equal(economyBuilds, FACTORY_RUNG_CAP, "the capped Factory rung stops consuming crossings");
assert.equal(laneAttempts + skippedForNewBuild, TICKS);
assert.equal(fired, 2, "one fire per rebuilt 3.5M treasury at ticks 4250/4750");
assert.equal(blocked, laneAttempts - fired);
assert.equal(
  blockedBelowUpgradeCost,
  2994,
  "attempts while gold is still under the bare silo cost",
);
assert.equal(
  blockedByCombinedReserve,
  1999,
  "mid-band blocks: gold >= cost but < cost + factory pressure + SAM reserve",
);
assert.ok(blockedByCombinedReserve >= 1, "the mid-band combined-reserve branch must run");
assert.equal(emitted.length, fired);
assert.equal(siloLevel, 3, "two surplus upgrades land: level 1 -> level 3");

process.stdout.write(
  `silo live scenario: ${JSON.stringify({
    ticks: TICKS,
    economicPressure: String(economicPressure.cost),
    defensiveReserve: String(defensiveReserve),
    threshold: String(threshold),
    economyBuilds,
    skippedForNewBuild,
    laneAttempts,
    fired,
    blocked,
    blockedBelowUpgradeCost,
    blockedByCombinedReserve,
    midBandExercised: blockedByCombinedReserve >= 1,
  })}\n`,
);
