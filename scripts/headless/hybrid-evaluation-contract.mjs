import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

export const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const digest = (value) => createHash("sha256").update(value).digest("hex");
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const codeOrder = (a, b) => Number(a > b) - Number(a < b);
const matchSettings = new Set([
  "OFH_GAME_MAP",
  "OFH_GAME_MAP_SIZE",
  "OFH_GAME_MODE",
  "OFH_PLAYER_TEAMS",
  "OFH_STARTING_GOLD",
  "OFH_NATIONS",
  "OFH_BOTS",
  "OFH_BOT_DIFFICULTY",
  "OFH_5MM",
  "OFH_25MM",
  "OFH_NO_MODIFIERS",
  "OFH_TEMP_PVP_IMMUNITY",
  "OFH_NUKES",
  "OFH_AUTOBUILD",
]);
const startFields = new Set([
  "map",
  "mapSize",
  "mode",
  "teams",
  "difficulty",
  "botDifficulty",
  "autoBuild",
  "startingGold",
  "publicGameModifiers",
  "spawnImmunityDuration",
  "profile",
  "nations",
  "tribes",
  "myTeam",
]);

function validateEdges(buckets) {
  if (buckets === undefined) return;
  assert.ok(plain(buckets), "Invalid cohort buckets");
  for (const [key, edges] of Object.entries(buckets)) {
    assert.ok(["reserveRatio", "candidateCount"].includes(key), "Unknown cohort bucket");
    assert.ok(
      Array.isArray(edges) &&
        edges.length >= 2 &&
        edges.every(Number.isFinite) &&
        edges.every((edge, i) => i === 0 || edge > edges[i - 1]),
      "Invalid cohort bucket edges",
    );
  }
}

function validateCell(cell) {
  assert.ok(
    plain(cell) && typeof cell.name === "string" && cell.name.trim(),
    "Invalid cohort name",
  );
  assert.ok(
    Array.isArray(cell.seeds) &&
      cell.seeds.length > 0 &&
      cell.seeds.every((seed) => typeof seed === "string" && seed),
    "Invalid cohort seeds",
  );
  assert.ok(plain(cell.expected), "Missing expected cohort settings");
  assert.ok(
    Object.keys(cell.expected).every((key) => startFields.has(key)),
    "Unknown expected cohort setting",
  );
  for (const [key, value] of Object.entries(cell.environment ?? {})) {
    assert.ok(
      matchSettings.has(key) && typeof value === "string" && value.length > 0,
      `Unsupported cohort environment override: ${key}`,
    );
  }
  validateEdges(cell.buckets);
}

export function resolveCohorts(declaration, seeds) {
  if (declaration === undefined)
    return {
      declared: false,
      cells: [{ name: "implicit", seeds: [...seeds], expected: {} }],
      uncertainty: undefined,
    };
  assert.ok(
    declaration?.version === 1 && Array.isArray(declaration.cells) && declaration.cells.length,
    "Invalid cohort declaration",
  );
  declaration.cells.forEach(validateCell);
  const names = declaration.cells.map((cell) => cell.name);
  const assigned = declaration.cells.flatMap((cell) => cell.seeds);
  assert.equal(new Set(names).size, names.length, "Duplicate cohort name");
  assert.equal(new Set(assigned).size, assigned.length, "Duplicate cohort seed assignment");
  assert.equal(assigned.length, seeds.length, "Incomplete cohort coverage");
  assert.ok(
    seeds.every((seed) => assigned.includes(seed)),
    "Cohort seed coverage mismatch",
  );
  if (declaration.uncertainty !== undefined)
    validateUncertainty(declaration.uncertainty, seeds.length);
  return {
    declared: true,
    cells: structuredClone(declaration.cells),
    uncertainty: declaration.uncertainty,
  };
}

export function matchesCohort(start, cell) {
  return (
    Boolean(start) &&
    Object.entries(cell.expected).every(
      ([key, value]) => canonical(start[key]) === canonical(value),
    )
  );
}

