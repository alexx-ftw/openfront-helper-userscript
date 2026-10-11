import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

const SOURCE = readRepositoryFile("engine/ingame/boat-prediction.js");
const TEST_SOURCE = `${SOURCE}\nwindow.__isBoatRetreating = isBoatRetreating;\nwindow.__computeBoatEtaMs = computeBoatEtaMs;`;
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

assert.equal(
  sandbox.window.__computeBoatEtaMs(
    {
      ticks: () => 10,
      config: () => ({ msPerTick: () => 100 }),
      motionPlans: () => new Map([[7, { startTick: 10, ticksPerStep: 2, path: [11, 12, 13, 14] }]]),
    },
    { motionPlanUnitId: 7 },
  ),
  600,
  "boat ETA counts movements between path tiles, not the path tile count",
);

process.stdout.write("boat prediction tests passed\n");
