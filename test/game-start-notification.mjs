import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/runtime.js");

const sandbox = {
  console,
  document: { addEventListener() {} },
  window: {
    localStorage: {
      getItem() {
        return null;
      },
    },
    postMessage() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });

assert.equal(
  typeof sandbox.createGameStartNotificationDetector,
  "function",
  "runtime exposes the game-start detector",
);

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("notifies once when a game leaves spawn phase", () => {
  const detector = sandbox.createGameStartNotificationDetector();
  const game = {};

  assert.equal(detector.observe(game, true), false);
  assert.equal(detector.observe(game, false), true);
  assert.equal(detector.observe(game, false), false);
});

test("does not notify for a game first observed after spawn", () => {
  const detector = sandbox.createGameStartNotificationDetector();

  assert.equal(detector.observe({}, false), false);
});

test("resets between game instances", () => {
  const detector = sandbox.createGameStartNotificationDetector();
  const firstGame = {};
  const secondGame = {};

  detector.observe(firstGame, true);
  assert.equal(detector.observe(firstGame, false), true);
  detector.observe(null, false);
  detector.observe(secondGame, true);
  assert.equal(detector.observe(secondGame, false), true);
});

console.log("game-start-notification tests passed");