function signTest(improved, regressed) {
  const n = improved + regressed;
  if (n === 0) return 1;
  const terms = [-n * Math.LN2];
  for (let k = 1; k <= Math.min(improved, regressed); k++) {
    terms.push(terms[k - 1] + Math.log(n - k + 1) - Math.log(k));
  }
  const maximum = Math.max(...terms);
  return Math.min(
    1,
    2 * Math.exp(maximum) * terms.reduce((sum, value) => sum + Math.exp(value - maximum), 0),
  );
}

function validateUncertainty(options, pairs) {
  assert.ok(
    options?.method === "bootstrap" &&
      Number.isFinite(options.confidence) &&
      options.confidence > 0 &&
      options.confidence < 1 &&
      integer(options.resamples) &&
      options.resamples > 0 &&
      typeof options.seed === "string" &&
      options.seed.length > 0,
    "Invalid explicit uncertainty parameters",
  );
  // Computational ceiling, not a statistical sample-size or promotion threshold.
  assert.ok(
    options.resamples * Math.max(1, pairs) <= 10_000_000,
    "uncertainty work exceeds bounded resampling budget",
  );
}

function bootstrapIndex(seed, size) {
  let sequence = 0;
  return () => {
    let value;
    do {
      value = createHash("sha256")
        .update(canonical([seed, sequence++]))
        .digest()
        .readUInt32BE();
    } while (value >= Math.floor(2 ** 32 / size) * size);
    return value % size;
  };
}

function confidenceInterval(differences, options) {
  if (!options) return null;
  validateUncertainty(options, differences.length);
  if (!differences.length) return null;
  const next = bootstrapIndex(options.seed, differences.length);
  const samples = Array.from({ length: options.resamples }, () => {
    let sum = 0;
    for (let i = 0; i < differences.length; i++) sum += differences[next()];
    return sum / differences.length;
  }).sort((a, b) => a - b);
  const tail = (1 - options.confidence) / 2;
  return {
    ...options,
    convention: "whole-pair-percentile-floor-index",
    pairs: differences.length,
    lower: samples[Math.floor(tail * (samples.length - 1))],
    upper: samples[Math.floor((1 - tail) * (samples.length - 1))],
  };
}

export function pairedUncertainty(pairs, options) {
  assert.ok(
    pairs.every(
      (pair) => typeof pair.baselineWin === "boolean" && typeof pair.learnedWin === "boolean",
    ),
    "Unverified paired outcomes",
  );
  const differences = pairs.map((pair) => Number(pair.learnedWin) - Number(pair.baselineWin));
  const improved = differences.filter((value) => value > 0).length;
  const regressed = differences.filter((value) => value < 0).length;
  return {
    pairs: pairs.length,
    improved,
    regressed,
    tied: pairs.length - improved - regressed,
    meanDifference: pairs.length ? (improved - regressed) / pairs.length : null,
    signTestP: pairs.length ? signTest(improved, regressed) : null,
    confidenceInterval: confidenceInterval(differences, options),
  };
}

function bucketIndex(value, edges) {
  if (!Number.isFinite(value)) return "unknown";
  if (value < edges[0]) return "below";
  for (let i = 0; i < edges.length - 1; i++) if (value < edges[i + 1]) return String(i);
  return value === edges.at(-1) ? String(edges.length - 2) : "above";
}

function uniqueDecisions(rows) {
  const unique = new Map();
  for (const row of rows) {
    assert.ok(
      plain(row) &&
        typeof row.runIdentity === "string" &&
        row.runIdentity.trim() &&
        [row.episodeId, row.generation, row.step, row.tick].every(integer),
      "Invalid decision identity",
    );
    const identity = canonical([row.runIdentity, row.episodeId, row.generation, row.step]);
    const previous = unique.get(identity);
    assert.ok(
      !previous || canonical(previous) === canonical(row),
      "Conflicting decision identity/content",
    );
    if (!previous) unique.set(identity, row);
  }
  return [...unique.values()];
}

