import assert from "node:assert/strict";
import { validate } from "../scripts/headless/validate-legendary-goal.mjs";

const passing = {
  won: true,
  intentBudgetViolated: false,
  goalRequirements: {
    // Trade captures and veterancy are enforced at the match-set level.
    tradeCaptured: 0,
    maxWarshipVeterancy: 0,
    nukedStructureGold: "5000000",
    enemyStructureValueAtEnd: "9000000",
    ownStructuresNuked: 0,
    ownTransportBoatsLost: 2,
    enemyTransportBoatsDestroyed: 3,
    seaInvasionObserved: false,
    allInvasionsRecaptured: true,
    firstReadySamTick: null,
    firstOwnStructureLostTick: null,
    // The amended per-game land check is top-3 among non-Nations at 180 s.
    landLeaderAt120Seconds: { isOwn: false },
    landLeaderNonNationAt180Seconds: { ownRank: 3 },
    bestEconomy: true,
  },
};

{
  const report = validate(passing);
  assert.equal(report.passed, true);
  assert.deepEqual(report.failed, []);
}

{
  const failed = structuredClone(passing);
  failed.goalRequirements.landLeaderNonNationAt180Seconds.ownRank = 4;
  failed.goalRequirements.ownTransportBoatsLost = 3;
  failed.goalRequirements.enemyTransportBoatsDestroyed = 2;
  failed.goalRequirements.ownStructuresNuked = 1;
  failed.goalRequirements.firstReadySamTick = 20;
  failed.goalRequirements.firstOwnStructureLostTick = 10;
  const report = validate(failed);
  assert.equal(report.passed, false);
  assert.ok(report.failed.includes("leader180Top3NonNation"));
  assert.ok(report.failed.includes("ownTransportBoatsLost"));
  assert.ok(report.failed.includes("enemyTransportKills"));
  assert.ok(report.failed.includes("ownStructuresNuked"));
  assert.ok(report.failed.includes("samReadyA4"));
}

{
  const conquestException = structuredClone(passing);
  conquestException.goalRequirements.nukedStructureGold = "0";
  conquestException.goalRequirements.enemyStructureValueAtEnd = "4999999";
  const report = validate(conquestException);
  assert.equal(report.passed, true);
}

{
  const failed = structuredClone(passing);
  failed.goalRequirements.seaInvasionObserved = true;
  failed.goalRequirements.allInvasionsRecaptured = false;
  failed.goalRequirements.bestEconomy = false;
  const report = validate(failed);
  assert.equal(report.passed, false);
  assert.ok(report.failed.includes("invasionsRecaptured"));
  assert.ok(report.failed.includes("bestEconomy"));
}

console.log("legendary goal validator tests passed");
