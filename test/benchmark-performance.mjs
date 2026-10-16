import { execFileSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineRef = process.argv[2] || "HEAD";
const scheduler = readRepositoryFile("engine/ingame/map-overlay-scheduler.js");

function loadSource(file, baseline) {
  return baseline
    ? execFileSync("/usr/bin/git", ["show", `${baselineRef}:${file}`], {
        cwd: root,
        encoding: "utf8",
      })
    : readRepositoryFile(file);
}

function medianTime(run) {
  for (let iteration = 0; iteration < 5; iteration += 1) run();
  const times = [];
  for (let iteration = 0; iteration < 15; iteration += 1) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return Number(times.sort((a, b) => a - b)[7].toFixed(3));
}

function benchmarkTrade(baseline) {
  const sandbox = {};
  executeClassicScript(loadSource("engine/ingame/trade-balances.js", baseline), sandbox);
  let tick = 0;
  const units = Array.from({ length: 1000 }, (_, tile) => ({
    type: () => "City",
    tile: () => tile,
    hasTrainStation: () => true,
  }));
  const game = { ticks: () => tick, units: () => units };
  return medianTime(() => {
    tick += 1;
    for (let tile = 0; tile < 1000; tile += 1) sandbox.findTrainStationAtTile(game, tile);
  });
}

function benchmarkHeatmap(baseline) {
  const sandbox = {
    window: { innerWidth: 1280, innerHeight: 720 },
    ECONOMY_HEATMAP_VIEWPORT_PADDING: 120,
    HEATMAP_REFERENCE_ZOOM: 1.8,
  };
  executeClassicScript(
    `${scheduler}\n${loadSource("engine/ingame/heatmaps.js", baseline)}`,
    sandbox,
  );
  const game = { x: (tile) => tile % 256, y: (tile) => Math.floor(tile / 256) };
  const transform = {
    scale: 1.8,
    worldToCanvasCoordinates(point) {
      return {
        x: (point.x - 128 - 10) * this.scale + 128,
        y: (point.y - 128 - 20) * this.scale + 128,
      };
    },
    canvasToScreenCoordinates: (x, y) => ({ x: x + 10, y: y + 20 }),
    worldToScreenCoordinates(point) {
      const canvas = this.worldToCanvasCoordinates(point);
      return this.canvasToScreenCoordinates(canvas.x, canvas.y);
    },
  };
  const sources = Array.from({ length: 2048 }, (_, tile) => ({ tile, weight: 1, type: "City" }));
  return medianTime(() => {
    for (let frame = 0; frame < 100; frame += 1) {
      sandbox.projectEconomyHeatmapPoints(sources, game, transform);
    }
  });
}

function benchmarkTradeEvents(baseline) {
  const sandbox = {};
  const runBatch = baseline
    ? "for (const event of events) processTradeBalanceEvent(event, players, []);"
    : "processTradeBalanceEvents({ events }, players, []);";
  executeClassicScript(
    `${loadSource("engine/ingame/shared-utils.js", baseline)}
    ${loadSource("engine/ingame/trade-balances.js", baseline)}
    globalThis.runEventBatch = (events, players) => { ${runBatch} };`,
    sandbox,
  );
  sandbox.addTradeBalance = () => {};
  const players = Array.from({ length: 100 }, (_, id) => ({
    smallID: () => id,
    displayName: () => `Display ${id}`,
    name: () => `Internal ${id}`,
  }));
  const events = Array.from({ length: 1000 }, (_, index) => ({
    message: "events_display.received_gold_from_trade",
    playerID: 7,
    goldAmount: 10,
    params: { name: `Display ${index % 100}` },
  }));
  return medianTime(() => sandbox.runEventBatch(events, players));
}

process.stdout.write("Synthetic Node fixtures; these timings do not measure browser FPS.\n");
for (const baseline of [true, false]) {
  process.stdout.write(
    `${JSON.stringify({
      version: baseline ? baselineRef : "working tree",
      medianOf: 15,
      trade1000QueriesMs: benchmarkTrade(baseline),
      heatmap100Frames2048SourcesMs: benchmarkHeatmap(baseline),
      trade1000Events100PlayersMs: benchmarkTradeEvents(baseline),
    })}\n`,
  );
}