export function summarizeDecisionRows(rows, buckets = {}) {
  if (rows === undefined)
    return {
      available: false,
      eligible: null,
      controlledWaits: null,
      frequency: null,
      buckets: [],
    };
  assert.ok(Array.isArray(rows), "Invalid actual decision rows");
  validateEdges(buckets);
  const inputRows = rows.length;
  rows = uniqueDecisions(rows);
  assert.ok(
    rows.every(
      (row) =>
        [true, false, null].includes(row.eligible) &&
        ["wait", "attack", null].includes(row.controlledAction),
    ),
    "Invalid historical eligibility/control",
  );
  const eligible = rows.filter((row) => row.eligible === true);
  const controlledWaits = eligible.filter((row) => row.controlledAction === "wait").length;
  const groups = new Map();
  for (const row of eligible) {
    const labels = Object.fromEntries(
      Object.entries(buckets).map(([key, edges]) => [key, bucketIndex(row[key], edges)]),
    );
    const key = canonical(labels);
    const group = groups.get(key) ?? { labels, eligible: 0, controlledWaits: 0 };
    group.eligible++;
    if (row.controlledAction === "wait") group.controlledWaits++;
    groups.set(key, group);
  }
  const margins = rows.map((row) => row.utilityMargin).filter(Number.isFinite);
  return {
    available: true,
    total: rows.length,
    inputRows,
    duplicatesExcluded: inputRows - rows.length,
    eligible: eligible.length,
    controlledWaits,
    ineligible: rows.filter((row) => row.eligible === false).length,
    unknown: rows.filter((row) => row.eligible === null).length,
    frequency: eligible.length ? controlledWaits / eligible.length : null,
    bucketEdges: buckets,
    intervalConvention: "left-closed-right-open-last-closed-with-outside-and-unknown",
    buckets: [...groups.values()].map((group) => ({
      ...group,
      frequency: group.controlledWaits / group.eligible,
    })),
    utilityMargin: {
      samples: margins.length,
      mean: margins.length ? margins.reduce((sum, value) => sum + value, 0) / margins.length : null,
    },
  };
}

const controlKeys = [
  "candidateDecisions",
  "controlledWaits",
  "acceptedLearnedAttacks",
  "confirmedLearnedAttacks",
  "fallbacks",
];
const safetyKeys = ["reserveChecks", "reserveViolations", "legalityChecks", "illegalEmissions"];
const coverageKeys = ["knownAttempts", "unknownAttempts", "emissionsWithoutChecks"];
const budgetKeys = ["accepted", "rejected"];
const validCounters = (value, keys) => plain(value) && keys.every((key) => integer(value[key]));
const validControl = (value) =>
  validCounters(value, controlKeys) &&
  value.controlledWaits <= value.candidateDecisions &&
  value.confirmedLearnedAttacks <= value.acceptedLearnedAttacks;
const validSafety = (value) =>
  validCounters(value, safetyKeys) &&
  value.reserveViolations <= value.reserveChecks &&
  value.illegalEmissions <= value.legalityChecks;

