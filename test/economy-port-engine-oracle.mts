import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PortExecution } from "../openfront-engine/src/core/execution/PortExecution";
import { Game, Unit, UnitType } from "../openfront-engine/src/core/game/Game";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plannerSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/legendaryPlanner.js"),
  "utf8",
);
const structureSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/structureBehavior.js"),
  "utf8",
);
const UNIT = {
  City: UnitType.City,
  Port: UnitType.Port,
  Factory: UnitType.Factory,
  SAMLauncher: UnitType.SAMLauncher,
  MissileSilo: UnitType.MissileSilo,
  DefensePost: UnitType.DefensePost,
  Warship: UnitType.Warship,
  AtomBomb: UnitType.AtomBomb,
  HydrogenBomb: UnitType.HydrogenBomb,
  MIRV: UnitType.MIRV,
  MIRVWarhead: UnitType.MIRVWarhead,
  TransportShip: UnitType.TransportShip,
  TradeShip: UnitType.TradeShip,
};
const structureSandbox = {
  UNIT,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { FFA: "FFA", Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  state: { settings: { winFixes: true, buildStructures: {} }, stats: { builds: 0 } },
  currentDifficulty: () => "Legendary",
  isLegendaryDifficulty: () => true,
  isAtLeastHardDifficulty: () => true,
  autoBotBuildAllowed: () => true,
  getBuildMenu: () => null,
  sendAutoBotBuildOrUpgrade: () => false,
  setLastAction: () => {},
  tr: (value: string) => value,
  profileStructureSync: (_profile: unknown, _name: string, action: () => unknown) => action(),
  profileStructureAsync: async (_profile: unknown, _name: string, action: () => unknown) =>
    action(),
  withTimeout: async (promise: Promise<unknown>) => promise,
  WORKER_TIMEOUT_MS: 1,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
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
} as Record<string, unknown> & { globalThis?: unknown };
structureSandbox.globalThis = structureSandbox;
structureSandbox.window = structureSandbox;
executeClassicScript(
  plannerSource + "\n" + structureSource + "\nglobalThis.__StructureBehavior = StructureBehavior;",
  structureSandbox,
  { filename: "economy-port-engine-oracle.vm.js" },
);
const StructureBehavior = structureSandbox.__StructureBehavior as new () => Record<string, any>;

type Relation = "team" | "ally" | "other";
type PortSpec = { id: string; relation: Relation; distance: number; level?: number };

function makeFixture(teamPartner: boolean) {
  let nextUnitId = 0;
  const owners: Array<Record<string, any>> = [];

  function makeOwner(id: string, relation: "self" | Relation) {
    const units: Array<Record<string, any>> = [];
    const owner: Record<string, any> = {
      id: () => id,
      smallID: () => id,
      relation,
      isPlayer: () => true,
      isAlive: () => true,
      hasEmbargoAgainst: () => false,
      canTrade(other: Record<string, any>) {
        return other !== owner && !this.hasEmbargoAgainst(other) && !other.hasEmbargoAgainst(owner);
      },
      isFriendly(other: Record<string, any>) {
        return other.relation === "team" || other.relation === "ally";
      },
      units(...types: string[]) {
        return units.filter((unit) => types.length === 0 || types.includes(unit.type()));
      },
      addUnit(unit: Record<string, any>) {
        units.push(unit);
      },
    };
    if (relation !== "self") owners.push(owner);
    return owner;
  }

  function makeUnit(owner: Record<string, any>, type: string, tile: number, level = 1) {
    const id = "unit-" + nextUnitId++;
    const unit = {
      id: () => id,
      type: () => type,
      owner: () => owner,
      tile: () => tile,
      level: () => level,
      isActive: () => true,
      isUnderConstruction: () => false,
    };
    owner.addUnit(unit);
    return unit;
  }

  const me = makeOwner("self", "self");
  const sourcePort = makeUnit(me, UnitType.Port, 0);
  makeUnit(me, UnitType.City, 1);
  makeUnit(me, UnitType.Factory, 1);

  const portSpecs: PortSpec[] = [
    { id: "other-0", relation: "other", distance: 310, level: 2 },
    { id: "other-1", relation: "other", distance: 320 },
    { id: "other-2", relation: "other", distance: 330 },
    { id: "other-3", relation: "other", distance: 340 },
    // Equal-distance positions straddle the engine's fractional cutoff:
    // 13 / 3 = 4.333..., so index 4 gets proximity and index 5 does not.
    // IDs are deliberately reverse lexical order to detect custom tie-breaks.
    { id: "z-team", relation: teamPartner ? "team" : "other", distance: 350 },
    { id: "a-rival", relation: "other", distance: 350 },
    ...Array.from({ length: 7 }, (_, index) => ({
      id: "far-" + index,
      relation: "other" as const,
      distance: 5_000,
    })),
  ];
  for (const spec of portSpecs) {
    const owner = makeOwner(spec.id, spec.relation);
    makeUnit(owner, UnitType.Port, spec.distance, spec.level ?? 1);
  }

  const config = {
    tradeShipShortRangeDebuff: () => 300,
    proximityBonusPortsNb(total: number) {
      return Math.min(Math.max(total / 3, 4), total);
    },
    tradeShipSpawnRate: () => 100,
    trainStationMaxRange: () => 110,
    unitInfo: (type: string) => ({ constructionDuration: type === UnitType.Port ? 50 : 20 }),
    isUnitDisabled: () => false,
  };
  const game = {
    ticks: () => 100,
    config: () => config,
    players: () => [me, ...owners],
    neighbors: (_tile: number) => [1],
    isWater: (_tile: number) => true,
    getWaterComponent: (_tile: number) => 42,
    hasWaterComponent: (_tile: number, component: number) => component === 42,
    manhattanDist: (left: number, right: number) => Math.abs(left - right),
    euclideanDistSquared: (left: number, right: number) => (left - right) ** 2,
    cachedUnitCount: (_type: string) => 0,
  };

  const execution = new PortExecution(sourcePort as unknown as Unit);
  execution.init(game as unknown as Game, 100);
  const engineDestinations = execution.tradingPorts();

  const behavior = Object.create(StructureBehavior.prototype) as Record<string, any>;
  behavior.game = game;
  behavior.player = me;
  behavior._economicInvestmentSummaryTick = null;
  behavior._economicInvestmentSummary = null;
  behavior.unitUnderConstruction = (unit: Record<string, any>) => unit.isUnderConstruction();
  behavior.isTradeableStationNeighbor = () => true;
  behavior.isOceanPortTile = (tile: number) => tile !== 1;
  behavior.getConstructionCost = (type: string) => (type === UnitType.City ? 1_000_000n : 125_000n);
  behavior.availableGoldAfterReserve = () => 125_000n;
  behavior.spendableConstructionGold = () => 125_000n;

  Object.assign(me, {
    nearby: () => owners,
    isAlliedWith: (owner: Record<string, any>) => owner.relation === "ally",
    isOnSameTeam: (owner: Record<string, any>) => owner.relation === "team",
  });

  const summary = behavior.getEconomicInvestmentSummary();
  return { behavior, summary, engineDestinations, portSpecs, sourcePort, config };
}

function expectedTradeShipGold(distance: number) {
  return Math.floor(75_000 / (1 + Math.exp(-0.03 * (distance - 300))) + 50 * distance);
}

function byOwnerMultiplicity(destinations: Array<Record<string, any>>) {
  const result = new Map<string, number>();
  for (const destination of destinations) {
    const ownerId = destination.owner().id();
    result.set(ownerId, (result.get(ownerId) ?? 0) + 1);
  }
  return result;
}

function verifyEngineParityAndChoice(teamPartner: boolean) {
  const fixture = makeFixture(teamPartner);
  const engineWeights = byOwnerMultiplicity(fixture.engineDestinations);
  const productionPartners = fixture.behavior.economicOceanPartners([0], 300, fixture.config);
  const productionWeights = new Map(
    productionPartners.scoredEntries.map((entry: Record<string, any>) => [
      entry.owner.id(),
      entry.weight,
    ]),
  );

  const expectedWeight = teamPartner ? 21 : 20;
  assert.equal(fixture.engineDestinations.length, expectedWeight);
  assert.equal(
    engineWeights.get("other-0"),
    4,
    "Port level and proximity each duplicate destinations",
  );
  assert.equal(engineWeights.get("z-team"), teamPartner ? 3 : 2);
  assert.equal(engineWeights.get("a-rival"), 1);
  assert.equal(productionPartners.scoredEntries.length, 13);
  assert.deepEqual(
    [...productionWeights.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [...engineWeights.entries()].sort(([a], [b]) => a.localeCompare(b)),
    "the advisory weights match the real PortExecution multiplicity for every sampled destination",
  );

  const cutoffTeam = productionPartners.scoredEntries.find(
    (entry: Record<string, any>) => entry.owner.id() === "z-team",
  );
  const cutoffRival = productionPartners.scoredEntries.find(
    (entry: Record<string, any>) => entry.owner.id() === "a-rival",
  );
  assert.equal(cutoffTeam.proximityBonus, true);
  assert.equal(cutoffRival.proximityBonus, false);
  assert.equal(cutoffTeam.friendlyBonus, teamPartner);

  let weightedGold = 0;
  let weightedDistance = 0;
  let weightedTeamGold = 0;
  let weightedRivalGold = 0;
  for (const destination of fixture.engineDestinations) {
    const gold = expectedTradeShipGold(destination.tile());
    weightedGold += gold;
    weightedDistance += destination.tile();
    if (destination.owner().relation === "team") weightedTeamGold += gold;
    if (destination.owner().relation === "other") weightedRivalGold += gold;
  }
  const totalWeight = fixture.engineDestinations.length;
  const expectedOwnIncome = weightedGold / totalWeight / 2_000;
  const expectedTeamIncome = weightedTeamGold / totalWeight / 2_000;
  const expectedRivalIncome = weightedRivalGold / totalWeight / 2_000;
  const expectedArrival = Math.ceil(weightedDistance / totalWeight);

  assert.equal(fixture.summary.portTradePartnerCount, 13);
  assert.equal(fixture.summary.portTradePartnerWeight, totalWeight);
  assert.equal(fixture.summary.portArrivalTicks, expectedArrival);
  assert.ok(
    Math.abs(fixture.summary.portTradeIncomePerTick - expectedOwnIncome) < 0.0005,
    JSON.stringify({
      observed: fixture.summary.portTradeIncomePerTick,
      expectedOwnIncome,
      expectedArrival,
      expectedWeight: totalWeight,
    }),
  );
  assert.ok(Math.abs(fixture.summary.portTeamIncomePerTick - expectedTeamIncome) < 0.0005);
  assert.ok(Math.abs(fixture.summary.portRivalSpilloverPerTick - expectedRivalIncome) < 0.0005);

  const context = {
    config: { isUnitDisabled: () => false },
    citiesDisabled: true,
    hasOceanPortTiles: true,
  };
  const candidates = fixture.behavior.economicInvestmentCandidates(context, {
    types: [UnitType.Factory, UnitType.Port],
    summary: fixture.summary,
  });
  const factoryCandidate = candidates.find(
    (candidate: Record<string, any>) => candidate.type === UnitType.Factory,
  );
  const portCandidate = candidates.find(
    (candidate: Record<string, any>) => candidate.type === UnitType.Port,
  );
  assert.ok(factoryCandidate);
  assert.ok(portCandidate);
  assert.equal(portCandidate.completionTicks, 50 + expectedArrival);
  assert.ok(
    Math.abs(
      portCandidate.longIncomePerTick -
        (expectedOwnIncome + expectedTeamIncome - expectedRivalIncome * 0.5),
    ) < 0.0005,
    "team payout is added once and rival matching payout is discounted without pooling wallet gold",
  );

  const ranked = fixture.behavior.rankEconomicInvestments(context, {
    types: [UnitType.Factory, UnitType.Port],
    shortHorizonTicks: 3_000,
    longHorizonTicks: 6_000,
    shortWeight: 0.4,
  });
  const order = fixture.behavior.economicAdvisoryTypeOrder(
    [UnitType.Factory, UnitType.Port],
    ranked,
  );
  assert.equal(
    order[0],
    teamPartner ? UnitType.Port : UnitType.Factory,
    "the same engine route topology selects Port with a nearby teammate and preserves Factory fallback for a rival",
  );
  return { fixture, ranked, order, portCandidate, factoryCandidate };
}

const teamDecision = verifyEngineParityAndChoice(true);
const rivalDecision = verifyEngineParityAndChoice(false);
assert.equal(teamDecision.order[0], UnitType.Port);
assert.equal(rivalDecision.order[0], UnitType.Factory);
assert.ok(
  teamDecision.portCandidate.longIncomePerTick > rivalDecision.portCandidate.longIncomePerTick,
);
assert.ok(
  teamDecision.ranked[0].investmentScore > 0 &&
    rivalDecision.ranked.every((candidate: Record<string, any>) => candidate.action === "wait"),
  "engine-aligned teammate weights clear payback while the rival distribution does not",
);

console.log("PortExecution economy weighting oracle fixture passed");
