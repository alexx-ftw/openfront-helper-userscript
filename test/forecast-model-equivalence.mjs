import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createAutoJoinSandbox, read, ROOT } from "./helpers/autojoin-sandbox.mjs";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const referenceCommit = "da128b4e80d1c19bfb6fa0a01a7f9af6e8ef64fa";
const capture = process.argv.includes("--capture");
const source = capture
  ? execFileSync("/usr/bin/git", ["show", `${referenceCommit}:engine/lobby/auto-join.js`], {
      cwd: ROOT,
      encoding: "utf8",
    })
  : read("engine/lobby/auto-join.js");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const referenceSourceHash = "20fde24968eaba251db7a2f5f3a6095da7f555833c43c4e880e1e04392d475c0";
if (capture) assert.equal(sha256(source), referenceSourceHash, "capture reads the pinned baseline");
const mapRealm = {};
executeClassicScript(read("engine/map-data.js"), mapRealm);
const maps = Array.from(mapRealm.OPENFRONT_MAPS, ({ id, name }) => ({ id, name }));
const filterKeys = [
  "startingGold0M",
  "randomSpawn",
  "crowded",
  "compact",
  "alliancesDisabled",
  "portsDisabled",
  "nukesDisabled",
  "samsDisabled",
  "mirvDisabled",
  "waterNukes",
  "peaceTime4m",
  "startingGold5M",
  "startingGold1M",
  "startingGold25M",
  "goldMultiplier2x",
];
const startGoldFilterKeys = [
  "startingGold0M",
  "startingGold1M",
  "startingGold5M",
  "startingGold25M",
];
const sandbox = createAutoJoinSandbox(
  `
let forecastMapReads = 0;
MAPS.splice(0, MAPS.length, ...${JSON.stringify(maps)}.map(map => ({
  get id() { forecastMapReads++; return map.id; }, name: map.name,
})));
MAP_IDS.splice(0, MAP_IDS.length, ...${JSON.stringify(maps.map(({ id }) => id))});
let forecastMapBuilds = 0;
let forecastContextBuilds = 0;
const originalForecastMaps = getForecastMapsForType;
getForecastMapsForType = function(...args) {
  forecastMapBuilds++; return originalForecastMaps(...args);
};
if (typeof createForecastFilterContext === "function") {
  const originalContext = createForecastFilterContext;
  createForecastFilterContext = function(...args) {
    forecastContextBuilds++; return originalContext(...args);
  };
}
const forecastRandomValues = [];
const forecastScenarios = [];
const originalForecastScenario = createForecastScenario;
createForecastScenario = function(...args) {
  const value = originalForecastScenario(...args);
  forecastScenarios.push(value); return value;
};
const originalForecastRandom = nextLobbyForecastRandom;
nextLobbyForecastRandom = function() {
  const value = originalForecastRandom(); forecastRandomValues.push(value); return value;
};
globalThis.forecastHooks = {
  configure(settings, seed) {
    lobbyState.settings = { ...lobbyState.settings, mapFilters:{}, mapExcludeFilters:{},
      includeFilters:{}, excludeFilters:{}, minTeamSize:null, maxTeamSize:null, ...settings };
    lobbyForecastRandomState = seed;
    lobbyForecastModelCache.signature = "";
    forecastRandomValues.length = 0; forecastScenarios.length = 0; forecastMapReads = 0;
    forecastMapBuilds = 0; forecastContextBuilds = 0;
  },
  scenario: (...args) => createForecastScenario(...args),
  matches: (...args) => scenarioMatchesFilters(...args),
  settings: () => lobbyState.settings,
  weighted: (...args) => pickWeighted(...args),
  maps: MAPS,
  rates: getModelHitRates,
  inspect: () => ({ random: forecastRandomValues.slice(), scenarios: forecastScenarios.slice(), mapReads:forecastMapReads,
    rngState:lobbyForecastRandomState, mapBuilds:forecastMapBuilds, contextBuilds:forecastContextBuilds }),
};`,
  { filterKeys, startGoldFilterKeys, autoJoinSource: source },
);
const hooks = sandbox.forecastHooks;
const records = [];
const operations = [];
for (const [index, settings] of [
  {},
  { includeFilters: { compact: true } },
  { includeFilters: { crowded: true, waterNukes: true } },
  {
    includeFilters: { startingGold1M: true, startingGold25M: true },
    excludeFilters: { nukesDisabled: true },
  },
  { mapFilters: { baikal: true, fourislands: true, luna: true }, minTeamSize: 2, maxTeamSize: 4 },
  {
    mapExcludeFilters: { world: true, europe: true },
    excludeFilters: { compact: true, startingGold0M: true },
  },
  { mapFilters: { sierpinski: true, thebox: true, didier: true } },
].entries()) {
  hooks.configure(settings, 0x9e3779b9 + index);
  const rates = hooks.rates();
  const modelWork = hooks.inspect();
  if (!capture) {
    assert.equal(modelWork.mapBuilds, 3, "one weighted-map build per model type");
    assert.equal(modelWork.contextBuilds, 1, "one filter context per model-cache miss");
    assert.ok(
      modelWork.mapReads <= maps.length * 20,
      `model map walks remain bounded: ${modelWork.mapReads}`,
    );
  }
  const scenarios = [];
  for (const type of ["special", "ffa", "team"])
    for (let draw = 0; draw < 128; draw++) scenarios.push({ type, value: hooks.scenario(type) });
  const observation = hooks.inspect();
  const cached = hooks.rates();
  const afterCached = hooks.inspect();
  assert.equal(cached, rates, "unchanged filters reuse the existing model result");
  assert.equal(
    afterCached.random.length,
    observation.random.length,
    "cache hit draws no randomness",
  );
  assert.equal(afterCached.mapReads, observation.mapReads, "cache hit scans no maps");
  assert.equal(afterCached.mapBuilds, observation.mapBuilds, "cache hit builds no weighted maps");
  assert.equal(
    afterCached.contextBuilds,
    observation.contextBuilds,
    "cache hit builds no filter context",
  );
  records.push({
    index,
    settings,
    scenariosSHA256: sha256(JSON.stringify(scenarios)),
    allScenariosSHA256: sha256(JSON.stringify(observation.scenarios)),
    scenarioCount: observation.scenarios.length,
    randomSHA256: sha256(JSON.stringify(observation.random)),
    randomDraws: observation.random.length,
    rngState: observation.rngState,
    rates: JSON.parse(JSON.stringify(rates)),
  });
  operations.push({
    index,
    modelMapBuilds: modelWork.mapBuilds,
    modelContextBuilds: modelWork.contextBuilds,
    modelMapReads: modelWork.mapReads,
    totalMapReads: observation.mapReads,
    randomDraws: observation.random.length,
  });
}
const result = {
  referenceCommit,
  sourceSHA256: referenceSourceHash,
  mapsSHA256: sha256(JSON.stringify(maps)),
  mapCount: maps.length,
  records,
};
const goldenPath = new URL("./fixtures/forecast-model-equivalence.golden.json", import.meta.url);
if (capture) writeFileSync(goldenPath, JSON.stringify(result, null, 2) + "\n");
else
  assert.deepEqual(
    result,
    JSON.parse(readFileSync(goldenPath, "utf8")),
    "forecast scenarios, RNG draw order/count and output rates remain exactly unchanged",
  );