function checkedCounters(value, keys, label) {
  if (value === undefined || value === null) return null;
  if (keys.some((key) => value[key] == null)) return null;
  assert.ok(validCounters(value, keys), `Invalid ${label} counters`);
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function latencySummary(values, scope) {
  if (values === undefined || values === null) return null;
  assert.ok(
    scope === "hybrid-decision-wall-ms" &&
      Array.isArray(values) &&
      values.every((value) => Number.isFinite(value) && value >= 0),
    "Invalid measured latency scope/values",
  );
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return {
    scope,
    samples: ordered.length,
    maxMs: ordered.length ? ordered.at(-1) : null,
    medianMs: ordered.length
      ? (ordered[middle] + ordered[Math.floor((ordered.length - 1) / 2)]) / 2
      : null,
  };
}

export function summarizeTelemetry(result, cell = {}) {
  const evidence = result.hybridEvaluation ?? {};
  const control = checkedCounters(
    result.hybridCombat?.diagnostics?.control,
    controlKeys,
    "control",
  );
  if (control) assert.ok(validControl(control), "Impossible control counters");
  const safety = checkedCounters(evidence.safety, safetyKeys, "safety");
  if (safety) assert.ok(validSafety(safety), "Impossible reserve/legality counters");
  if (evidence.transitions !== undefined) validateTransitions(evidence.transitions);
  return {
    control,
    conditionalWait: summarizeDecisionRows(evidence.decisionRows, cell.buckets),
    latency: latencySummary(evidence.latencyMs, evidence.latencyScope),
    safety,
    safetyScope: evidence.safetyScope ?? null,
    coverage: checkedCounters(evidence.coverage, coverageKeys, "safety coverage"),
    budget: checkedCounters(result.intentBudget, budgetKeys, "intent gate budget"),
    transitions: evidence.transitions ?? null,
  };
}

function validateTransition(row) {
  assert.ok(
    row &&
      (typeof row.episodeId === "string" || integer(row.episodeId)) &&
      integer(row.step) &&
      integer(row.tick) &&
      integer(row.nextTick) &&
      row.nextTick >= row.tick,
    "Invalid transition identity/time",
  );
  assert.ok(
    [row.first, row.terminated, row.truncated, row.envError].every(
      (flag) => typeof flag === "boolean",
    ) && Number(row.terminated) + Number(row.truncated) + Number(row.envError) <= 1,
    "Invalid transition flags",
  );
}

export function validateTransitions(rows) {
  assert.ok(Array.isArray(rows), "Invalid transition stream");
  const episodes = new Map();
  for (const row of rows) {
    validateTransition(row);
    const previous = episodes.get(row.episodeId);
    assert.ok(!previous?.closed, "Transition after closed episode");
    assert.equal(row.first, previous === undefined, "Invalid FIRST flag");
    assert.equal(row.step, previous ? previous.step + 1 : 0, "Transition step gap");
    assert.ok(!previous || row.tick >= previous.nextTick, "Transition clock reversal");
    episodes.set(row.episodeId, {
      step: row.step,
      nextTick: row.nextTick,
      closed: row.terminated || row.truncated || row.envError,
    });
  }
  return rows;
}

export function transitionDiagnostic(row, shaping) {
  validateTransition(row);
  assert.ok(
    Number.isFinite(shaping?.gammaTick) &&
      shaping.gammaTick >= 0 &&
      shaping.gammaTick <= 1 &&
      Number.isFinite(shaping.coefficient),
    "Invalid declared shaping parameters",
  );
  if (row.envError) return { usable: false, reward: null, bootstrapDiscount: null };
  assert.ok(
    [row.baseReward, row.potential, row.nextPotential].every(Number.isFinite),
    "Missing observed potential/reward",
  );
  const discount = shaping.gammaTick ** (row.nextTick - row.tick);
  return {
    usable: true,
    reward:
      row.baseReward +
      shaping.coefficient * (discount * (row.terminated ? 0 : row.nextPotential) - row.potential),
    discount,
    bootstrapDiscount: row.terminated ? 0 : discount,
    truncated: row.truncated,
  };
}

export class FifoTransport {
  constructor() {
    this.queue = [];
    this.lastTick = new Map();
    this.sequence = 0;
  }
  schedule({ seat, tick, delayTicks, intents }) {
    assert.ok(
      typeof seat === "string" &&
        seat &&
        integer(tick) &&
        integer(delayTicks) &&
        Array.isArray(intents),
      "Invalid FIFO batch",
    );
    if (!intents.length) return null;
    const deliveryTick = Math.max(tick + delayTicks, this.lastTick.get(seat) ?? 0);
    assert.ok(integer(deliveryTick), "FIFO tick overflow");
    const batch = {
      seat,
      tick,
      deliveryTick,
      sequence: this.sequence++,
      intents: structuredClone(intents),
    };
    this.lastTick.set(seat, deliveryTick);
    this.queue.push(batch);
    return structuredClone(batch);
  }
  take(tick) {
    assert.ok(integer(tick), "Invalid FIFO drain tick");
    const due = this.queue
      .filter((batch) => batch.deliveryTick <= tick)
      .sort(
        (a, b) =>
          a.deliveryTick - b.deliveryTick || codeOrder(a.seat, b.seat) || a.sequence - b.sequence,
      );
    this.queue = this.queue.filter((batch) => batch.deliveryTick > tick);
    return structuredClone(due);
  }
  clear() {
    this.queue = [];
    this.lastTick.clear();
    this.sequence = 0;
  }
}

const manifestKeys = [
  "runID",
  "seed",
  "engineRevision",
  "experimentID",
  "sourceHash",
  "harnessHash",
  "bundleHash",
  "configurationHash",
  "featureHash",
  "normalizerHash",
  "modelHash",
];
export function selectReplayGroup(dataset, selection) {
  assert.ok(
    dataset?.version === "ofh-hybrid-ledger-v1" &&
      Array.isArray(dataset.manifests) &&
      Array.isArray(dataset.records),
    "Invalid ledger dataset",
  );
  const manifest = selection?.manifest;
  assert.ok(
    manifestKeys.every((key) => typeof manifest?.[key] === "string" && manifest[key]) &&
      manifest.learning === false &&
      manifest.mode === "shadow",
    "Incomplete frozen replay manifest",
  );
  assert.ok(
    dataset.manifests.some((item) => canonical(item) === canonical(manifest)),
    "Selected manifest absent from dataset",
  );
  assert.ok(
    integer(selection.episodeId) &&
      integer(selection.generation) &&
      typeof selection.modelIdentity === "string",
    "Invalid replay group identity",
  );
  const records = [];
  const excluded = [];
  for (const item of dataset.records) {
    assert.ok(
      dataset.manifests.some((entry) => canonical(entry) === canonical(item.manifest)),
      "Unattested dataset manifest",
    );
    const sameRun = canonical(item.manifest) === canonical(manifest);
    const sameIdentity =
      item.event.episodeId === selection.episodeId &&
      item.event.generation === selection.generation &&
      item.event.modelIdentity === selection.modelIdentity;
    if (sameRun && sameIdentity)
      records.push({
        ...item.event,
        engineRevision: manifest.engineRevision,
        experimentID: manifest.experimentID,
      });
    else
      excluded.push({
        runID: item.manifest.runID,
        seed: item.manifest.seed,
        episodeId: item.event.episodeId,
        generation: item.event.generation,
        reason: sameRun ? "different-original-identity" : "different-run-or-seed",
      });
  }
  assert.ok(records.length > 0, "Selected replay group has no records");
  return { manifest, records, excluded, snapshot: JSON.parse(selection.modelIdentity) };
}

function localImports(file) {
  const tree = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(tree) === "require")
    ) {
      assert.ok(
        node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]),
        `Nonliteral harness import in ${file}`,
      );
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

