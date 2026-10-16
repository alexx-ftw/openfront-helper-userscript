import { executeClassicScript } from "./classic-script.mjs";
import { readLegendaryPlannerSource } from "./legendary-planner-source.mjs";
import { readStructureBehaviorSource } from "./structure-behavior-source.mjs";

/**
 * Build the synthetic world used by the component-scoped Port seed assertions.
 *
 * @returns The behavior instance and fixture objects consumed by the test.
 */
export function createLegendaryPortSeedFixture() {
  const plannerSandbox = {};
  executeClassicScript(readLegendaryPlannerSource(), plannerSandbox, {
    filename: "legendaryPlanner.js",
  });

  const structureSandbox = {
    Difficulty: {
      Easy: "Easy",
      Medium: "Medium",
      Hard: "Hard",
      Impossible: "Impossible",
      Legendary: "Legendary",
    },
    GameMode: { Team: "Team" },
    UNIT: { City: "City", Factory: "Factory", Port: "Port" },
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
  Object.assign(structureSandbox, plannerSandbox);
  structureSandbox.globalThis = structureSandbox;
  executeClassicScript(
    `${readStructureBehaviorSource()}\nglobalThis.StructureBehavior = StructureBehavior;`,
    structureSandbox,
    { filename: "structureBehavior.js" },
  );

  const oceanComponent = -1;
  const lakeComponent = 7;
  const secondOceanComponent = 12;
  const oceanShore = "ocean-shore";
  const lakeShore = "lake-shore";
  const existingOceanPortShore = "existing-ocean-port-shore";
  const secondOceanShore = "second-ocean-shore";
  const secondPartnerShore = "second-partner-shore";
  const neighbors = new Map();
  const waterComponentByTile = new Map();
  const oceanTiles = new Set();
  const shoreTiles = new Set([
    oceanShore,
    lakeShore,
    existingOceanPortShore,
    secondOceanShore,
    secondPartnerShore,
  ]);

  // The production open-water check accepts a connected component of 400 tiles.
  const waterTilesForComponent = (firstTile, component, isOcean) => {
    const tiles = Array.from({ length: 400 }, (_, index) => firstTile + index);
    for (let index = 0; index < tiles.length; index++) {
      const adjacent = [];
      if (index > 0) adjacent.push(tiles[index - 1]);
      if (index + 1 < tiles.length) adjacent.push(tiles[index + 1]);
      neighbors.set(tiles[index], adjacent);
      waterComponentByTile.set(tiles[index], component);
      if (isOcean) oceanTiles.add(tiles[index]);
    }
    return tiles;
  };

  const oceanWater = waterTilesForComponent(1_000, oceanComponent, true);
  const lakeWater = waterTilesForComponent(2_000, lakeComponent, false);
  const secondOceanWater = waterTilesForComponent(3_000, secondOceanComponent, true);
  neighbors.set(oceanShore, [oceanWater[0]]);
  neighbors.set(lakeShore, [lakeWater[0]]);
  neighbors.set(existingOceanPortShore, [oceanWater[0]]);
  neighbors.set(secondOceanShore, [secondOceanWater[0]]);
  neighbors.set(secondPartnerShore, [secondOceanWater[1]]);

  const makePort = (tile, inProgress = false) => ({
    tile: () => tile,
    isUnderConstruction: () => inProgress,
    isMarkedForDeletion: () => false,
    isActive: () => true,
  });
  const actorPorts = [];
  const makePlayer = (id, ports = []) => ({
    id: () => id,
    smallID: () => id,
    teamId: 5,
    isPlayer: () => true,
    isAlive: () => true,
    isOnSameTeam: (other) => other?.teamId === 5,
    isAlliedWith: () => false,
    hasEmbargoAgainst: () => false,
    units: (type) => (type === "Port" ? ports : []),
  });
  const actor = makePlayer(1, actorPorts);
  const deterministicPartner = makePlayer(2);
  const thirdTeammate = makePlayer(3);
  const sharedComponents = new Map([
    [1, new Set([oceanComponent, secondOceanComponent])],
    [2, new Set([oceanComponent])],
    [3, new Set([secondOceanComponent])],
  ]);

  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  Object.assign(behavior, {
    player: actor,
    game: {
      players: () => [thirdTeammate, actor, deterministicPartner],
      sharedWaterComponents: (owner) => sharedComponents.get(owner?.smallID?.()) ?? null,
      neighbors: (tile) => neighbors.get(tile) ?? [],
      forEachNeighbor: (tile, callback) => {
        for (const neighbor of neighbors.get(tile) ?? []) callback(neighbor);
      },
      isShore: (tile) => shoreTiles.has(tile),
      isWater: (tile) => waterComponentByTile.has(tile),
      isOcean: (tile) => oceanTiles.has(tile),
      getWaterComponent: (tile) => waterComponentByTile.get(tile),
    },
  });
  actor.borderTiles = () => [oceanShore, lakeShore, secondOceanShore];
  actor.oceanShoreBorderTiles = () => [oceanShore, secondOceanShore];
  thirdTeammate.borderTiles = () => [secondPartnerShore];
  // Give this fixture two independent open seas so component-scoped seed state is observable.
  behavior.portWaterComponents = (tile) =>
    new Set(
      (neighbors.get(tile) ?? [])
        .map((neighbor) => waterComponentByTile.get(neighbor))
        .filter((component) => component !== undefined),
    );

  return {
    actor,
    actorPorts,
    behavior,
    deterministicPartner,
    existingOceanPortShore,
    lakeComponent,
    lakeShore,
    makePort,
    oceanComponent,
    oceanShore,
    secondOceanComponent,
    secondOceanShore,
    secondPartnerShore,
    thirdTeammate,
  };
}
