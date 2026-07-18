import assert from "node:assert/strict";
import { transform } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/shell/audio.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const transformed = await transform(source, { format: "cjs", loader: "ts", target: "es2022" });
const listeners = new Map();
const spoken = [];
let resumed = 0;
class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.onerror = null;
  }
}
const speech = {
  getVoices: () => [{ name: "Samantha", lang: "en-US" }],
  resume: () => {
    resumed++;
  },
  speak: (utterance) => spoken.push(utterance),
};
const window = {
  addEventListener: (name, listener) => listeners.set(name, listener),
  SpeechSynthesisUtterance: FakeUtterance,
  speechSynthesis: speech,
};
const module = { exports: {} };
executeClassicScript(
  transformed.code,
  {
    AudioContext: class {},
    Uint8Array,
    atob: () => "",
    console,
    module,
    window,
  },
  { filename: sourcePath },
);
const { installAudio, speakSpawnPrompt } = module.exports;

installAudio();
speakSpawnPrompt("PICK SPAWN");
assert.equal(spoken.length, 0, "speech waits for a trusted gesture after automatic join");
listeners.get("pointerdown")();
assert.equal(spoken.length, 1, "the queued spawn prompt speaks on the next trusted gesture");
assert.equal(spoken[0].text, "PICK SPAWN");
assert.equal(spoken[0].voice.name, "Samantha", "a female voice is preferred when present");
assert.ok(resumed >= 2, "gesture activation and prompt emission both resume speech");

speakSpawnPrompt("SPAWN, SPAWN");
assert.equal(spoken.length, 2, "subsequent prompt speaks immediately after activation");
assert.equal(spoken[1].text, "SPAWN, SPAWN");

process.stdout.write("spawn speech tests passed\n");
