import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const contractPath = new URL("../scripts/headless/hybrid-evaluation-contract.mjs", import.meta.url);
assert.ok(fs.existsSync(contractPath), "Six-contract evaluation API is not implemented");
const {
  resolveCohorts,
  matchesCohort,
  pairedUncertainty,
  summarizeDecisionRows,
  summarizeTelemetry,
  transitionDiagnostic,
  validateTransitions,
  outcomeTransitionFlags,
  assessCandidatePromotion,
  FifoTransport,
  selectReplayGroup,
  fingerprintSources,
  digest,
  canonical,
} = await import(contractPath);

const declaration = {
  version: 1,
  cells: [
    {
      name: "alps",
      seeds: ["a"],
      expected: { map: "Alps" },
      environment: { OFH_GAME_MAP: "Alps" },
      buckets: { reserveRatio: [0, 0.5, 1], candidateCount: [0, 2, 5] },
    },
    { name: "europe", seeds: ["b"], expected: { map: "Europe" } },
  ],
};
const cells = resolveCohorts(declaration, ["a", "b"]);
assert.equal(cells.declared, true);
assert.equal(resolveCohorts(undefined, ["a"]).declared, false);
assert.equal(matchesCohort({ map: "Europe" }, cells.cells[0]), false);
assert.equal(matchesCohort({ map: "Alps" }, cells.cells[0]), true);
for (const change of [
  (value) => {
    value.cells[1].seeds = ["a"];
  },
  (value) => {
    value.cells.pop();
  },
  (value) => {
    value.cells[0].environment.OFH_BUNDLE_PATH = "other";
  },
  (value) => {
    value.cells[0].environment.OFH_INJECT_OWN_PORT = "1";
  },
  (value) => {
    value.cells[0].buckets.reserveRatio = [1, 0];
  },
]) {
  const invalid = structuredClone(declaration);
  change(invalid);
  assert.throws(() => resolveCohorts(invalid, ["a", "b"]));
}
const differences = [
  { baselineWin: false, learnedWin: true },
  { baselineWin: false, learnedWin: true },
  { baselineWin: true, learnedWin: false },
  { baselineWin: true, learnedWin: true },
];
const uncertainty = pairedUncertainty(differences);
assert.equal(uncertainty.meanDifference, 0.25);
assert.equal(uncertainty.signTestP, 1);
assert.equal(uncertainty.confidenceInterval, null);
assert.equal(pairedUncertainty([]).meanDifference, null);
assert.equal(pairedUncertainty([{ baselineWin: true, learnedWin: true }]).signTestP, 1);
assert.equal(
  pairedUncertainty(Array(4).fill({ baselineWin: false, learnedWin: true })).signTestP,
  0.125,
);
const bootstrap = { method: "bootstrap", confidence: 0.9, resamples: 100, seed: "declared-test" };
assert.deepEqual(
  pairedUncertainty(differences, bootstrap),
  pairedUncertainty(differences, bootstrap),
);
assert.throws(() => pairedUncertainty(differences, { method: "bootstrap" }), /uncertainty/);

const decisionRows = [
  {
    eligible: true,
    controlledAction: "wait",
    reserveRatio: 0.2,
    candidateCount: 1,
    utilityMargin: -0.1,
  },
  { eligible: true, controlledAction: null, fallback: true, reserveRatio: 0.2, candidateCount: 1 },
  { eligible: false, controlledAction: null, reserveRatio: null, candidateCount: 0 },
  { eligible: null, controlledAction: null, reserveRatio: null, candidateCount: 0 },
].map((row, step) => ({
  ...row,
  runIdentity: "fixture-run",
  episodeId: 0,
  generation: 0,
  step,
  tick: step,
}));
const wait = summarizeDecisionRows(decisionRows, declaration.cells[0].buckets);
assert.equal(wait.eligible, 2);
assert.equal(wait.controlledWaits, 1);
assert.equal(wait.frequency, 0.5, "eligible failed sends remain in the denominator");
assert.equal(wait.unknown, 1);
assert.equal(wait.buckets[0].frequency, 0.5);
assert.equal(Object.hasOwn(wait, "entropy"), false);
assert.equal(summarizeDecisionRows(undefined).frequency, null);
const repeated = summarizeDecisionRows([...decisionRows, structuredClone(decisionRows[0])]);
assert.equal(repeated.frequency, 0.5, "identical duplicate WAIT must not bias actual frequency");
assert.equal(repeated.duplicatesExcluded, 1);
assert.equal(repeated.inputRows, 5);
assert.throws(
  () => summarizeDecisionRows([decisionRows[0], { ...decisionRows[0], tick: 99 }]),
  /Conflicting decision/,
);
assert.throws(
  () => summarizeDecisionRows([decisionRows[0], { ...decisionRows[0], controlledAction: null }]),
  /Conflicting decision/,
);
assert.throws(
  () => summarizeDecisionRows([{ ...decisionRows[0], runIdentity: undefined }]),
  /decision identity/,
);
assert.throws(() => summarizeDecisionRows([{ ...decisionRows[0], step: -1 }]), /decision identity/);
assert.equal(
  summarizeDecisionRows([decisionRows[0], { ...decisionRows[0], generation: 1 }]).eligible,
  2,
  "historical generations stay separate",
);

