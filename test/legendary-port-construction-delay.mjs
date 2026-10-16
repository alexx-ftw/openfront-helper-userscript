import assert from "node:assert/strict";
import { readStructureBehaviorSource } from "./helpers/structure-behavior-source.mjs";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const structureSource = readStructureBehaviorSource();
const sandbox = {
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  UNIT: {
    City: "City",
    Factory: "Factory",
    Port: "Port",
    SAMLauncher: "SAMLauncher",
    MissileSilo: "MissileSilo",
  },
  currentDifficulty: () => "Impossible",
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: () => false,
  legendaryPlacementProximityScore: (distance, radius) =>
    Math.max(0, 1 - distance / Math.max(1, radius)),
  UniversalPathFinding: null,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${structureSource}\nglobalThis.StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: "structureBehavior.js" },
);

const seedPartnerPricing = structureSource.slice(
  structureSource.indexOf('portSeedStream: "partner"'),
  structureSource.indexOf("committed: inProgress.length > 0"),
);
assert.match(
  seedPartnerPricing,
  /constructionDelayTicks:[\s\S]*legendaryConstructionRemainingTicks\(/,
  "seed-partner construction delay uses the remaining-ticks helper",
);
assert.match(
  seedPartnerPricing,
  /legendaryConstructionRemainingTicks\(\s*UNIT\.Port,\s*partnerTarget\.unit/,
  "seed-partner pricing passes its observed Port to the helper",
);
assert.match(
  structureSource,
  /legendaryPortInboundSource\(source, profiles\)[\s\S]*?legendaryConstructionRemainingTicks\(UNIT\.Port, source\.unit\)/,
  "incoming Port routes use the observed source Port's remaining construction delay",
);

const PORT_CONSTRUCTION_TICKS = 50;
let currentTick = 100;
const liveConfig = {
  unitInfo: (type) => ({
    constructionDuration: type === sandbox.UNIT.Port ? PORT_CONSTRUCTION_TICKS : 20,
  }),
};
const behavior = Object.create(sandbox.StructureBehavior.prototype);
behavior.game = { config: () => liveConfig, ticks: () => currentTick };

assert.equal(
  typeof behavior.legendaryConstructionRemainingTicks,
  "function",
  "StructureBehavior exposes the production construction-remaining helper",
);

const remaining = (constructionStartTick) =>
  behavior.legendaryConstructionRemainingTicks(sandbox.UNIT.Port, {
    isUnderConstruction: () => true,
    state: { constructionStartTick },
  });

assert.equal(remaining(80), 30, "an observed Port has 30 of 50 construction ticks left");
assert.equal(remaining(100), 50, "a Port first observed at its start keeps the full duration");

currentTick = 130;
assert.equal(remaining(80), 0, "construction is complete at start tick plus duration");
currentTick = 135;
assert.equal(remaining(80), 0, "construction remains complete after its duration");

currentTick = 100;
assert.equal(remaining(undefined), 50, "a missing start tick uses the full configured duration");
assert.equal(remaining(101), 50, "a future start tick uses the full configured duration");
assert.equal(remaining(-1), 50, "an untrusted negative start tick uses the full duration");
assert.equal(remaining(Number.NaN), 50, "a non-finite start tick uses the full duration");

process.stdout.write("PASS Legendary Port construction remaining ticks and seed-partner pricing\n");
