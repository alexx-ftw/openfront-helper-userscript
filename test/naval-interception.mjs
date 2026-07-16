import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/naval-interception.js"),
  "utf8",
);
const gameApiSource = fs.readFileSync(path.join(root, "engine/ingame/auto-bot/gameApi.js"), "utf8");
const warshipSource = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/warshipBehavior.js"),
  "utf8",
);
assert.match(
  gameApiSource,
  /forEachNeighbor:\s*\(tile, callback\).*src\.neighbors\(tile\)/s,
  "the client-shaped game API must expose the core neighbor callback used by warships",
);
assert.match(
  gameApiSource,
  /isFriendly:\s*\(other\)\s*=>\s*wrapPlayer\(u\.owner\(\)\)\?\.isFriendly\(other\)/,
  "wrapped units must expose owner-relative friendliness for warship targeting",
);
assert.match(
  warshipSource,
  /buildUncoveredInterceptor\(plan, invasions, smartState, timing\)[\s\S]*state\.settings\.warshipAutoSpawn/,
  "naval interceptor state must not shadow the global settings state",
);
const sandbox = {};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${source}\nglobalThis.planNavalInterceptions = planNavalInterceptions;`,
  sandbox,
  {
    filename: "naval-interception.js",
  },
);

const planNavalInterceptions = sandbox.planNavalInterceptions;
assert.equal(typeof planNavalInterceptions, "function");

const tile = (x, y) => `${x},${y}`;
const coords = (value) => value.split(",").map(Number);
const distance = (a, b) => {
  const [ax, ay] = coords(a);
  const [bx, by] = coords(b);
  return Math.hypot(ax - bx, ay - by);
};

function route(from, to) {
  const [fx, fy] = coords(from);
  const [tx, ty] = coords(to);
  const result = [from];
  let x = fx;
  let y = fy;
  while (x !== tx) {
    x += Math.sign(tx - x);
    result.push(tile(x, y));
  }
  while (y !== ty) {
    y += Math.sign(ty - y);
    result.push(tile(x, y));
  }
  return result;
}

const speedSensitive = planNavalInterceptions({
  ships: [{ id: "destroyer-1", tile: tile(0, 0) }],
  invasions: [
    {
      id: "invasion-1",
      path: [tile(4, 0), tile(5, 0), tile(6, 0), tile(7, 0)],
    },
  ],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 2,
  attackRange: 2,
});
assert.equal(speedSensitive.assignments[0].interceptTick, 2);
assert.equal(speedSensitive.assignments[0].marginTicks, 1);

const oneShipTwoInvasions = planNavalInterceptions({
  ships: [{ id: "destroyer-1", tile: tile(0, 0) }],
  invasions: [
    {
      id: "invasion-a",
      path: [tile(1, 0), tile(2, 0), tile(3, 0), tile(4, 0), tile(5, 0), tile(6, 0), tile(7, 0)],
    },
    {
      id: "invasion-b",
      path: [tile(7, 0), tile(6, 0), tile(5, 0), tile(4, 0), tile(3, 0), tile(2, 0), tile(1, 0)],
    },
  ],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 1,
});
assert.equal(oneShipTwoInvasions.coveredIds.length, 2);
assert.equal(oneShipTwoInvasions.assignments.length, 2);

const oneShipLimit = planNavalInterceptions({
  ships: [{ id: "destroyer-1", tile: tile(0, 0) }],
  invasions: [
    { id: "left", path: [tile(1, 0), tile(2, 0), tile(3, 0), tile(4, 0)] },
    { id: "right", path: [tile(7, 0), tile(6, 0), tile(5, 0), tile(4, 0)] },
  ],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 1,
});
assert.equal(oneShipLimit.coveredIds.length, 1);
assert.equal(oneShipLimit.uncoveredIds.length, 1);

const twoShips = planNavalInterceptions({
  ships: [
    { id: "destroyer-left", tile: tile(0, 0) },
    { id: "destroyer-right", tile: tile(8, 0) },
  ],
  invasions: [
    { id: "left", path: [tile(1, 0), tile(2, 0), tile(3, 0), tile(4, 0)] },
    { id: "right", path: [tile(7, 0), tile(6, 0), tile(5, 0), tile(4, 0)] },
  ],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 1,
});
assert.deepEqual(twoShips.uncoveredIds, []);
assert.equal(twoShips.assignments.length, 2);

process.stdout.write("naval interception tests passed\n");