const telemetry = summarizeTelemetry(
  {
    hybridCombat: {
      diagnostics: {
        control: {
          candidateDecisions: 1,
          controlledWaits: 1,
          acceptedLearnedAttacks: 0,
          confirmedLearnedAttacks: 0,
          fallbacks: 5,
        },
      },
    },
    hybridEvaluation: {
      decisionRows,
      latencyMs: [2, 4],
      latencyScope: "hybrid-decision-wall-ms",
      safetyScope: "learned-attack-gate",
      safety: { reserveChecks: 0, reserveViolations: 0, legalityChecks: 0, illegalEmissions: 0 },
      coverage: { knownAttempts: 0, unknownAttempts: 1, emissionsWithoutChecks: 0 },
    },
    intentBudget: { accepted: 1, rejected: 0 },
  },
  declaration.cells[0],
);
assert.equal(telemetry.latency.medianMs, 3);
assert.equal(telemetry.safety.reserveChecks, 0);
assert.equal(summarizeTelemetry({}).safety, null);
assert.throws(
  () =>
    summarizeTelemetry({
      hybridCombat: {
        diagnostics: {
          control: {
            candidateDecisions: 0,
            controlledWaits: 9,
            acceptedLearnedAttacks: 0,
            confirmedLearnedAttacks: 0,
            fallbacks: 0,
          },
        },
      },
    }),
  /Impossible control/,
);

const transition = {
  episodeId: "episode",
  step: 0,
  tick: 10,
  nextTick: 20,
  first: true,
  terminated: false,
  truncated: true,
  envError: false,
  potential: 0.2,
  nextPotential: 0.3,
  baseReward: 0,
};
const reward = transitionDiagnostic(transition, { gammaTick: 0.9, coefficient: 1 });
assert.ok(Math.abs(reward.reward - -0.09539646797) < 1e-12);
assert.ok(Math.abs(reward.bootstrapDiscount - 0.3486784401) < 1e-12);
assert.equal(
  transitionDiagnostic(
    { ...transition, truncated: false, terminated: true },
    { gammaTick: 0.9, coefficient: 1 },
  ).reward,
  -0.2,
);
assert.equal(
  transitionDiagnostic(
    { ...transition, truncated: false, envError: true },
    { gammaTick: 0.9, coefficient: 1 },
  ).usable,
  false,
);
validateTransitions([transition]);
const cancelledObservation = {
  action: "wait",
  reward: null,
  cancelled: true,
  truncated: true,
  reason: "competing-attack-emission",
  terminal: false,
  envError: false,
};
assert.equal(outcomeTransitionFlags(cancelledObservation).observationTruncated, true);
for (const patch of [
  { action: "attack" },
  { reward: 0 },
  { cancelled: false },
  { reason: "reset" },
  { reason: "max_ticks" },
  { reason: "unknown" },
]) {
  const flags = outcomeTransitionFlags({ ...cancelledObservation, ...patch });
  assert.equal(flags.truncated, true, "unknown/episode truncation must remain closed");
  assert.equal(flags.observationTruncated, undefined);
}
assert.equal(outcomeTransitionFlags({ ...cancelledObservation, terminal: true }).terminated, true);
assert.equal(outcomeTransitionFlags({ ...cancelledObservation, envError: true }).envError, true);
assert.throws(() => validateTransitions([{ ...transition, terminated: true }]), /flags/);
assert.throws(
  () => validateTransitions([transition, { ...transition, first: false, step: 1 }]),
  /closed/,
);

