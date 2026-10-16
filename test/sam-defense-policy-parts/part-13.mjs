    gold,
    "Ports keep the full budget during the first-SAM window: on water maps they are the economy that funds the interceptor, and gating them starved the trade economy (measured team-basket regression, 2026-09-11)",
  );
  assert.equal(budget.availableGoldAfterReserve(UNIT.SAMLauncher), gold);
  assert.equal(
    budget.availableGoldAfterReserve(UNIT.DefensePost),
    0n,
    "Defense Posts also wait behind the first-Silo fund while the nuclear opening is missing",
  );
  gold = 2_500_000n;
  assert.equal(
    budget.availableGoldAfterReserve(UNIT.City),
    1_000_000n,
    "surplus above the complete interceptor cost remains spendable",
  );
  gold = 1_000_000n;
  income = false;
  assert.equal(
    budget.availableGoldAfterReserve(UNIT.City),
    gold,
    "the first income source can still bootstrap the treasury",
  );
  income = true;
  builtThreat = false;
  assert.equal(budget.availableGoldAfterReserve(UNIT.City), gold);
  builtThreat = true;
  sams = [{ isUnderConstruction: () => true }];
  assert.equal(
    budget.availableGoldAfterReserve(UNIT.City),
    gold,
    "a SAM already ordered releases its first-launcher fund",
  );
}
const reserveBudgetCalls = [];
behavior.legendaryReserveGold = () => 25_000_000n;
own.gold = () => 20_000_000n;
assert.equal(
  behavior.spendableConstructionGold(),
  20_000_000n,
  "A MIRV reserve does not reduce the ordinary construction budget",
);
assert.equal(
  behavior.availableGoldAfterReserve(UNIT.City),
  20_000_000n,
  "A MIRV reserve does not block a City",
);
assert.equal(
  behavior.availableGoldAfterReserve(UNIT.SAMLauncher),
  20_000_000n,
  "A MIRV reserve does not block a SAM",
);
const existingSilosForReserve = own.silos;
own.silos = [];
assert.equal(
  behavior.availableGoldAfterReserve(UNIT.MissileSilo),
  20_000_000n,
  "A nuclear war chest cannot block the first Silo needed to launch it",
);
own.silos = existingSilosForReserve;
assert.equal(
  behavior.availableGoldAfterReserve(UNIT.MissileSilo),
  0n,
  "A MIRV reserve still applies after a Silo already exists",
);
behavior.getPerceivedCost = () => 1_000_000n;
behavior.maybeSpawnStructure = async (type) => {
  reserveBudgetCalls.push(type);
  return type === UNIT.City;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "High-gold economic construction remains active while a MIRV reserve is set",
);
assert.deepEqual(
  reserveBudgetCalls,
  [UNIT.City],
  "The City path remains first under a MIRV reserve",
);
behavior.getPerceivedCost = originalPerceivedCost;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior.legendaryReserveGold = originalReserveForBudget;
own.gold = originalOwnGold;

let hostileAttemptTick = 1000;
behavior.game.ticks = () => hostileAttemptTick;
const hostileSamCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  hostileSamCalls.push(args);
  return true;
};
const preemptiveOwnSams = own.sams;
const preemptiveLaunchObserved = behavior._hostileMissileLaunchObserved;
own.sams = [];
behavior._hostileMissileLaunchObserved = false;
assert.equal(
  behavior.shouldBuildHostileSiloSam(),
  true,
  "A confirmed hostile Silo threat authorizes the first SAM before a missile launches",
);
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  true,
  "A hostile silo threat requests one dedicated SAM",
);
assert.equal(
  hostileSamCalls.length,
  1,
  "A successful threat SAM request crosses the placement path once",
);
assert.deepEqual(
  hostileSamCalls.map(([type, options]) => [
    type,
    {
      allowPreemptiveSam: options.allowPreemptiveSam,
      useActualCost: options.useActualCost,
      forceNewStructure: options.forceNewStructure,
      prioritizeStructureCoverage: options.prioritizeStructureCoverage,
      probeLimit: options.probeLimit,
      probeTimeoutMs: options.probeTimeoutMs,
      parallelProbeCount: options.parallelProbeCount,
    },
  ]),
  [
    [
      UNIT.SAMLauncher,
      {
        allowPreemptiveSam: true,
        useActualCost: true,
        forceNewStructure: true,
        prioritizeStructureCoverage: true,
        probeLimit: 25,
        probeTimeoutMs: 2500,
        parallelProbeCount: 6,
      },
    ],
  ],
  "The dedicated SAM request forces a bounded coverage-ranked placement",
);
own.sams = preemptiveOwnSams;
behavior._hostileMissileLaunchObserved = preemptiveLaunchObserved;
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "The dedicated threat SAM is not repeated within the same game tick",
);
hostileAttemptTick++;
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  true,
  "A remaining hostile Silo site gap allows another SAM on a later tick",
);
assert.equal(
  hostileSamCalls.length,
  2,
  "SAM construction is not permanently disabled after the first successful build",
);
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior._hostileSiloSamAttemptTick = null;
const failedHostileSamCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  failedHostileSamCalls.push(args);
  return false;
};
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A failed dedicated SAM request returns without claiming that the SAM was built",
);
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A failed dedicated SAM request is not repeated within the same game tick",
);
assert.equal(
  failedHostileSamCalls.length,
  1,
  "A failed dedicated SAM request crosses the placement path only once per tick",
);
hostileAttemptTick++;
await behavior.maybeSpawnHostileSiloSam();
assert.equal(
  failedHostileSamCalls.length,
  1,
  "A failed dedicated SAM request is not retried during its short placement backoff",
);
hostileAttemptTick += 9;
