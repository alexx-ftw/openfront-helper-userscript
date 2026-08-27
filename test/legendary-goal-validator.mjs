import assert from "node:assert/strict";
import { validate } from "../scripts/headless/validate-legendary-goal.mjs";

const passing = {
  won: true,
  goalRequirements: {
    tradeCaptured: 33,
    warshipsDestroyed: 5,
    maxWarshipVeterancy: 3,
    nukedStructureGold: "5000000",
    enemyStructureValueAtEnd: "9000000",
    ownStructuresNuked: 0,
    ownTransportBoatsLost: 0,
    seaInvasionObserved: false,
    allInvasionsRecaptured: true,
    samReadyBeforeFirstHostileNuke: true,
    landLeaderAt120Seconds: { isOwn: true },
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
  failed.goalRequirements.tradeCaptured = 32;
  failed.goalRequirements.ownStructuresNuked = 1;
  const report = validate(failed);
  assert.equal(report.passed, false);
  assert.ok(report.failed.includes("tradeCaptured"));
  assert.ok(report.failed.includes("ownStructuresNuked"));
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
  failed.goalRequirements.landLeaderAt120Seconds = { isOwn: false };
  failed.goalRequirements.bestEconomy = false;
  failed.goalRequirements.samReadyBeforeFirstHostileNuke = false;
  const report = validate(failed);
  assert.equal(report.passed, false);
  assert.ok(report.failed.includes("landLeaderAt120Seconds"));
  assert.ok(report.failed.includes("bestEconomy"));
  assert.ok(report.failed.includes("samReadyBeforeFirstHostileNuke"));
}

console.log("legendary goal validator tests passed");
