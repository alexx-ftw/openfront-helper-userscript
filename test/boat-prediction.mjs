import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "engine/ingame/boat-prediction.js"), "utf8");
const TEST_SOURCE = `${SOURCE}\nwindow.__isBoatRetreating = isBoatRetreating;`;
const sandbox = { window: {} };

executeClassicScript(TEST_SOURCE, sandbox, { filename: "boat-prediction.js" });

assert.equal(
  sandbox.window.__isBoatRetreating({
    transportShipState: () => ({ isRetreating: true }),
  }),
  true,
  "the canonical UnitView transport state removes a cancelled landing marker",
);
assert.equal(
  sandbox.window.__isBoatRetreating({
    transportShipState: () => ({ isRetreating: false }),
  }),
  false,
  "an active transport keeps its landing marker",
);
assert.equal(
  sandbox.window.__isBoatRetreating({ retreating: () => true }),
  true,
  "legacy AttackUpdate-shaped transport adapters remain supported",
);

process.stdout.write("boat prediction tests passed\n");
