import assert from "node:assert/strict";
import { createStructureUpgradeFixture } from "./helpers/structure-upgrade-fixture.mjs";

// Surplus silo leveling (PD28): outside the two reactive lanes a built
// Missile Silo never leveled (n=60 1.12.195 baseline: 6 builds, 0 upgrades).
// The Legendary surplus lane must upgrade a below-cap built silo from true
// post-reserve surplus, decline without the budget / below-cap headroom /
// winFixes / enabled nukes, and draw no RNG on either path.

const UNIT = {
  MissileSilo: "MissileSilo",
  AtomBomb: "AtomBomb",
  HydrogenBomb: "HydrogenBomb",
  MIRV: "MIRV",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};

function makeWorld({
  gold = 5_000_000n,
  level = 1,
  levels = null,
  upgradeCosts = [],
  goldDropDuringProbe = false,
  winFixes = true,
  nukesDisabled = false,
} = {}) {
  let rngDraws = 0;
  let availableGold = gold;
  const state = { settings: { winFixes }, stats: { builds: 0 }, lastAction: null };
  const silos = (levels ?? [level]).map((siloLevel, index) => ({
    id: () => index + 1,
    level: () => siloLevel,
    isUnderConstruction: () => false,
    tile: () => 100 + index,
    type: () => UNIT.MissileSilo,
  }));
  const game = {
    ticks: () => 0,
    config: () => ({
      isUnitDisabled: (type) =>
        nukesDisabled &&
        (type === UNIT.AtomBomb || type === UNIT.HydrogenBomb || type === UNIT.MIRV),
    }),
  };
  const { behavior, emitted } = createStructureUpgradeFixture({
    UNIT,
    Difficulty,
    state,
    bindings: {
      isLegendaryDifficulty: () => true,
      playersArePermanentTeammates: () => false,
    },
  });
  behavior.game = game;
  behavior.player = { units: (type) => (type === UNIT.MissileSilo ? silos : []) };
  // Deterministic probe surface: no hostile missile impact, an upgradable
  // descriptor, and the PD28 budget inputs.
  behavior.tileInsideActiveHostileMissileImpact = () => false;
  behavior.buildableFor = async (_type, tile) => {
    if (goldDropDuringProbe) availableGold = 0n;
    return {
      canUpgrade: true,
      cost: upgradeCosts[tile - 100] ?? 1_000_000n,
    };
  };
  behavior.cost = () => 1_000_000n;
  behavior.availableGoldAfterReserve = () => availableGold;
  behavior.economicConstructionPressure = () => null;
  behavior.defensiveConstructionReserve = () => 0n;
  behavior.random = {
    nextInt: () => {
      rngDraws += 1;
      return 0;
    },
  };
  return { behavior, emitted, state, rngDraws: () => rngDraws };
}

// 1. Surplus upgrades the silo through the menu and counts a build.
{
  const { behavior, emitted, state } = makeWorld();
  assert.equal(await behavior.maybeUpgradeSiloFromSurplus(), true);
  assert.equal(emitted.length, 1, "the surplus upgrade reaches the menu");
  assert.equal(state.stats.builds, 1, "the upgrade counts as a build action");
  assert.equal(state.lastAction.text, "⬆️ Upgrade {type}");
}

// 2. A treasury under the budget gate declines.
{
  const { behavior, emitted } = makeWorld({ gold: 0n });
  assert.equal(await behavior.maybeUpgradeSiloFromSurplus(), false);
  assert.equal(emitted.length, 0, "no upgrade without surplus");
}

// 3. A max-level silo declines.
{
  const { behavior, emitted } = makeWorld({ level: 5 });
  assert.equal(await behavior.maybeUpgradeSiloFromSurplus(), false);
  assert.equal(emitted.length, 0, "no upgrade past the cap");
}

// 4. winFixes off declines.
{
  const { behavior, emitted } = makeWorld({ winFixes: false });
  assert.equal(await behavior.maybeUpgradeSiloFromSurplus(), false);
  assert.equal(emitted.length, 0, "the lane is winFixes-scoped");
}

// 5. All nukes disabled declines.
{
  const { behavior, emitted } = makeWorld({ nukesDisabled: true });
  assert.equal(await behavior.maybeUpgradeSiloFromSurplus(), false);
  assert.equal(emitted.length, 0, "no leveling without a nuclear payoff");
}

// 6. No RNG draws on either path.
{
  const accept = makeWorld();
  await accept.behavior.maybeUpgradeSiloFromSurplus();
  const decline = makeWorld({ gold: 0n });
  await decline.behavior.maybeUpgradeSiloFromSurplus();
  assert.equal(accept.rngDraws() + decline.rngDraws(), 0, "the lane draws no RNG");
}

// 7. An open nukeWantSlots demand remains with the target-specific route
//    and reserve checks; the generic surplus lane cannot mask their decline.
{
  const { behavior, emitted, state } = makeWorld();
  state.nukeWantSlots = {
    need: 3,
    targetSamId: 201,
    at: 0,
    targetTile: 900,
    unblockedSiloIds: ["1"],
  };
  assert.equal(await behavior.maybeUpgradeSiloFromSurplus(), false);
  assert.equal(emitted.length, 0, "an open SAM demand cannot fall through to generic leveling");
}

// 8. A treasury drop during the asynchronous probe is rechecked before spend.
{
  const { behavior, emitted } = makeWorld({ goldDropDuringProbe: true });
  assert.equal(await behavior.maybeUpgradeSiloFromSurplus(), false);
  assert.equal(emitted.length, 0, "the post-probe reserve gate prevents overspend");
}

// 9. If the first silo quote is unaffordable, a cheaper later silo can upgrade.
{
  const { behavior, emitted } = makeWorld({
    gold: 2_000_000n,
    levels: [1, 1],
    upgradeCosts: [3_000_000n, 1_000_000n],
  });
  assert.equal(await behavior.maybeUpgradeSiloFromSurplus(), true);
  assert.equal(emitted.length, 1, "an affordable later silo is still considered");
  assert.equal(emitted[0].cost, 1_000_000n);
}

await import("./silo-demand-upgrade-preference.mjs");
process.stdout.write("silo surplus upgrade tests passed\n");