const queue = new FifoTransport();
assert.equal(queue.schedule({ seat: "a", tick: 10, delayTicks: 2, intents: [] }), null);
queue.schedule({ seat: "a", tick: 10, delayTicks: 2, intents: ["first"] });
queue.schedule({ seat: "a", tick: 11, delayTicks: 0, intents: ["second"] });
assert.deepEqual(
  queue.take(15).flatMap((batch) => batch.intents),
  ["first", "second"],
);
queue.clear();
assert.deepEqual(queue.take(20), []);
queue.schedule({ seat: "a", tick: 1, delayTicks: 0, intents: ["lower"] });
queue.schedule({ seat: "Z", tick: 1, delayTicks: 0, intents: ["upper"] });
assert.deepEqual(
  queue.take(1).flatMap((batch) => batch.intents),
  ["upper", "lower"],
  "cross-seat ties use locale-independent code unit order",
);

const manifest = {
  runID: "run-a",
  seed: "a",
  engineRevision: "a".repeat(40),
  experimentID: "exp",
  learning: false,
  mode: "shadow",
  sourceHash: "source",
  harnessHash: "harness",
  bundleHash: "bundle",
  configurationHash: "config",
  featureHash: "features",
  normalizerHash: "normalizer",
  modelHash: "model",
};
const originalIdentity = JSON.stringify({ normalizer: { frozen: true }, models: {} });
const event = { episodeId: 1, generation: 1, modelIdentity: originalIdentity };
const dataset = {
  version: "ofh-hybrid-ledger-v1",
  manifests: [manifest, { ...manifest, runID: "run-b", seed: "b" }],
  records: [
    { manifest, event },
    { manifest: { ...manifest, runID: "run-b", seed: "b" }, event },
  ],
};
const selection = { manifest, episodeId: 1, generation: 1, modelIdentity: originalIdentity };
const selected = selectReplayGroup(dataset, selection);
assert.equal(selected.records.length, 1);
assert.equal(selected.excluded.length, 1);
assert.equal(selected.records[0].modelIdentity, originalIdentity);
assert.throws(
  () => selectReplayGroup(dataset, { ...selection, manifest: { runID: "run-a" } }),
  /manifest/,
);
assert.throws(() =>
  selectReplayGroup(dataset, { ...selection, manifest: { ...manifest, learning: true } }),
);

const requirements = {
  version: 1,
  cells: ["alps"],
  minimumPairsPerCell: 1,
  minimumWinDifference: 0,
  maximumSignTestP: 1,
  noCellRegression: true,
  minimumControlledDecisions: 1,
  minimumReserveChecks: 1,
  minimumLegalityChecks: 1,
  maximumReserveViolations: 0,
  maximumIllegalEmissions: 0,
  maximumLatencyMs: 5,
  minimumLatencySamples: 1,
  maximumBudgetRejections: 0,
  safetyScope: "learned-attack-gate",
  requireKnownSafetyCoverage: true,
};
const assessmentReport = {
  coverage: {
    declared: true,
    cells: [
      {
        name: "alps",
        requested: 1,
        completed: 1,
        uncertainty: pairedUncertainty([{ baselineWin: false, learnedWin: true }]),
        telemetry: [
          {
            ...telemetry,
            safety: {
              reserveChecks: 1,
              reserveViolations: 0,
              legalityChecks: 1,
              illegalEmissions: 0,
            },
            coverage: { knownAttempts: 1, unknownAttempts: 0, emissionsWithoutChecks: 0 },
          },
        ],
      },
    ],
  },
  frozenVerified: true,
  uncertainty: pairedUncertainty([{ baselineWin: false, learnedWin: true }]),
};
assert.equal(
  assessCandidatePromotion(assessmentReport, requirements).eligible,
  false,
  "An argument hash cannot prove preregistration before launch",
);
assert.equal(
  assessCandidatePromotion(assessmentReport, requirements).registration,
  "posthoc-unverified",
);
assessmentReport.requirementsHash = digest(canonical(requirements));
assessmentReport.requirementsFrozenBeforeLaunch = true;
assert.equal(assessCandidatePromotion(assessmentReport, requirements).eligible, true);
for (const [section, field, value] of [
  ["control", "candidateDecisions", Infinity],
  ["control", "controlledWaits", 9],
  ["control", "confirmedLearnedAttacks", 1],
  ["control", "fallbacks", -1],
  ["safety", "reserveChecks", Infinity],
  ["safety", "reserveViolations", 2],
  ["safety", "illegalEmissions", 2],
  ["latency", "samples", -1],
  ["latency", "samples", Number.MAX_SAFE_INTEGER + 1],
  ["latency", "maxMs", -1],
  ["budget", "rejected", -1],
  ["budget", "accepted", Infinity],
  ["coverage", "knownAttempts", -1],
]) {
  const malformed = structuredClone(assessmentReport);
  malformed.coverage.cells[0].telemetry[0][section][field] = value;
  assert.equal(
    assessCandidatePromotion(malformed, requirements).eligible,
    false,
    `${section}.${field} invalid evidence cannot promote`,
  );
}

