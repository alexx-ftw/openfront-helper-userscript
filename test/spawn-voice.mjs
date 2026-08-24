import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/spawn-voice.js");
const listeners = [];
const prompts = [];
const sandbox = {
  window: { __OFH: { speakSpawnPrompt: (prompt) => prompts.push(prompt) } },
  registerHelperTickListener(listener) {
    listeners.push(listener);
  },
};
sandbox.globalThis = sandbox;
executeClassicScript(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });

assert.equal(typeof sandbox.createSpawnVoicePromptDetector, "function");
assert.equal(listeners.length, 1, "spawn voice registers one lightweight poller");

const detector = sandbox.createSpawnVoicePromptDetector();
const game = {
  ticks: () => 0,
  config: () => ({ numSpawnPhaseTurns: () => 300, msPerTick: () => 100 }),
};
assert.equal(detector.observe(game, false), null);
assert.equal(detector.observe(game, true), "PICK SPAWN");
assert.equal(detector.observe(game, true), null, "entry prompt fires once");
game.ticks = () => 249;
assert.equal(detector.observe(game, true), null, "five-second prompt waits for its threshold");
game.ticks = () => 250;
assert.equal(detector.observe(game, true), "SPAWN, SPAWN");
assert.equal(detector.observe(game, true), null, "five-second prompt fires once");
assert.equal(detector.observe(game, false), null);

const liveGame = {
  inSpawnPhase: () => true,
  ticks: () => 0,
  config: () => ({ numSpawnPhaseTurns: () => 300, msPerTick: () => 100 }),
};
sandbox.getOpenFrontGameContext = () => ({ game: liveGame });
listeners[0]();
assert.deepEqual(prompts, ["PICK SPAWN"], "poller delegates the entry prompt to the shell");

process.stdout.write("spawn voice tests passed\n");
