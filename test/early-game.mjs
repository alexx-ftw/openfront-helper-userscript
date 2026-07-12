import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/earlyGame.js");
const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
const sandbox = {};
vm.runInNewContext(source, sandbox, { filename: sourcePath });
const attackSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js"),
  "utf8",
);
const gameApiSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/gameApi.js"),
  "utf8",
);
const buildSource = fs.readFileSync(path.join(repoRoot, "build.mjs"), "utf8");

assert.equal(typeof sandbox.createEarlyGameSnapshot, "function");
assert.equal(typeof sandbox.chooseEarlyGameAction, "function");
assert.equal(typeof sandbox.isEarlyGameBoatEta, "function");
assert.equal(typeof sandbox.findWaterRouteTicks, "function");
assert.equal(typeof sandbox.transportRouteTicks, "function");
assert.equal(sandbox.isEarlyGameBoatEta(300), true);
assert.equal(sandbox.isEarlyGameBoatEta(301), false);
assert.equal(sandbox.isEarlyGameBoatEta(null), false);

const snapshot = sandbox.createEarlyGameSnapshot({
  postSpawn: true,
  hasFreeLand: true,
  tribes: [
    { id: "border-tribe", alive: true, friendly: false, landBorder: true },
    { id: "near-tribe", alive: true, friendly: false, boatEtaTicks: 300 },
    { id: "late-tribe", alive: true, friendly: false, boatEtaTicks: 301 },
    { id: "unknown-tribe", alive: true, friendly: false, boatEtaTicks: null },
    { id: "friendly-tribe", alive: true, friendly: true, boatEtaTicks: 0 },
    { id: "dead-tribe", alive: false, friendly: false, boatEtaTicks: 0 },
  ],
});

assert.equal(snapshot.active, true);
assert.equal(snapshot.hasFreeLand, true);
assert.equal(snapshot.hasTribeTarget, true);
assert.deepEqual(
  snapshot.actionableTribes.map((target) => target.id),
  ["border-tribe", "near-tribe"],
);

assert.equal(
  sandbox.createEarlyGameSnapshot({ postSpawn: false, hasFreeLand: true }).active,
  false,
);

assert.equal(
  sandbox.chooseEarlyGameAction({ landTarget: true, tribeTarget: true, boatTarget: true }),
  "land",
);
assert.equal(
  sandbox.chooseEarlyGameAction({ landTarget: false, tribeTarget: true, boatTarget: true }),
  "tribe",
);
assert.equal(
  sandbox.chooseEarlyGameAction({ landTarget: false, tribeTarget: false, boatTarget: true }),
  "boat",
);
assert.equal(
  sandbox.chooseEarlyGameAction({ landTarget: false, tribeTarget: false, boatTarget: false }),
  null,
);

assert.equal(sandbox.transportRouteTicks(["source", "water", "shore"]), 2);
assert.equal(sandbox.transportRouteTicks(["source"]), 0);
assert.equal(sandbox.transportRouteTicks({ fullPath: ["source", "shore"] }), 1);
assert.equal(sandbox.transportRouteTicks([]), null);
assert.equal(sandbox.transportRouteTicks(null), null);

const waterGraph = new Map([
  [0, [1]],
  [1, [0, 2]],
  [2, [1, 3]],
  [3, [2, 4]],
  [4, [3, 5]],
  [5, [4]],
]);
assert.equal(
  sandbox.findWaterRouteTicks({
    start: 0,
    goal: 5,
    neighbors: (tile) => waterGraph.get(tile) || [],
    isWater: (tile) => tile >= 1 && tile <= 4,
    maxTicks: 300,
  }),
  5,
);
assert.equal(
  sandbox.findWaterRouteTicks({
    start: 0,
    goal: 5,
    neighbors: (tile) => waterGraph.get(tile) || [],
    isWater: (tile) => tile >= 1 && tile <= 4,
    maxTicks: 4,
  }),
  null,
);

const routeSandbox = {};
const routeSrc = {
  neighbors: (tile) => waterGraph.get(tile) || [],
  isWater: (tile) => tile >= 1 && tile <= 4,
  isLand: (tile) => tile === 0 || tile === 5,
  isShore: (tile) => tile === 0 || tile === 5,
  ownerID: (tile) => (tile === 5 ? 2 : tile === 0 ? 1 : 0),
  manhattanDist: (a, b) => Math.abs(a - b),
};
vm.runInNewContext(`${gameApiSource}\n${source}`, routeSandbox, {
  filename: "gameApi+earlyGame.js",
});
const routeApi = routeSandbox.createGameApi(routeSrc);
const routePlayer = routeApi.wrapPlayer({
  isPlayer: () => true,
  smallID: () => 1,
  id: () => "p1",
  bestTransportShipSpawn: () => Promise.resolve(0),
});
assert.equal(await routePlayer.bestTransportShipSpawn(5), 0);
assert.equal(await routeApi.game.estimateTransportRouteTicks(5), 5);
assert.equal(routeApi.game.hasTransportRouteEstimator, true);

assert.match(attackSource, /state\.earlyGame\.action === "land"/);
assert.match(attackSource, /async allowEarlyGameBoat\(tile\)/);
assert.match(attackSource, /!state\.settings\.winFixes \|\| !early \|\| !early\.active/);
assert.match(attackSource, /EARLY_EXPAND_COMMIT/);
assert.match(gameApiSource, /estimateTransportRouteTicks/);
assert.match(gameApiSource, /hasTransportRouteEstimator/);
assert.match(gameApiSource, /findWaterRouteTicks\(\{/);
assert.match(buildSource, /"auto-bot\/earlyGame\.js"/);

console.log("early-game tests passed");