assert.equal(
  assessCandidatePromotion({ ...assessmentReport, requirementsHash: "changed" }, requirements)
    .eligible,
  false,
);
const unmeasured = structuredClone(assessmentReport);
unmeasured.coverage.cells[0].telemetry[0].safety = null;
assert.equal(assessCandidatePromotion(unmeasured, requirements).eligible, false);
assert.equal(
  summarizeTelemetry({
    hybridEvaluation: {
      safety: {
        reserveChecks: null,
        reserveViolations: null,
        legalityChecks: null,
        illegalEmissions: null,
      },
    },
  }).safety,
  null,
);
assert.equal(
  assessCandidatePromotion({ ...assessmentReport, frozenVerified: false }, requirements).eligible,
  false,
);
assert.throws(() => assessCandidatePromotion(assessmentReport, {}), /requirements/);
const untouched = JSON.stringify(assessmentReport);
assessCandidatePromotion(assessmentReport, requirements);
assert.equal(JSON.stringify(assessmentReport), untouched);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-contract-imports-"));
fs.writeFileSync(path.join(temporary, "entry.mjs"), "import './helper.mjs?worker&inline';\n");
fs.writeFileSync(path.join(temporary, "helper.mjs"), "export const value = 1;\n");
const before = fingerprintSources(temporary, ["entry.mjs"]);
const relocated = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-relocated-imports-"));
fs.cpSync(temporary, relocated, { recursive: true });
assert.equal(
  fingerprintSources(relocated, ["entry.mjs"]).hash,
  before.hash,
  "Identical source bytes and relative import identities survive relocation",
);
fs.rmSync(relocated, { recursive: true });
assert.ok(
  before.imports.some(
    (entry) => entry.specifier === "./helper.mjs?worker&inline" && entry.resolved === "helper.mjs",
  ),
);
fs.writeFileSync(path.join(temporary, "dynamic.mjs"), "import(globalThis.moduleName);\n");
assert.throws(() => fingerprintSources(temporary, ["dynamic.mjs"]), /Nonliteral/);
fs.writeFileSync(path.join(temporary, "query.mjs"), "import './helper.mjs?unknown-loader';\n");
assert.throws(
  () => fingerprintSources(temporary, ["query.mjs"]),
  /Unsupported harness import query/,
);
fs.writeFileSync(path.join(temporary, "helper.mjs"), "export const value = 2;\n");
assert.notEqual(
  fingerprintSources(temporary, ["entry.mjs"]).hash,
  before.hash,
  "source-import drift must change the harness fingerprint",
);

const scopeFixture = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-source-scope-"));
const sourceRoot = path.join(scopeFixture, "root");
fs.mkdirSync(sourceRoot);
fs.writeFileSync(path.join(scopeFixture, "outside.mjs"), "export const outside = 1;\n");
fs.writeFileSync(path.join(sourceRoot, "entry.mjs"), "import '../outside.mjs';\n");
assert.throws(() => fingerprintSources(sourceRoot, ["entry.mjs"]), /source scope/);
assert.throws(() => fingerprintSources(sourceRoot, ["../outside.mjs"]), /source scope/);
fs.symlinkSync(path.join(scopeFixture, "outside.mjs"), path.join(sourceRoot, "linked.mjs"));
fs.writeFileSync(path.join(sourceRoot, "entry.mjs"), "import './linked.mjs';\n");
assert.throws(() => fingerprintSources(sourceRoot, ["entry.mjs"]), /source scope/);
fs.mkdirSync(path.join(sourceRoot, "nested"));
fs.writeFileSync(path.join(sourceRoot, "helper.mjs"), "export const inside = 1;\n");
fs.writeFileSync(path.join(sourceRoot, "nested", "entry.mjs"), "import '../helper.mjs';\n");
assert.ok(fingerprintSources(sourceRoot, ["nested/entry.mjs"]).sources["helper.mjs"]);
fs.symlinkSync(path.join(sourceRoot, "helper.mjs"), path.join(sourceRoot, "internal-link.mjs"));
const inScope = fingerprintSources(sourceRoot, ["internal-link.mjs"]);
assert.equal(inScope.sourceScope.realRoot, fs.realpathSync(sourceRoot));
assert.ok(inScope.sources["helper.mjs"], "in-scope links expose actual file identity");
fs.rmSync(scopeFixture, { recursive: true });
fs.rmSync(temporary, { recursive: true });
process.stdout.write(
  "hybrid evaluation contract tests passed (bounded contracts, no strength claim)\n",
);
