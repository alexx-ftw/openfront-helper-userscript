import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function git(...args) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- repository tooling uses installed Git
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
const initialHead = git("rev-parse", "HEAD").trim();
const baselineCommit = git("rev-parse", process.argv[2] ?? "HEAD").trim();
const sourceGroups = [
  { path: "engine/ingame/runtime.js", files: ["runtime.js"] },
  { path: "engine/ingame/map-overlay-scheduler.js", files: ["map-overlay-scheduler.js"] },
  { path: "engine/ingame/estate-panel.js", files: ["estate/constants.js", "estate/styles.js", "estate/panel.js", "estate/compute.js", "estate/lifecycle.js"] },
  { path: "engine/ingame/heatmaps.js", files: ["heatmaps/state.js", "heatmaps/dom.js", "heatmaps/trade-sources.js", "heatmaps/projection.js", "heatmaps/webgl.js", "heatmaps/canvas.js", "heatmaps/draw.js", "heatmaps/export-partner.js", "heatmaps/lifecycle.js"] },
];
const sources = sourceGroups.map(({ path, files }) => ({
  path,
  files,
  baseline: git("show", `${baselineCommit}:${path}`),
  candidate: files.map((name) => readRepositoryFile(`engine/ingame/${name}`)).join("\n"),
}));
const hash = (source) => createHash("sha256").update(source).digest("hex");
function load(variant) {
  const sandbox = {
    window: { innerWidth: 1280, innerHeight: 720, localStorage: { getItem: () => null } },
    document: { addEventListener: () => {} },
  };
  executeClassicScript(sources.map((source) => source[variant]).join("\n"), sandbox);
  return sandbox;
}
const engines = { baseline: load("baseline"), candidate: load("candidate") };
const plain = (value) => JSON.parse(JSON.stringify(value));
function estateFixture(width, instrument = false) {
  const counters = { neighborArrays: 0, neighbors4Calls: 0 };
  const buffers = new Set();
  const fill = (ref, out) => {
    let n = 0;
    const x = ref % width;
    if (ref >= width) out[n++] = ref - width;
    if (ref < (width - 1) * width) out[n++] = ref + width;
    if (x !== 0) out[n++] = ref - 1;
    if (x !== width - 1) out[n++] = ref + 1;
    return n;
  };
  const game = {
    x: (ref) => ref % width,
    y: (ref) => Math.floor(ref / width),
    ownerID: () => 1,
    neighbors: (ref) => {
      const out = [];
      fill(ref, out);
      return out;
    },
    neighbors4: fill,
  };
  if (instrument) {
    const original = { ...game };
    game.neighbors = (ref) => {
      counters.neighborArrays++;
      return original.neighbors(ref);
    };
    game.neighbors4 = (ref, out) => {
      counters.neighbors4Calls++;
      buffers.add(out);
      return fill(ref, out);
    };
  }
  const seeds = Array.from({ length: width }, (_, x) => x);
  return {
    args: [game, seeds, 1],
    expected: [{ key: "0", tiles: width * width, cx: (width - 1) / 2, cy: (width - 1) / 2 }],
    counts: () => ({ ...counters, distinctScratchBuffers: buffers.size }),
  };
}

function heatmapFixture(count, instrument = false) {
  const inputs = new Set();
  const counters = { projections: 0 };
  const sources = Array.from({ length: count }, (_, i) => ({
    tile: i % 17 === 0 ? null : i,
    weight: i + 1,
    type: "Factory",
  }));
  const game = { x: (ref) => (ref % 1600) - 160, y: (ref) => Math.floor(ref / 400) * 200 - 160 };
  const transform = {
    scale: 1.8,
    worldToScreenCoordinates: (p) => ({ x: p.x, y: p.x === 13 ? NaN : p.y }),
  };
  if (instrument) {
    const project = transform.worldToScreenCoordinates;
    transform.worldToScreenCoordinates = (p) => {
      counters.projections++;
      inputs.add(p);
      return project(p);
    };
  }
  const expected = sources
    .filter((s) => s.tile !== null)
    .map((s) => ({
      x: (s.tile % 1600) - 160,
      y: Math.floor(s.tile / 400) * 200 - 160,
      weight: s.weight,
      type: s.type,
      zoomScale: 1,
    }))
    .filter((p) => p.x !== 13 && p.x > -120 && p.y > -120 && p.x < 1400 && p.y < 840);
  return {
    args: [sources, game, transform],
    expected,
    counts: () => ({ ...counters, distinctWorldInputs: inputs.size }),
  };
}

const fixtures = [64, 128].map((width) => ({
  name: `estate-${width}`,
  fn: "computeEstateComponents",
  make: (tracked) => estateFixture(width, tracked),
}));
for (const count of [1000, 10000])
  fixtures.push({
    name: `heatmap-${count}`,
    fn: "projectEconomyHeatmapPoints",
    make: (tracked) => heatmapFixture(count, tracked),
  });
const warmups = 10;
const iterations = 10;
const pairs = 12;
function measure(fixture) {
  const counts = {};
  for (const variant of ["baseline", "candidate"]) {
    const tracked = fixture.make(true);
    assert.deepEqual(plain(engines[variant][fixture.fn](...tracked.args)), tracked.expected, `${fixture.name} ${variant}`);
    counts[variant] = tracked.counts();
  }
  // Separate fixtures remove all instrumentation wrappers from the timed calls.
  const args = { baseline: fixture.make(false).args, candidate: fixture.make(false).args };
  const run = (variant) => engines[variant][fixture.fn](...args[variant]);
  for (let i = 0; i < warmups; i++) {
    run("baseline");
    run("candidate");
  }
  const samples = [];
  for (let pair = 0; pair < pairs; pair++) {
    const order = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const sample = { order: order.join("/") };
    for (const variant of order) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) run(variant);
      sample[variant] = (performance.now() - start) / iterations;
    }
    samples.push(sample);
  }
  return { name: fixture.name, exactOutput: true, counts, samplesMsPerCall: samples };
}
const receipt = {
  at: new Date().toISOString(),
  baselineCommit,
  environment: {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    cpu: os.cpus()[0]?.model,
    load: os.loadavg(),
    freeMemory: os.freemem(),
  },
  protocol: {
    warmups,
    iterations,
    pairs,
    timing: "performance.now, balanced AB/BA, instrumentation disabled",
    scope: "synthetic source-level only; browser FPS not verified",
  },
  sources: sources.map(({ path, baseline, candidate }) => ({
    path,
    baselineSha256: hash(baseline),
    candidateSha256: hash(candidate),
    changed: baseline !== candidate,
  })),
  results: fixtures.map(measure),
};
for (const source of sources)
  assert.equal(
    hash(source.files.map((file) => readRepositoryFile(`engine/ingame/${file}`)).join("\n")),
    hash(source.candidate),
    `concurrent edit: ${source.path}`,
  );
assert.equal(
  git("rev-parse", "HEAD").trim(),
  initialHead,
  "HEAD changed; keep HEAD frozen for this run",
);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
