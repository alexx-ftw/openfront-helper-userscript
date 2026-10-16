#!/usr/bin/env node
// Bit-identity + budget harness for the Legendary economy payout projection.
import process from "node:process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

const HORIZON_TICKS = 102000;
const CANDIDATE_COUNT = 25;
const BEFORE_PLANNER_SHA256 = "564859ae26f619ce84c07cb09da69f5a1c7af1cff0b8015b1977c7dda32b92f1";
const plannerSourceSha256 = () => createHash("sha256").update(Buffer.concat(Array.from({ length: 22 }, (_, index) =>
  readFileSync(new URL(`../engine/ingame/auto-bot/legendary-planner/part-${String(index + 1).padStart(2, "0")}.js`, import.meta.url)),
))).digest("hex");

const sharedConfig = () => ({
  unitInfo: () => ({ constructionDuration: 50 }),
  tradeShipSpawnRate: (roll, ships) =>
    Math.max(1, 220 + roll * 5 - Math.floor((Number(ships) || 0) / 2)),
});

const fleetProducerSupply = (variant = 0) => ({
  portOwners: [
    { ownerId: "A", ports: [
      { level: 1, readyAtTicks: 0, routes: [{ weight: 1, distance: 30 + variant }] },
      { level: 3, readyAtTicks: 900, routes: [{ weight: 1, distance: 45 }] },
    ] },
    { ownerId: "B", ports: [
      { level: 2, readyAtTicks: 1200, routes: [{ weight: 1, distance: 60 }] },
      { level: 4, readyAtTicks: 2500, routes: [{ weight: 1, distance: 80 }] },
    ] },
  ],
  initialTradeShipRemainingTicks: [40, 45, 70, 95],
});

const candidateInputs = (index, supply, overrides = {}) => ({
  fleetProducerSupply: supply,
  trainCount: 120,
  tradeShipCount: 40,
  hasCompletedTradePartner: true,
  portRoutes: [{
    weight: 1,
    distance: 40 + index * 4,
    teamGoldPerArrival: 1500 + index * 50,
    postAllianceGoldPerArrival: 800,
    allianceTicksRemaining: 6000,
  }],
  ...overrides,
});

const serializeValue = (value) => JSON.stringify(value, (_, entry) =>
  typeof entry === "bigint" ? entry.toString() + "n" : entry,
);

const evaluateCandidates = (sandbox, { freshConfigEachCall, supply }) => {
  const outputs = [];
  for (let index = 0; index < CANDIDATE_COUNT; index++) {
    const config = freshConfigEachCall ? sharedConfig() : sandbox.config;
    outputs.push(sandbox.legendaryEconomyNetGold("Port", {
      cost: 1000,
      horizonTicks: HORIZON_TICKS,
      inputs: candidateInputs(index, supply),
      config,
    }));
  }
  return outputs;
};

const timeCycle = (evaluate) => {
  const started = performance.now();
  const outputs = evaluate();
  return { outputs, elapsedMs: performance.now() - started };
};

// Brute-force per-tick reference for candidate 0 over a 40-tick horizon,
// mirroring legendaryPortRouteGold's per-tick semantics (overlap weights,
// alliance boundary at fractional ticks) with the same rate lookups.
const bruteForceReference = (sandbox, horizon) => {
  const config = { ...sharedConfig(), unitInfo: () => ({ constructionDuration: 0 }) };
  const inputs = {
    fleetProducerSupply: { portOwners: [], initialTradeShipRemainingTicks: [] },
    tradeShipCount: 2,
    hasCompletedTradePartner: true,
    portRoutes: [{ weight: 1, distance: 3, teamGoldPerArrival: 1500,
      postAllianceGoldPerArrival: 800, allianceTicksRemaining: 9.5 }],
  };
  const fleet = sandbox.legendaryProjectEconomyFleets(
    inputs,
    config,
    horizon,
    { portReadyAt: 0, portRoutes: inputs.portRoutes, portInboundSources: [] },
  );
  const route = inputs.portRoutes[0];
  const start = route.distance;
  const end = horizon;
  const allianceEnd = route.allianceTicksRemaining;
  let total = 0;
  for (let tick = Math.floor(start); tick < end; tick++) {
    const overlap = Math.max(0, Math.min(end, tick + 1) - Math.max(start, tick));
    if (overlap <= 0) continue;
    const rate = sandbox.legendaryExpectedTradeRateAtFleet(
      1,
      sandbox.legendaryProjectedCountAt(fleet.after.tradeShipCounts, tick, inputs.tradeShipCount),
      config,
      fleet.tradeRateCache,
    );
    const active = tick + overlap / 2 < allianceEnd;
    total += overlap * rate * (active ? route.teamGoldPerArrival : route.postAllianceGoldPerArrival);
  }
  return { total, inputs, config };
};

