import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const plannerSandbox = {};
vm.runInNewContext(read("engine/ingame/auto-bot/legendaryPlanner.js"), plannerSandbox, {
  filename: "legendaryPlanner.js",
});

assert.equal(
  typeof plannerSandbox.rankLegendaryConstructionCandidates,
  "function",
  "Legendary planner exposes its candidate ranking function",
);
assert.equal(
  typeof plannerSandbox.legendaryAllyPowerScore,
  "function",
  "Legendary exposes the ally-power normalizer used by placement",
);
assert.equal(
  typeof plannerSandbox.legendaryPlacementProximityScore,
  "function",
  "Legendary exposes the distance normalizer used by placement",
);

const weakAllyPower = plannerSandbox.legendaryAllyPowerScore({
  allyTroops: 1_000,
  allyGold: 1_000n,
  allyProduction: 2,
  ownTroops: 10_000,
  ownGold: 10_000n,
  ownProduction: 10,
});
const strongAllyPower = plannerSandbox.legendaryAllyPowerScore({
  allyTroops: 50_000,
  allyGold: 50_000n,
  allyProduction: 30,
  ownTroops: 10_000,
  ownGold: 10_000n,
  ownProduction: 10,
});
assert.ok(
  strongAllyPower > weakAllyPower,
  "Legendary ranks allies by their strongest relative troop, gold, or gold-production axis",
);
assert.ok(
  plannerSandbox.legendaryPlacementProximityScore(2, 10) >
    plannerSandbox.legendaryPlacementProximityScore(20, 10),
  "Legendary gives closer allies more placement support",
);

const ranked = plannerSandbox.rankLegendaryConstructionCandidates(
  [
    {
      type: "City",
      mandatory: 0,
      safety: 0,
      strategic: 0,
      gold: 6,
      troops: 6,
      defense: 0,
      deficit: 2,
      efficiency: 1,
      cost: 500n,
    },
    {
      type: "SAM Launcher",
      mandatory: 1,
      safety: 2,
      gold: 1,
      troops: 1,
      defense: 10,
      strategic: 0,
      deficit: 1,
      efficiency: 1,
      cost: 500n,
    },
    {
      type: "Port",
      mandatory: 0,
      safety: 0,
      gold: 4,
      troops: 2,
      defense: 1,
      strategic: 0,
      deficit: 2,
      efficiency: 1,
      cost: 300n,
    },
    {
      type: "Gold Factory",
      mandatory: 0,
      safety: 0,
      gold: 10,
      troops: 0,
      defense: 0,
      strategic: 0,
      deficit: 2,
      efficiency: 1,
      cost: 300n,
    },
    {
      type: "Factory",
      mandatory: 0,
      safety: 0,
      gold: 2,
      troops: 2,
      defense: 1,
      strategic: 2,
      deficit: 1,
      efficiency: 1,
      cost: 900n,
    },
    { type: "Illegal", legal: false, cost: 1n },
  ],
  { gold: 1_000n, reserve: 200n },
);

assert.deepEqual(
  ranked.map((candidate) => candidate.type),
  ["SAM Launcher", "City", "Port", "Gold Factory"],
  "Legendary balances gold and troops first; missile defense is secondary",
);

assert.equal(
  plannerSandbox.chooseLegendaryConstructionCandidate(
    [{ type: "Factory", cost: 900n, mandatory: 1 }],
    { gold: 1_000n, reserve: 200n },
  ),
  null,
  "Legendary holds the strategic reserve instead of spending through it",
);

const connectedCity = plannerSandbox.legendaryConstructionObjectiveVector("City", {
  connectedCities: 0,
  cityRailConnection: 1,
});
const saturatedCity = plannerSandbox.legendaryConstructionObjectiveVector("City", {
  connectedCities: 4,
  cityRailConnection: 1,
});
assert.ok(
  connectedCity.gold > saturatedCity.gold,
  "City gold contribution has diminishing returns on a connected rail network",
);

const silo = plannerSandbox.legendaryConstructionObjectiveVector("Missile Silo", {
  targetPressure: 2,
});
const sam = plannerSandbox.legendaryConstructionObjectiveVector("SAM Launcher", {
  defenseGap: 2,
});
const port = plannerSandbox.legendaryConstructionObjectiveVector("Port", {
  tradeNeed: 2,
  destroyerNeed: 2,
});
assert.ok("gold" in connectedCity && "troops" in connectedCity, "City exposes a production vector");
assert.ok(silo.gold > 0 && silo.troops > 0, "Silo remains costed in the production model");
assert.ok(sam.defense > sam.gold, "SAM is a defensive guardrail, not a production axis");
assert.ok(
  port.gold > 0 && port.troops > 0 && port.defense > 0,
  "Port contributes to trading while carrying a defensive risk",
);

const safeMissileThreat = plannerSandbox.legendaryMissileThreatScore({
  enemySilos: [{ level: 1 }],
  enemyGold: 500_000n,
  atomCost: 750_000n,
  hydrogenCost: 3_000_000n,
  flightTimeTicks: 120,
  vulnerableStructures: 1,
  vulnerableBlastArea: 1,
  hydrogenBlastArea: 100,
});
const criticalMissileThreat = plannerSandbox.legendaryMissileThreatScore({
  enemySilos: [{ level: 3 }, { level: 5 }],
  enemyGold: 30_000_000n,
  atomCost: 750_000n,
  hydrogenCost: 3_000_000n,
  flightTimeTicks: 5,
  vulnerableStructures: 12,
  vulnerableBlastArea: 100,
  hydrogenBlastArea: 100,
});
assert.ok(
  criticalMissileThreat.score > safeMissileThreat.score && criticalMissileThreat.critical,
  "Missile defense accounts for silo levels, enemy gold, flight time, and blast exposure",
);

const chainedSalvo = plannerSandbox.legendaryMissileSalvoRisk({
  atomArrivalTicks: [20, 21, 22],
  hydrogenArrivalTick: 23,
  interceptionCapacity: 2,
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  chainedSalvo.hydrogenGetsThrough,
  true,
  "Legendary models cheap atom bombs exhausting SAM capacity before hydrogen",
);
assert.equal(
  chainedSalvo.marginSatisfied,
  false,
  "Legendary preserves a five-tick (0.5s) impact margin",
);

assert.match(read("engine/ingame/auto-bot/portutil.js"), /Legendary: "Legendary"/);
assert.match(read("engine/ingame/auto-bot/core.js"), /difficulty: "Impossible"/);
assert.match(read("engine/ingame/auto-bot/panel.js"), /\"Legendary\"/);
assert.match(read("src/shell/popup/panel.ts"), /DIFFICULTIES/);
assert.match(read("locales/en/common.json"), /\"Legendary\"/);
assert.match(read("build.mjs"), /auto-bot\/legendaryPlanner\.js/);
const structureSource = read("engine/ingame/auto-bot/structureBehavior.js");
assert.match(structureSource, /rankLegendaryConstructionCandidates/);
assert.match(structureSource, /legendaryAllySupportPlacementScore/);
assert.match(structureSource, /legendaryTeamCenterPlacementScore/);
assert.match(structureSource, /LEGENDARY_SAM_IMPACT_MARGIN_TICKS/);
assert.match(structureSource, /maybeUpgradeLegendarySam/);
assert.match(structureSource, /legendaryMissileDefenseUrgent/);
assert.match(structureSource, /legendaryMinimumSamImpactMargin/);
assert.match(structureSource, /missileTimerQueue/);

console.log("LEGENDARY TESTS OK");
