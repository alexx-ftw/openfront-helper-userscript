import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./classic-script.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

export const defaultAutoJoinSettings = {
  enabled: false,
  keepAutoJoinAfterMatch: false,
  joinNotification: false,
  language: "en",
  mapFilters: {},
  mapExcludeFilters: {},
  includeFilters: {},
  excludeFilters: {},
  minLobbySize: null,
  minTeamSize: null,
  maxTeamSize: null,
  minTeamCount: null,
  maxTeamCount: null,
};

export function createAutoJoinSandbox(
  driverSource,
  { filterKeys = [], startGoldFilterKeys = [] } = {},
) {
  // The userscript concatenates engine files into one sloppy-mode scope; mirror
  // that here so auto-join.js sees core.js's top-level bindings.
  const engineSource = [read("engine/lobby/core.js"), read("engine/lobby/auto-join.js")].join("\n");
  const sandbox = {
    console,
    // Declared in floating-autojoin.js, which this two-file concatenation omits.
    syncFloatingHelpersPanel() {},
    syncFloatingAutoJoinPanel() {},
    Audio: class {
      constructor(src) {
        this.src = src;
        this.preload = "";
      }
    },
    window: {
      addEventListener() {},
      postMessage() {},
      setInterval() {
        return 1;
      },
      clearInterval() {},
    },
    document: {
      addEventListener() {},
      querySelector() {
        return null;
      },
      getElementById() {
        return null;
      },
      body: { classList: { contains: () => false } },
    },
    chrome: {
      runtime: {
        id: "ofh-test",
        onMessage: { addListener() {} },
        sendMessage: async () => {},
        getURL: (relativePath) => relativePath,
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
        },
        onChanged: { addListener() {} },
      },
    },
    OpenFrontHelperSettings: {
      STORAGE_KEY: "ofh-test-settings",
      FILTER_KEYS: filterKeys,
      START_GOLD_FILTER_KEYS: startGoldFilterKeys,
      MAPS: [
        { id: "world", name: "World" },
        { id: "europe", name: "Europe" },
      ],
      MAP_IDS: ["world", "europe"],
      createDefaultMapFilters: () => ({}),
      normalizeSettings: (value) => ({ ...defaultAutoJoinSettings, ...(value || {}) }),
    },
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(engineSource + "\n" + driverSource, sandbox, {
    filename: path.join(ROOT, "engine/lobby/auto-join.js"),
  });
  return sandbox;
}