function insideScope(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function scopedSource(scope, file) {
  assert.ok(
    insideScope(scope.declaredRoot, file) || insideScope(scope.realRoot, file),
    `Outside declared source scope: ${file}`,
  );
  const resolved = fs.realpathSync(file);
  assert.ok(insideScope(scope.realRoot, resolved), `Outside real source scope: ${file}`);
  return resolved;
}

function importedFile(scope, file, specifier) {
  if (specifier.includes("?")) {
    assert.ok(
      specifier.endsWith("?worker&inline"),
      `Unsupported harness import query: ${specifier}`,
    );
    specifier = specifier.slice(0, -"?worker&inline".length);
  }
  let base;
  if (path.isAbsolute(specifier)) base = specifier;
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(file), specifier);
  else if (specifier.startsWith("src/") || specifier.startsWith("resources/"))
    base = path.join(scope.declaredRoot, "openfront-engine", specifier);
  else return null;
  const candidates = [
    base,
    ...[".ts", ".mts", ".js", ".mjs", ".json"].map((extension) => base + extension),
    path.join(base, "index.ts"),
  ];
  if (base.endsWith(".js")) candidates.push(base.slice(0, -3) + ".ts");
  const resolved = candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  assert.ok(resolved, `Unresolved harness source import: ${specifier}`);
  return scopedSource(scope, resolved);
}