process.stdout.write(
  `PASS forecast equivalence: ${records.length} filter cases, ${maps.length} real maps; ${capture ? "capture" : "check"}\n`,
);
process.stdout.write(`Forecast map-build and read work: ${JSON.stringify(operations)}\n`);

// Direct matching must refresh its context after in-place UI settings mutations.
hooks.configure({}, 123);
const mutable = hooks.settings();
const candidate = {
  mapId: "world",
  teamSize: 2,
  compact: true,
  startingGold0M: false,
  startingGold1M: true,
  startingGold25M: false,
};
assert.equal(hooks.matches(candidate), true);
mutable.mapFilters.europe = true;
assert.equal(hooks.matches(candidate), false);
mutable.mapFilters.world = true;
assert.equal(hooks.matches(candidate), true);
mutable.mapExcludeFilters.world = true;
assert.equal(hooks.matches(candidate), false);
delete mutable.mapExcludeFilters.world;
mutable.includeFilters.compact = true;
assert.equal(hooks.matches(candidate), true);
mutable.excludeFilters.compact = true;
assert.equal(hooks.matches(candidate), false);
delete mutable.excludeFilters.compact;
mutable.includeFilters.startingGold25M = true;
assert.equal(hooks.matches(candidate), false);
mutable.includeFilters.startingGold1M = true;
assert.equal(hooks.matches(candidate), true, "starting-gold includes retain OR semantics");
mutable.excludeFilters.startingGold1M = true;
assert.equal(hooks.matches(candidate), false, "gold exclusion overrides includes");
delete mutable.excludeFilters.startingGold1M;
mutable.minTeamSize = 3;
assert.equal(hooks.matches(candidate), false);
mutable.minTeamSize = 2;
assert.equal(hooks.matches(candidate), true);
mutable.maxTeamSize = 1;
assert.equal(hooks.matches(candidate), false);
mutable.maxTeamSize = 2;
assert.equal(hooks.matches(candidate), true);
assert.equal(hooks.weighted([]), null);
assert.equal(hooks.weighted([{ weight: 0 }]), null);
const retainedMaps = hooks.maps.splice(0);
try {
  assert.equal(hooks.scenario("special"), null, "an empty live map catalog yields no scenario");
  assert.equal(hooks.scenario("team"), null);
} finally {
  hooks.maps.push(...retainedMaps);
}
process.stdout.write(
  "PASS forecast mutable filters, gold OR/exclusion, bounds and empty weights/catalog\n",
);

// An in-place filter change invalidates only the cached result, preserving the
// continuing PRNG stream; a fresh evaluation from that exact state must agree.
hooks.configure({}, 456);
const beforeMutation = hooks.rates();
const continuingSeed = hooks.inspect().rngState;
hooks.settings().includeFilters.compact = true;
const afterMutation = hooks.rates();
assert.notEqual(afterMutation, beforeMutation, "mutated filters invalidate the model cache");
assert.ok(hooks.inspect().random.length > 0);
hooks.configure({ includeFilters: { compact: true } }, continuingSeed);
assert.deepEqual(
  afterMutation,
  hooks.rates(),
  "cache invalidation matches fresh seeded evaluation",
);
process.stdout.write("PASS forecast in-place model-cache invalidation with continuing RNG state\n");
