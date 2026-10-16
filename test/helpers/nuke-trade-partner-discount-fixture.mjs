import { executeClassicScript } from "./classic-script.mjs";
import { readLegendaryPlannerSource } from "./legendary-planner-source.mjs";
import { readNukeBehaviorSource } from "./nuke-behavior-source.mjs";
import { readStructureBehaviorSource } from "./structure-behavior-source.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Create the classic-script scorer fixture used by the trade discount assertions.
 *
 * @returns Unit labels and factories for isolated scoring worlds.
 */
export function createNukeTradePartnerDiscountFixture() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

  const UNIT = {
    City: "City",
    Port: "Port",
    Factory: "Factory",
    Train: "Train",
    TradeShip: "Trade Ship",
    SAMLauncher: "SAM Launcher",
    MissileSilo: "Missile Silo",
    AtomBomb: "Atom Bomb",
  };
  const difficulty = "Impossible";
  const sandbox = {
    UNIT,
    Difficulty: {
      Easy: "Easy",
      Medium: "Medium",
      Hard: "Hard",
      Impossible: "Impossible",
      Legendary: "Legendary",
    },
    GameMode: { Team: "Team" },
    PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
    Relation: { Hostile: "Hostile" },
    state: { settings: { winFixes: true }, stats: { nukes: 0, builds: 0 } },
    currentDifficulty: () => difficulty,
    isAtLeastHardDifficulty: () => true,
    isLegendaryDifficulty: (value) => value === "Legendary" || value === "Impossible",
    WORKER_TIMEOUT_MS: 1000,
    withTimeout: async (promise) => promise,
    getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
    sendAutoBotBuildOrUpgrade: () => true,
    setLastAction: () => {},
    tr: (value) => value,
    EMOJI_NUKE: [],
    closestTwoTiles: (_game, a, _b) => ({ x: a[0], y: a[0] }),
    console,
  };
  sandbox.globalThis = sandbox;

  executeClassicScript(read("engine/ingame/shared-utils.js"), sandbox, {
    filename: "nuke-trade-discount-shared-utils.vm.js",
  });
  executeClassicScript(
    `${readLegendaryPlannerSource()}
  ${readStructureBehaviorSource()}
  ${readNukeBehaviorSource()}
  globalThis.__NukeBehavior = NukeBehavior;`,
    sandbox,
    { filename: "nuke-trade-discount.vm.js" },
  );

  function makeWorld() {
    // us <-> partner: free two-way trade. us <-> rival: mutual embargo.
    const partner = {
      tag: "partner",
      smallID: () => 2,
      _embargoes: new Set(),
      hasEmbargoAgainst(other) {
        return this._embargoes.has(other.smallID());
      },
    };
    const rival = {
      tag: "rival",
      smallID: () => 3,
      _embargoes: new Set(),
      hasEmbargoAgainst(other) {
        return this._embargoes.has(other.smallID());
      },
    };
    const us = {
      tag: "us",
      smallID: () => 1,
      _embargoes: new Set([rival.smallID()]),
      hasEmbargoAgainst(other) {
        return this._embargoes.has(other.smallID());
      },
    };
    rival._embargoes.add(us.smallID());
    return { us, partner, rival };
  }

  function makeScorer(us, carriers = [], onUnitsRead = () => {}) {
    let tick = 1000;
    const game = {
      ticks: () => tick,
      config: () => ({ nukeMagnitudes: () => ({ inner: 10, outer: 30 }) }),
      euclideanDistSquared: (a, b) => (a - b) * (a - b),
      nearbyUnits: () => [],
    };
    us.units = (...types) => {
      onUnitsRead();
      return carriers.filter(
        (carrier) => types.includes(carrier.type()) && carrier.owner().smallID() === us.smallID(),
      );
    };
    const behavior = new sandbox.__NukeBehavior(
      { chance: () => false },
      game,
      us,
      { shouldAttack: () => true },
      { maybeSendEmoji() {} },
    );
    behavior.recentlySentNukes = [];
    behavior.friendlyFirePenalty = () => 0;
    return { behavior, advanceTick: () => (tick += 1) };
  }

  function scoreStructure(
    type,
    level,
    {
      ownerTag = "partner",
      carrierType,
      carrierOwnerTag = "us",
      embargoed = false,
      carrierActive = true,
    } = {},
  ) {
    const world = makeWorld();
    if (embargoed) {
      world.us._embargoes.add(world.partner.smallID());
      world.partner._embargoes.add(world.us.smallID());
    }
    const owner = world[ownerTag];
    const unit = {
      id: () => `${owner.tag}-${type}`,
      type: () => type,
      level: () => level,
      tile: () => 10,
      owner: () => owner,
    };
    const carriers = carrierType
      ? [
          {
            type: () => carrierType,
            owner: () => world[carrierOwnerTag],
            targetUnit: () => unit,
            isActive: () => carrierActive,
          },
        ]
      : [];
    const { behavior } = makeScorer(world.us, carriers);
    const silo = { tile: () => 10 };
    return behavior.nukeTileScore(10, [silo], [unit], UNIT.AtomBomb, false);
  }

  return { UNIT, makeWorld, makeScorer, scoreStructure };
}
