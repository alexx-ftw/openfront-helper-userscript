import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const source = readRepositoryFile("scripts/headless/opponent-adapter.js");
const methodStart = source.indexOf("  enableNukeTrace() {");
const methodEnd = source.indexOf("  recordNukeDecisionTrace({", methodStart);
assert.ok(methodStart >= 0 && methodEnd > methodStart, "nuke trace method must be present");
const method = source.slice(methodStart, methodEnd);
const result = executeClassicScript(
  `
function installNukeDecisionTraceHooks() { return { lastCandidates: [] }; }
class TraceHarness {
${method}
}
const harness = new TraceHarness();
harness.game = { ticks: () => 23 };
harness.structureTrace = [];
harness.nationBot = { nukeBehavior: { createSamOverwhelmPlan: () => null } };
harness.enableNukeTrace();
({ plan: harness.nationBot.nukeBehavior.createSamOverwhelmPlan(), trace: harness.structureTrace });
`,
  {},
);

assert.equal(result.plan, null, "tracing must preserve a null plan result");
assert.deepEqual(JSON.parse(JSON.stringify(result.trace)), [
  {
    kind: "sam-plan",
    tick: 23,
    targetSamId: null,
    aimTile: null,
    coveringSamLevels: null,
    totalBombs: null,
    capacityMissing: null,
    windowBombs: 0,
  },
]);
process.stdout.write("null SAM plan trace check passed\n");
