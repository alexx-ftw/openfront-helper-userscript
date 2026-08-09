import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userscript = fs.readFileSync(path.join(root, "openfront-helper.user.js"), "utf8");
const lifecycleSource = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/lifecycle.js"),
  "utf8",
);
const autoBotEngineSource = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/engine.js"),
  "utf8",
);
assert.match(
  autoBotEngineSource,
  /!meCore\.isPlayer\?\.\(\) && srcGame\.inSpawnPhase\?\.\(\) !== true/,
  "the live auto-bot engine must enter NationBot's spawn handler before territory exists",
);
assert.match(
  autoBotEngineSource,
  /const seedKey = meCore\.clientID\?\.\(\) \?\? meCore\.smallID\?\.\(\) \?\? meCore\.id\?\.\(\)/,
  "the client identity keeps the bot lifetime stable while territory IDs materialize after spawn",
);
const sectionStart = userscript.lastIndexOf(";(function(){\n");
const sectionEnd = userscript.lastIndexOf("\n})();\n");
assert.ok(
  sectionStart >= 0 && sectionEnd > sectionStart,
  "built userscript contains in-game section",
);
const source = userscript.slice(sectionStart, sectionEnd + "\n})();".length);

const { document, window: domWindow } = parseHTML(
  "<!doctype html><html><head></head><body></body></html>",
);
const storage = new Map([
  [
    "openfront-helper-autobot-v1",
    JSON.stringify({
      enabled: true,
      difficulty: "Legendary",
      features: { expand: true, attack: true, boat: true },
    }),
  ],
]);
const localStorage = {
  getItem: (key) => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
};
const inertTimer = () => 1;
const sandbox = {
  ...domWindow,
  document,
  localStorage,
  location: { hostname: "openfront.io", pathname: "/" },
  navigator: { language: "en-US", userAgent: "static-test" },
  performance: { now: () => 1 },
  console: {
    ...console,
    error: (...args) => {
      throw args.find((value) => value instanceof Error) ?? new Error(args.join(" "));
    },
  },
  setInterval: inertTimer,
  clearInterval() {},
  setTimeout: inertTimer,
  clearTimeout() {},
  requestAnimationFrame: inertTimer,
  cancelAnimationFrame() {},
  addEventListener() {},
  removeEventListener() {},
  postMessage() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  XMLHttpRequest: class {
    addEventListener() {}
    open() {}
    send() {}
  },
  WebSocket: class {
    addEventListener() {}
    send() {}
  },
  AudioContext: class {},
  webkitAudioContext: class {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

assert.doesNotThrow(() =>
  executeClassicScript(source, sandbox, {
    filename: "static-full-ingame-section.js",
  }),
);
assert.equal(
  sandbox.__openfrontAutoBotLoaded,
  true,
  "the complete in-game section reaches and starts the auto-bot lifecycle",
);
assert.ok(
  document.getElementById("openfront-helper-auto-bot-panel"),
  "the complete in-game section mounts the auto-bot panel",
);
assert.equal(
  JSON.parse(storage.get("openfront-helper-autobot-v1")).enabled,
  true,
  "userscript bootstrap preserves the persisted Auto-Bot master toggle",
);
assert.doesNotMatch(
  lifecycleSource,
  /tick watchdog[\s\S]{0,240}setEnabled\(false\)/,
  "the slow-tick watchdog must not overwrite the persisted master toggle",
);

process.stdout.write("full in-game section bootstrap tests passed\n");
