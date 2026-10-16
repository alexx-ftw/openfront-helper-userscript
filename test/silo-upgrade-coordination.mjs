import assert from "node:assert/strict";
import fs from "node:fs";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const UNIT = Object.fromEntries(
  [
    "City",
    "Factory",
    "Port",
    "MissileSilo",
    "SAMLauncher",
    "DefensePost",
    "AtomBomb",
    "HydrogenBomb",
    "MIRV",
    "Warship",
  ].map((type) => [type, type]),
);
const sandbox = {
  UNIT,
  Difficulty: Object.fromEntries(
    ["Easy", "Medium", "Hard", "Impossible", "Legendary"].map((value) => [value, value]),
  ),
  state: { settings: { winFixes: true } },
  autoBotBuildAllowed: () => true,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${fs.readFileSync(new URL("../engine/ingame/auto-bot/structureBehavior.js", import.meta.url), "utf8")}\nglobalThis.Behavior = StructureBehavior;`,
  sandbox,
);
const prototype = sandbox.Behavior.prototype;
const silo = (id, level = 1) => ({
  id: () => id,
  level: () => level,
  isUnderConstruction: () => false,
});
function scenario({
  gold = 250n,
  economic = 100n,
  defensive = 50n,
  price = 100n,
  estimate = 100n,
  afterProbe = () => {},
} = {}) {
  const behavior = Object.create(prototype);
  const silos = [silo("route")];
  let sent = null;
  sandbox.state.nukeWantSlots = { need: 2, unblockedSiloIds: ["route"] };
  behavior.player = { units: (type) => (type === UNIT.MissileSilo ? silos : []) };
  behavior.game = { config: () => ({ isUnitDisabled: () => false }) };
  behavior.availableGoldAfterReserve = () => gold;
  behavior.economicConstructionPressure = () => ({ cost: economic });
  behavior.defensiveConstructionReserve = () => defensive;
  behavior.safeStructureCost = () => estimate;
  behavior.buildableForUnits = async () => {
    afterProbe({
      silos,
      setGold: (value) => {
        gold = value;
      },
    });
    return [{ canUpgrade: "route", cost: price }];
  };
  behavior.executeStructureUpgradeCandidate = (candidate) => {
    sent = candidate;
    return Boolean(candidate);
  };
  return { behavior, sent: () => sent };
}

// More expensive authoritative quotes must preserve the economy and SAM funds.
let run = scenario({ price: 101n });
assert.equal(await run.behavior.maybeUpgradeSiloForNukeDemand(), false);
assert.equal(run.sent(), undefined);
run = scenario({ price: 100n });
assert.equal(await run.behavior.maybeUpgradeSiloForNukeDemand(), true);
// An upgrade may cost less than a new silo; the estimated cost cannot veto it.
run = scenario({ price: 75n, estimate: 1_000n });
assert.equal(await run.behavior.maybeUpgradeSiloForNukeDemand(), true);
// Concurrent spending or a superseded salvo invalidates a pre-probe decision.
run = scenario({ afterProbe: ({ setGold }) => setGold(200n) });
assert.equal(await run.behavior.maybeUpgradeSiloForNukeDemand(), false);
run = scenario({
  afterProbe: () => {
    sandbox.state.nukeWantSlots = { need: 3 };
  },
});
assert.equal(await run.behavior.maybeUpgradeSiloForNukeDemand(), false);
run = scenario({
  afterProbe: ({ silos }) => {
    silos.splice(0);
  },
});
assert.equal(await run.behavior.maybeUpgradeSiloForNukeDemand(), false);
run = scenario({
  afterProbe: ({ silos }) => {
    silos[0] = silo("route", 2);
  },
});
assert.equal(await run.behavior.maybeUpgradeSiloForNukeDemand(), false);
assert.equal(sandbox.state.nukeWantSlots, null);
// A disappeared route silo must never redirect the upgrade to an unrelated silo.
run = scenario();
run.behavior.player.units = () => [silo("other")];
assert.equal(run.behavior.nukeDemandScopedSilos({ unblockedSiloIds: ["route"] }).length, 0);
assert.equal(await run.behavior.maybeUpgradeSiloForNukeDemand(), false);
// Legacy requests with no explicit route scope retain all built silos.
assert.equal(run.behavior.nukeDemandScopedSilos({}).length, 1);
console.warn("silo upgrade coordination scenarios passed");