const run = (mode, goldenPath) => {
  const sandbox = createLegendaryStructureSandbox({
    vmFilename: "legendary-economy-projection-budget.mjs",
  });
  const supply = fleetProducerSupply();
  const alternateSupplies = [fleetProducerSupply(), fleetProducerSupply(1)];
  sandbox.config = sharedConfig();
  const plannerSha256 = plannerSourceSha256();

  if (mode === "capture") {
    assert.equal(plannerSha256, BEFORE_PLANNER_SHA256, "capture must use the recorded pre-optimization planner");
    const cold = evaluateCandidates(sandbox, { freshConfigEachCall: true, supply });
    const warm = evaluateCandidates(sandbox, { freshConfigEachCall: false, supply });
    const mixed = [0, 1, 2, 3].map((index) => sandbox.legendaryEconomyNetGold("Port", {
      cost: 1000, horizonTicks: HORIZON_TICKS,
      inputs: candidateInputs(index, alternateSupplies[index % 2]), config: sandbox.config,
    }));
    writeFileSync(goldenPath, JSON.stringify({
      tag: "before", plannerSha256,
      cold: cold.map(serializeValue), warm: warm.map(serializeValue), mixed: mixed.map(serializeValue),
    }, null, 2) + "\n");
    console.log("captured goldens:", goldenPath);
    return 0;
  }

  let goldens;
  try {
    goldens = JSON.parse(readFileSync(goldenPath, "utf8"));
  } catch {
    console.error("golden file missing; run capture mode against the pre-optimization planner first");
    return 1;
  }
  assert.equal(goldens.tag, "before");
  assert.equal(goldens.plannerSha256, BEFORE_PLANNER_SHA256);
  let failed = false;

  const cold = timeCycle(() => evaluateCandidates(sandbox, { freshConfigEachCall: true, supply }));
  console.log("cold 25-candidate cycle:", cold.elapsedMs.toFixed(1), "ms");
  const coldMatch = JSON.stringify(cold.outputs.map(serializeValue)) === JSON.stringify(goldens.cold);
  console.log("cold identity vs golden:", coldMatch ? "PASS" : "FAIL");
  failed ||= !coldMatch;

  const warm1 = timeCycle(() => evaluateCandidates(sandbox, { freshConfigEachCall: false, supply }));
  console.log("warm 25-candidate cycle:", warm1.elapsedMs.toFixed(1), "ms");
  const warmMatch = JSON.stringify(warm1.outputs.map(serializeValue)) === JSON.stringify(goldens.warm);
  console.log("warm identity vs golden:", warmMatch ? "PASS" : "FAIL");
  failed ||= !warmMatch;

  const warm2 = timeCycle(() => evaluateCandidates(sandbox, { freshConfigEachCall: false, supply }));
  console.log("warm repeated cycle:", warm2.elapsedMs.toFixed(1), "ms");
  console.log("cycle2 <= cycle1:", warm2.elapsedMs <= warm1.elapsedMs ? "PASS" : "FAIL",
    "(", warm2.elapsedMs.toFixed(1), "<=", warm1.elapsedMs.toFixed(1), ")");
  failed ||= !(warm2.elapsedMs <= warm1.elapsedMs);

  console.log("hard budget cycle < 10000ms:", warm1.elapsedMs < 10000 ? "PASS" : "FAIL",
    "(", warm1.elapsedMs.toFixed(1), "ms )");
  failed ||= !(warm1.elapsedMs < 10000);

  const reference = bruteForceReference(sandbox, 40);
  const projected = sandbox.legendaryEconomyNetGold("Port", {
    cost: 1000,
    horizonTicks: 40,
    inputs: reference.inputs,
    config: reference.config,
  });
  const expectedNetGold = reference.total - 1000;
  const tolerance = 1e-12 * Math.max(1, Math.abs(expectedNetGold));
  const referenceAgrees = projected !== null && !projected.refused &&
    Math.abs(projected.netTeamGold - expectedNetGold) <= tolerance;
  console.log("small-horizon per-tick reference:", referenceAgrees ? "PASS" : "FAIL",
    "(net:", projected?.netTeamGold, "expected:", expectedNetGold, "tolerance:", tolerance, ")");
  failed ||= !referenceAgrees;

  const mixed = [0, 1, 2, 3].map((index) => sandbox.legendaryEconomyNetGold("Port", {
    cost: 1000, horizonTicks: HORIZON_TICKS,
    inputs: candidateInputs(index, alternateSupplies[index % 2]), config: sandbox.config,
  }));
  const mixedMatch = JSON.stringify(mixed.map(serializeValue)) === JSON.stringify(goldens.mixed);
  console.log("shared-config / distinct-supply identity:", mixedMatch ? "PASS" : "FAIL");
  failed ||= !mixedMatch;

  console.log(failed ? "FAILED" : "PASSED");
  return failed ? 1 : 0;
};

const mode = process.argv[2] === "capture" ? "capture" : "check";
const goldenPath = process.argv[3] ?? new URL("./fixtures/legendary-economy-projection-budget.golden.json", import.meta.url);
process.exit(run(mode, goldenPath));