function importEvidence(scope, file, specifier, externalManifest) {
  const dependency = importedFile(scope, file, specifier);
  if (!dependency) {
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    assert.ok(
      builtinModules.includes(specifier.replace(/^node:/, "")) ||
        Object.hasOwn(externalManifest, packageName),
      `Unmanifested external harness import: ${specifier}`,
    );
  }
  return {
    dependency,
    entry: {
      importer: path.relative(scope.realRoot, file),
      specifier,
      resolved: dependency ? path.relative(scope.realRoot, dependency) : null,
      realPath: dependency,
      scope: dependency ? "source" : "external-manifest",
    },
  };
}

export function fingerprintSources(root, declaredPaths, externalManifest = {}) {
  const sourceScope = { declaredRoot: path.resolve(root), realRoot: fs.realpathSync(root) };
  const queue = declaredPaths.map((file) => scopedSource(sourceScope, path.resolve(root, file)));
  const files = new Map();
  const imports = [];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    const bytes = fs.readFileSync(file);
    files.set(file, digest(bytes));
    if (file.endsWith(".json")) continue;
    for (const specifier of localImports(file)) {
      const { dependency, entry } = importEvidence(sourceScope, file, specifier, externalManifest);
      imports.push(entry);
      if (dependency) queue.push(dependency);
    }
  }
  const sources = Object.fromEntries(
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, value]) => [path.relative(sourceScope.realRoot, file), value]),
  );
  imports.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return {
    hash: digest(canonical({ sourceScope, sources, imports, externalManifest })),
    sourceScope,
    declaredPaths: [...declaredPaths],
    sources,
    imports,
    externalManifest,
  };
}

const requirementLimits = [
  "minimumPairsPerCell",
  "minimumControlledDecisions",
  "minimumReserveChecks",
  "minimumLegalityChecks",
  "maximumReserveViolations",
  "maximumIllegalEmissions",
  "minimumLatencySamples",
  "maximumBudgetRejections",
];
function validateRequirements(value) {
  assert.equal(value?.version, 1, "Invalid preregistered requirements version");
  assert.ok(Array.isArray(value.cells) && value.cells.length > 0, "Invalid requirements cells");
  assert.equal(new Set(value.cells).size, value.cells.length, "Duplicate requirements cells");
  assert.ok(
    value.cells.every((name) => typeof name === "string" && name),
    "Invalid requirements cell name",
  );
  assert.ok(
    requirementLimits.every((key) => integer(value[key])),
    "Invalid requirements count limits",
  );
  assert.ok(Number.isFinite(value.minimumWinDifference), "Invalid requirements win difference");
  assert.ok(
    Number.isFinite(value.maximumLatencyMs) && value.maximumLatencyMs >= 0,
    "Invalid requirements latency",
  );
  assert.equal(typeof value.noCellRegression, "boolean", "Invalid requirements regression flag");
  assert.equal(
    typeof value.requireKnownSafetyCoverage,
    "boolean",
    "Invalid requirements safety coverage flag",
  );
  assert.equal(value.safetyScope, "learned-attack-gate", "Invalid requirements safety scope");
  if (value.uncertainty) {
    validateUncertainty(value.uncertainty, 0);
    assert.ok(
      Number.isFinite(value.minimumConfidenceLowerBound),
      "Missing requirements uncertainty bound",
    );
  } else
    assert.ok(
      Number.isFinite(value.maximumSignTestP) &&
        value.maximumSignTestP >= 0 &&
        value.maximumSignTestP <= 1,
      "Missing requirements uncertainty bound",
    );
}

function validLatency(value) {
  if (!plain(value) || value.scope !== "hybrid-decision-wall-ms" || !integer(value.samples))
    return false;
  if (value.samples === 0) return value.maxMs === null && value.medianMs === null;
  return (
    [value.maxMs, value.medianMs].every((number) => Number.isFinite(number) && number >= 0) &&
    value.medianMs <= value.maxMs
  );
}

