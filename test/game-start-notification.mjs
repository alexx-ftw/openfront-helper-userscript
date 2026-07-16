import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/runtime.js");
const SHELL_SOURCE = path.join(ROOT, "src/shell/index.ts");
const AUDIO_SOURCE = path.join(ROOT, "src/shell/audio.ts");
const LOBBY_SOURCE = path.join(ROOT, "engine/lobby/auto-join.js");

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
executeClassicScript(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });

assert.equal(
  typeof sandbox.createGameStartNotificationDetector,
  "function",
  "runtime exposes the game-start detector",
);

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
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

test("rings the chime when the game-start notification reaches the shell", () => {
  const source = fs.readFileSync(SHELL_SOURCE, "utf8");
  const handler = source.match(
    /else if \(msg\?\.type === "SHOW_GAME_START_NOTIFICATION"\) \{([\s\S]*?)\n {4}\}/,
  );

  assert.ok(handler, "shell handles the game-start notification");
  assert.match(handler[1], /ringChime\(\)/, "game-start handler rings the chime");
  assert.match(handler[1], /showGameStartNotification\(/, "game-start handler keeps the toast");
});

test("primes audio on a gesture and waits for resume before ringing", () => {
  const source = fs.readFileSync(AUDIO_SOURCE, "utf8");

  assert.match(
    source,
    /const resume = \(\) => \{\s*const context = getCtx\(\);/,
    "a trusted gesture creates the audio context while playback is allowed",
  );
  assert.match(
    source,
    /export async function ringChime\(\): Promise<void> \{[\s\S]*?await context\.resume\(\);[\s\S]*?if \(context\.state !== "running"\) return;[\s\S]*?playChime\(1\);/,
    "the game-start cue waits for the audio context to resume",
  );
});

test("accepts a lobby-to-spawn transition without an auto-join pending record", () => {
  const source = fs.readFileSync(LOBBY_SOURCE, "utf8");

  assert.match(
    source,
    /if \(inLobbyWaiting\) \{\s*lobbyState\.sawLobbyWaitingBeforeGameStart = true;/,
    "waiting lobby state is remembered",
  );
  assert.match(
    source,
    /if \(\(!pending && !startedFromLobby\) \|\| !lobbyState\.settings\.joinNotification\)/,
    "manual lobby entry can trigger the game-start notification",
  );
});

process.stdout.write("game-start-notification tests passed\n");
