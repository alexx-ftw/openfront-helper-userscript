import fs from "node:fs";

const MIN_NUKED_GOLD = 5_000_000n;

function asBigInt(value) {
  return BigInt(value ?? 0);
}

export function validate(result) {
  const goal = result?.goalRequirements ?? {};
  const failed = [];
  const checks = {
    won: result?.won === true,
    tradeCaptured: Number(goal.tradeCaptured) >= 33,
    warshipsDestroyed: Number(goal.warshipsDestroyed) >= 5,
    maxWarshipVeterancy: Number(goal.maxWarshipVeterancy) >= 3,
    nukeQuota:
      asBigInt(goal.nukedStructureGold) >= MIN_NUKED_GOLD ||
      (result?.won === true && asBigInt(goal.enemyStructureValueAtEnd) < MIN_NUKED_GOLD),
    ownStructuresNuked: Number(goal.ownStructuresNuked) === 0,
    ownTransportBoatsLost: Number(goal.ownTransportBoatsLost) === 0,
    samReadyBeforeFirstHostileNuke: goal.samReadyBeforeFirstHostileNuke === true,
    landLeaderAt120Seconds: goal.landLeaderAt120Seconds?.isOwn === true,
    bestEconomy: goal.bestEconomy === true,
    intentBudget: result?.intentBudgetViolated !== true,
  };
  if (goal.seaInvasionObserved === true && goal.allInvasionsRecaptured !== true) {
    checks.allInvasionsRecaptured = false;
  }
  for (const [name, passed] of Object.entries(checks)) {
    if (!passed) failed.push(name);
  }
  return { passed: failed.length === 0, failed, checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = fs.readFileSync(0, "utf8").trim();
  if (!input) {
    console.error("validate-legendary-goal: expected a JSON result on stdin");
    process.exitCode = 2;
  } else {
    const report = validate(JSON.parse(input));
    console.log(JSON.stringify(report));
    process.exitCode = report.passed ? 0 : 1;
  }
}