function validCosts(item) {
  return (
    plain(item) &&
    validControl(item.control) &&
    validSafety(item.safety) &&
    validLatency(item.latency) &&
    validCounters(item.budget, budgetKeys) &&
    (item.coverage == null || validCounters(item.coverage, coverageKeys))
  );
}

function costChecks(rows, requirements) {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every(
      (item) =>
        validCosts(item) &&
        item.control.candidateDecisions >= requirements.minimumControlledDecisions &&
        item.safetyScope === requirements.safetyScope &&
        item.safety &&
        item.safety.reserveChecks >= requirements.minimumReserveChecks &&
        item.safety.legalityChecks >= requirements.minimumLegalityChecks &&
        item.safety.reserveViolations <= requirements.maximumReserveViolations &&
        item.safety.illegalEmissions <= requirements.maximumIllegalEmissions &&
        item.latency &&
        item.latency.samples >= requirements.minimumLatencySamples &&
        item.latency.maxMs !== null &&
        item.latency.maxMs <= requirements.maximumLatencyMs &&
        item.budget &&
        item.budget.rejected <= requirements.maximumBudgetRejections,
    )
  );
}

function uncertaintyAccepted(uncertainty, requirements) {
  if (!uncertainty || uncertainty.meanDifference === null) return false;
  if (requirements.uncertainty) {
    const interval = uncertainty.confidenceInterval;
    return (
      Boolean(interval) &&
      Object.entries(requirements.uncertainty).every(([key, value]) => interval[key] === value) &&
      interval.lower >= requirements.minimumConfidenceLowerBound
    );
  }
  return uncertainty.signTestP !== null && uncertainty.signTestP <= requirements.maximumSignTestP;
}

function cellChecks(cell, requirements) {
  if (!cell) return { complete: false, telemetry: false, safetyCoverage: false };
  const noRegression =
    !requirements.noCellRegression ||
    (cell.uncertainty?.meanDifference != null && cell.uncertainty.meanDifference >= 0);
  const knownCoverage =
    (cell.telemetry?.length ?? 0) > 0 &&
    cell.telemetry.every(
      (item) =>
        validCounters(item.coverage, coverageKeys) &&
        item.coverage.unknownAttempts === 0 &&
        item.coverage.emissionsWithoutChecks === 0,
    );
  return {
    complete:
      integer(cell.completed) &&
      integer(cell.requested) &&
      cell.completed === cell.requested &&
      cell.completed >= requirements.minimumPairsPerCell &&
      noRegression,
    telemetry: costChecks(cell.telemetry ?? [], requirements),
    safetyCoverage: !requirements.requireKnownSafetyCoverage || knownCoverage,
  };
}

export function assessCandidatePromotion(report, requirements) {
  validateRequirements(requirements);
  const requirementsHash = digest(canonical(requirements));
  const preregistered =
    report.requirementsHash === requirementsHash && report.requirementsFrozenBeforeLaunch === true;
  const checks = {
    preregistered,
    frozen: report.frozenVerified === true,
    declaredCoverage: report.coverage?.declared === true,
    exactCells:
      canonical(report.coverage?.cells?.map((cell) => cell.name).sort()) ===
      canonical([...requirements.cells].sort()),
    uncertainty: uncertaintyAccepted(report.uncertainty, requirements),
    winDifference:
      report.uncertainty?.meanDifference != null &&
      report.uncertainty.meanDifference >= requirements.minimumWinDifference,
  };
  for (const name of requirements.cells) {
    const cell = report.coverage?.cells?.find((entry) => entry.name === name);
    const assessed = cellChecks(cell, requirements);
    checks[`cell:${name}`] = assessed.complete;
    checks[`telemetry:${name}`] = assessed.telemetry;
    checks[`safetyCoverage:${name}`] = assessed.safetyCoverage;
  }
  const blockers = Object.keys(checks).filter((key) => !checks[key]);
  return {
    eligible: blockers.length === 0,
    checks,
    blockers,
    requirementsHash,
    registration: preregistered ? "preregistered-report-bound" : "posthoc-unverified",
    manualOnly: true,
    activationPerformed: false,
  };
}
