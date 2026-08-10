import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { AttackExecution } from "../openfront-engine/src/core/execution/AttackExecution";
import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "../openfront-engine/src/core/game/Game";
import type { Game, Player } from "../openfront-engine/src/core/game/Game";
import type { TileRef } from "../openfront-engine/src/core/game/GameMap";
import { setup } from "../openfront-engine/tests/util/Setup";
import { UseRealAttackLogic } from "../openfront-engine/tests/util/TestConfig";

const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const TRIBE_TILES = 1_000;
const TRIBE_TROOPS = 100;
const RATIO_FLOOR = TRIBE_TROOPS * 4;

function connectedMountainRegion(game: Game): TileRef[] {
  const visited = new Set<TileRef>();
  for (let y = 0; y < game.height(); y++) {
    for (let x = 0; x < game.width(); x++) {
      const start = game.ref(x, y);
      if (visited.has(start) || game.terrainType(start) !== TerrainType.Mountain) continue;
      const component: TileRef[] = [];
      const queue = [start];
      visited.add(start);
      for (let head = 0; head < queue.length; head++) {
        const tile = queue[head];
        component.push(tile);
        for (const neighbor of game.neighbors(tile)) {
          if (visited.has(neighbor) || game.terrainType(neighbor) !== TerrainType.Mountain) {
            continue;
          }
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
      if (component.length > TRIBE_TILES) return component.slice(0, TRIBE_TILES);
    }
  }
  throw new Error(`fixture map has no ${TRIBE_TILES}-tile mountain component`);
}

function mountainInterior(game: Game, start: TileRef, attackerTile: TileRef): TileRef[] {
  const tiles = [start];
  const seen = new Set(tiles);
  for (let head = 0; head < tiles.length && tiles.length < TRIBE_TILES - 1; head++) {
    for (const neighbor of game.neighbors(tiles[head])) {
      if (seen.has(neighbor) || game.terrainType(neighbor) !== TerrainType.Mountain) continue;
      if (game.neighbors(attackerTile).includes(neighbor)) continue;
      seen.add(neighbor);
      tiles.push(neighbor);
      if (tiles.length >= TRIBE_TILES - 1) break;
    }
  }
  return tiles;
}

function mixedTerrainRegion(game: Game): {
  attackerTile: TileRef;
  frontier: TileRef;
  region: TileRef[];
} {
  for (let y = 0; y < game.height(); y++) {
    for (let x = 0; x < game.width(); x++) {
      const mountain = game.ref(x, y);
      if (game.terrainType(mountain) !== TerrainType.Mountain) continue;
      for (const frontier of game.neighbors(mountain)) {
        if (
          !game.isLand(frontier) ||
          game.isImpassable(frontier) ||
          game.terrainType(frontier) === TerrainType.Mountain
        )
          continue;
        for (const attackerTile of game.neighbors(frontier)) {
          if (
            attackerTile === mountain ||
            !game.isLand(attackerTile) ||
            game.isImpassable(attackerTile) ||
            game.terrainType(attackerTile) === TerrainType.Mountain ||
            game.neighbors(attackerTile).includes(mountain)
          )
            continue;
          const interior = mountainInterior(game, mountain, attackerTile);
          if (interior.length === TRIBE_TILES - 1) {
            return { attackerTile, frontier, region: [frontier, ...interior] };
          }
        }
      }
    }
  }
  throw new Error("fixture map has no cheap-frontier mountain-interior tribe region");
}

async function createPlayers(): Promise<{ attacker: Player; bot: Player; game: Game }> {
  const game = await setup(
    "world",
    { infiniteGold: true, instantBuild: true },
    [],
    engineTestsUtil,
    UseRealAttackLogic,
  );
  game.addPlayer(new PlayerInfo("attacker", PlayerType.Human, null, "attacker"));
  game.addPlayer(new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"));
  return { attacker: game.player("attacker"), bot: game.player("tribe"), game };
}

async function createScenario(): Promise<{
  attacker: Player;
  bot: Player;
  frontier: TileRef;
  game: Game;
}> {
  const { attacker, bot, game } = await createPlayers();
  const region = connectedMountainRegion(game);
  const regionSet = new Set(region);
  for (const tile of region) bot.conquer(tile);
  const attackerTile = region
    .flatMap((tile) => game.neighbors(tile))
    .find((tile) => !regionSet.has(tile) && game.isLand(tile) && !game.isImpassable(tile));
  assert.notEqual(attackerTile, undefined, "mountain region exposes an attack frontier");
  attacker.conquer(attackerTile!);
  attacker.setTroops(1_000_000);
  bot.setTroops(TRIBE_TROOPS);
  const frontier = region.find((tile) => game.neighbors(tile).includes(attackerTile!));
  assert.notEqual(frontier, undefined);
  return { attacker, bot, frontier: frontier!, game };
}

async function createMixedScenario(): Promise<{
  attacker: Player;
  bot: Player;
  frontier: TileRef;
  game: Game;
}> {
  const { attacker, bot, game } = await createPlayers();
  const { attackerTile, frontier, region } = mixedTerrainRegion(game);
  for (const tile of region) bot.conquer(tile);
  const deepInterior = region.reduce((best, tile) =>
    game.euclideanDistSquared(tile, frontier) > game.euclideanDistSquared(best, frontier)
      ? tile
      : best,
  );
  bot.buildUnit(UnitType.DefensePost, deepInterior, {});
  attacker.conquer(attackerTile);
  attacker.setTroops(1_000_000);
  bot.setTroops(TRIBE_TROOPS);
  return { attacker, bot, frontier, game };
}

function executeAttack(game: Game, attacker: Player, bot: Player, troops: number): void {
  game.addExecution(new AttackExecution(troops, attacker, bot.id()));
  for (let tick = 0; tick < 2_000 && bot.numTilesOwned() > 0; tick++) {
    game.executeNextTick();
  }
}

const underfunded = await createScenario();
executeAttack(underfunded.game, underfunded.attacker, underfunded.bot, RATIO_FLOOR);
assert.ok(
  underfunded.bot.numTilesOwned() > 0,
  "the legacy four-times troop floor does not capture a large mountain tribe",
);

const funded = await createScenario();
const perTileLoss = funded.game
  .config()
  .attackLogic(
    funded.game,
    RATIO_FLOOR,
    funded.attacker,
    funded.bot,
    funded.frontier,
  ).attackerTroopLoss;
const terrainFloor = Math.ceil(perTileLoss * funded.bot.numTilesOwned());
assert.ok(terrainFloor > RATIO_FLOOR);
executeAttack(funded.game, funded.attacker, funded.bot, terrainFloor);
assert.equal(
  funded.bot.numTilesOwned(),
  0,
  "the terrain-aware floor captures the same tribe in the real engine",
);

const mixedUnderfunded = await createMixedScenario();
const mixedFrontLoss = mixedUnderfunded.game
  .config()
  .attackLogic(
    mixedUnderfunded.game,
    RATIO_FLOOR,
    mixedUnderfunded.attacker,
    mixedUnderfunded.bot,
    mixedUnderfunded.frontier,
  ).attackerTroopLoss;
const mixedFrontFloor = Math.max(
  RATIO_FLOOR,
  Math.ceil(mixedFrontLoss * mixedUnderfunded.bot.numTilesOwned()),
);
executeAttack(
  mixedUnderfunded.game,
  mixedUnderfunded.attacker,
  mixedUnderfunded.bot,
  mixedFrontFloor,
);
assert.ok(
  mixedUnderfunded.bot.numTilesOwned() > 0,
  "a cheap initial frontier underfunds the mountain interior",
);

const mixedFunded = await createMixedScenario();
const mixedWorstLoss = Math.max(
  ...Array.from(
    mixedFunded.bot.tiles(),
    (tile) =>
      mixedFunded.game
        .config()
        .attackLogic(mixedFunded.game, RATIO_FLOOR, mixedFunded.attacker, mixedFunded.bot, tile)
        .attackerTroopLoss,
  ),
);
const mixedTerritoryFloor = Math.ceil(mixedWorstLoss * mixedFunded.bot.numTilesOwned());
assert.ok(mixedTerritoryFloor > mixedFrontFloor);
executeAttack(mixedFunded.game, mixedFunded.attacker, mixedFunded.bot, mixedTerritoryFloor);
assert.equal(
  mixedFunded.bot.numTilesOwned(),
  0,
  "the whole-territory floor captures a cheap-frontier mountain tribe",
);

console.log("terrain-aware tribe capture engine fixture passed");
