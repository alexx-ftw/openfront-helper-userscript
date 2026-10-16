import assert from "node:assert/strict";
import { readStructureBehaviorSource } from "./helpers/structure-behavior-source.mjs";
import { executeClassicScript } from "./helpers/repository-fixture.mjs";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";

let randomCalls = 0;
const math = Object.create(Math);
math.random = () => {
  randomCalls += 1;
  return 0.5;
};
const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
};
const sandbox = {
  UNIT,
  Difficulty: { Impossible: "Impossible", Legendary: "Legendary" },
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot" },
  state: { settings: { winFixes: true, buildStructures: {} }, stats: { builds: 0 } },
  currentDifficulty: () => sandbox.__difficulty,
  isLegendaryDifficulty: (difficulty) => difficulty === "Legendary",
  isAtLeastHardDifficulty: () => true,
  getBuildMenu: () => null,
  sendAutoBotBuildOrUpgrade: () => false,
  autoBotBuildAllowed: () => true,
  randTerritoryTileArray: () => [],
  setLastAction: () => {},
  tr: (value) => value,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  Math: math,
  console,
};
sandbox.globalThis = sandbox;
sandbox.__difficulty = "Legendary";
executeClassicScript(
  `${readLegendaryPlannerSource()}\n${readStructureBehaviorSource()}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: "silo-probe-budget.vm.js" },
);

const tile = (id) => ({ id });
const PROBE = { probeLimit: 8, parallelProbeCount: 4, probeTimeoutMs: 777 };
const EMERGENCY = {};

function makeBehavior({
  validTiles,
  blockedTiles = new Set(),
  hybridTiles = new Set(),
  timedOutTiles = new Set(),
  unsafeSnappedTiles = new Set(),
  snappedTiles = new Map(),
  snapshotStaleAfter,
}) {
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  const quotes = [];
  let snapshotCalls = 0;
  behavior.buildableFor = async (type, t, timeoutMs) => {
    assert.equal(timeoutMs, PROBE.probeTimeoutMs, "probes carry the configured timeout");
    quotes.push(t.id);
    if (timedOutTiles.has(t.id)) return null;
    const canBuild = snappedTiles.has(t.id)
      ? snappedTiles.get(t.id)
      : validTiles.has(t.id) || hybridTiles.has(t.id);
    return {
      type,
      canBuild,
      canUpgrade: hybridTiles.has(t.id),
      descriptor: validTiles.has(t.id) ? "d" + t.id : undefined,
    };
  };
  behavior.structureEmergencySnapshotCurrent = () => {
    snapshotCalls += 1;
    return snapshotStaleAfter === undefined || snapshotCalls < snapshotStaleAfter;
  };
  behavior.structureEmergencyTileAllowed = (t) => !blockedTiles.has(t.id);
  behavior.isDangerousStructureTile = (t) =>
    unsafeSnappedTiles.has(typeof t === "object" && t !== null ? t.id : t);
  return { behavior, quotes };
}

const score = (ids) => ids.map((id) => ({ t: tile(id) }));

// Case 1: first admissible tile valid — one quote instead of four, same
// descriptor the baseline would have returned.
{
  const { behavior, quotes } = makeBehavior({ validTiles: new Set([1]) });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result?.descriptor, "d1");
  assert.deepEqual(quotes, [1], "only the lead tile is quoted");
}

// Case 2: lead rejected — same winner and the same total quote set as the
// baseline path (lead + the remaining first-batch tiles).
{
  const { behavior, quotes } = makeBehavior({ validTiles: new Set([2]) });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result?.descriptor, "d2");
  assert.deepEqual(quotes, [1, 2, 3, 4], "rejected lead falls through to the full batch");
}

// Case 3: every tile rejected — later batches still run within the probe limit.
{
  const { behavior, quotes } = makeBehavior({ validTiles: new Set() });
  const randomCallsBefore = randomCalls;
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4, 5]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result, null);
  assert.deepEqual(quotes, [1, 2, 3, 4, 5]);
  assert.equal(randomCalls, randomCallsBefore, "rejected probes do not move the random cursor");
}

// Case 4: non-silo types keep the baseline concurrent batch on Legendary.
{
  const { behavior, quotes } = makeBehavior({ validTiles: new Set([1]) });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.City,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result?.descriptor, "d1");
  assert.deepEqual(quotes, [1, 2, 3, 4], "non-silo placement keeps baseline quoting");
}

// Case 5: snapshot gone stale right after the lead quote — abort with the
// single quote, exactly like the baseline's post-batch staleness check.
{
  const { behavior, quotes } = makeBehavior({
    validTiles: new Set([1]),
    snapshotStaleAfter: 2,
  });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result, null, "a stale snapshot aborts before any build decision");
  assert.deepEqual(quotes, [1]);
}

// Case 6: winFixes disabled — silo placement keeps baseline quoting.
{
  sandbox.state.settings.winFixes = false;
  const { behavior, quotes } = makeBehavior({ validTiles: new Set([1]) });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result?.descriptor, "d1");
  assert.deepEqual(quotes, [1, 2, 3, 4], "no fast path without winFixes");
  sandbox.state.settings.winFixes = true;
}

// A blocked raw leader is skipped before selecting the first admissible tile.
{
  const { behavior, quotes } = makeBehavior({
    validTiles: new Set([2]),
    blockedTiles: new Set([1]),
  });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result?.descriptor, "d2");
  assert.deepEqual(quotes, [2]);
}

// Tile id 0 is a valid lead, not a falsy sentinel.
{
  const { behavior, quotes } = makeBehavior({
    validTiles: new Set([0]),
    snappedTiles: new Map([[0, 0]]),
  });
  const result = await behavior.probeRankedStructureTiles(
    score([0, 1, 2, 3]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result.descriptor, "d0");
  assert.deepEqual(quotes, [0]);
}

// The real placement-safety check rejects a dangerous snapped tile and falls through.
{
  const { behavior, quotes } = makeBehavior({
    validTiles: new Set([1, 2]),
    unsafeSnappedTiles: new Set([99]),
    snappedTiles: new Map([
      [1, 99],
      [2, 100],
    ]),
  });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result.descriptor, "d2");
  assert.deepEqual(quotes, [1, 2, 3, 4]);
}

// A hybrid build/upgrade result is rejected before the remaining batch is scored.
{
  const { behavior, quotes } = makeBehavior({
    validTiles: new Set([1, 2]),
    hybridTiles: new Set([1]),
  });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result.descriptor, "d2");
  assert.deepEqual(quotes, [1, 2, 3, 4]);
}

// A timed-out lead falls through to the remaining first batch.
{
  const { behavior, quotes } = makeBehavior({
    validTiles: new Set([2]),
    timedOutTiles: new Set([1]),
  });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result.descriptor, "d2");
  assert.deepEqual(quotes, [1, 2, 3, 4]);
}

// The optimization is Legendary-only.
{
  sandbox.__difficulty = "Impossible";
  const { behavior, quotes } = makeBehavior({ validTiles: new Set([1]) });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result.descriptor, "d1");
  assert.deepEqual(quotes, [1, 2, 3, 4]);
  sandbox.__difficulty = "Legendary";
}

// The configured candidate limit still bounds probes across later batches.
{
  const { behavior, quotes } = makeBehavior({ validTiles: new Set([9, 10]) });
  const result = await behavior.probeRankedStructureTiles(
    score([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    UNIT.MissileSilo,
    PROBE,
    EMERGENCY,
  );
  assert.equal(result, null);
  assert.deepEqual(quotes, [1, 2, 3, 4, 5, 6, 7, 8]);
}

process.stdout.write("silo probe budget tests passed\n");
