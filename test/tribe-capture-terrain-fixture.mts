import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { AttackExecution } from "../openfront-engine/src/core/execution/AttackExecution";
import { PlayerInfo, PlayerType, TerrainType } from "../openfront-engine/src/core/game/Game";
import type { Game, Player } from "../openfront-engine/src/core/game/Game";
import type { TileRef } from "../openfront-engine/src/core/game/GameMap";
import { setup } from "../openfront-engine/tests/util/Setup";
import { UseRealAttackLogic } from "../openfront-engine/tests/util/TestConfig";

const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const TRIBE_TILES = 200;
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

async function createScenario(): Promise<{
  attacker: Player;
  bot: Player;
  frontier: TileRef;
  game: Game;
}> {
  const game = await setup(
    "world",
    { infiniteGold: true, instantBuild: true },
    [],
    engineTestsUtil,
    UseRealAttackLogic,
  );
  game.addPlayer(new PlayerInfo("attacker", PlayerType.Human, null, "attacker"));
  game.addPlayer(new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"));
  const attacker = game.player("attacker");
  const bot = game.player("tribe");
  const region = connectedMountainRegion(game);
  const regionSet = new Set(region);
  for (const tile of region) bot.conquer(tile);
  const attackerTile = region
    .flatMap((tile) => game.neighbors(tile))
    .find((tile) => !regionSet.has(tile) && game.isLand(tile) && !game.isImpassable(tile));
  assert.notEqual(attackerTile, undefined, "mountain region exposes an attack frontier");
  attacker.conquer(attackerTile!);
  attacker.setTroops(100_000);
  bot.setTroops(TRIBE_TROOPS);
  const frontier = region.find((tile) => game.neighbors(tile).includes(attackerTile!));
  assert.notEqual(frontier, undefined);
  return { attacker, bot, frontier: frontier!, game };
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

console.log("terrain-aware tribe capture engine fixture passed");
