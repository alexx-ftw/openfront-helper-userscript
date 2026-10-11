import assert from "node:assert/strict";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";
import { transform } from "esbuild";

const sourcePath = repositoryFilePath("src/shell/audio.ts");
const source = readRepositoryFile("src/shell/audio.ts");
const transformed = await transform(source, { format: "cjs", loader: "ts", target: "es2022" });
const listeners = new Map();
const decodedByteLengths = [];
const startedClips = [];
class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};

  async resume() {
    this.state = "running";
  }

  async decodeAudioData(bytes) {
    decodedByteLengths.push(bytes.byteLength);
    return {};
  }

  createBufferSource() {
    return {
      connect: () => ({ connect: () => this.destination }),
      start: () => startedClips.push(true),
    };
  }

  createGain() {
    return { gain: { value: 0 }, connect: () => this.destination };
  }
}
const window = {
  addEventListener: (name, listener) => listeners.set(name, listener),
};
const module = { exports: {} };
executeClassicScript(
  transformed.code,
  {
    AudioContext: FakeAudioContext,
    Uint8Array,
    atob,
    console,
    module,
    window,
  },
  { filename: sourcePath },
);
const { installAudio, speakSpawnPrompt } = module.exports;

installAudio();
speakSpawnPrompt("PICK SPAWN");
assert.equal(startedClips.length, 0, "voice waits for a trusted gesture after automatic join");
listeners.get("pointerdown")();
await new Promise((resolve) => {
  setTimeout(resolve, 0);
});
assert.equal(startedClips.length, 1, "the queued spawn prompt plays on the next trusted gesture");
assert.ok(decodedByteLengths[0] > 1_000, "the bundled female-voice clip has real audio data");

speakSpawnPrompt("SPAWN, SPAWN");
await new Promise((resolve) => {
  setTimeout(resolve, 0);
});
assert.equal(startedClips.length, 2, "subsequent voice prompt plays immediately after activation");

process.stdout.write("spawn speech tests passed\n");
