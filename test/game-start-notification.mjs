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

test("notifies once when a game enters spawn phase", () => {
  const detector = sandbox.createGameStartNotificationDetector();
  const game = {};

  assert.equal(detector.observe(game, null), false);
  assert.equal(detector.observe(game, true), true);
  assert.equal(detector.observe(game, true), false);
});

test("notifies when spawn phase changes from false to true", () => {
  const detector = sandbox.createGameStartNotificationDetector();
  const game = {};

  assert.equal(detector.observe(game, false), false);
  assert.equal(detector.observe(game, true), true);
});

test("resets between game instances", () => {
  const detector = sandbox.createGameStartNotificationDetector();
  const firstGame = {};
  const secondGame = {};

  assert.equal(detector.observe(firstGame, false), false);
  assert.equal(detector.observe(firstGame, true), true);
  assert.equal(detector.observe(secondGame, null), false);
  assert.equal(detector.observe(secondGame, true), true);
});

console.log("game-start-notification tests passed");
