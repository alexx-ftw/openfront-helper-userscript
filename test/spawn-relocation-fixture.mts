import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { SpawnExecution } from "../openfront-engine/src/core/execution/SpawnExecution";
import { GameType, PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";

const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const playerInfo = new PlayerInfo("player", PlayerType.Human, "client", "player");
const game = await setup(
  "half_land_half_ocean",
  { gameType: GameType.Private },
  [playerInfo],
  engineTestsUtil,
  undefined,
  false,
);

assert.equal(game.inSpawnPhase(), true);
game.addExecution(new SpawnExecution("spawn-relocation", playerInfo, 20, true));
game.executeNextTick();
game.executeNextTick();

const player = game.player("player");
assert.equal(player.spawnTile(), 20);
const selfOwnedTarget = Array.from(player.tiles()).find((tile) => tile !== player.spawnTile());
assert.notEqual(selfOwnedTarget, undefined);
assert.equal(game.ownerID(selfOwnedTarget), player.smallID());

game.addExecution(new SpawnExecution("spawn-relocation", playerInfo, selfOwnedTarget, true));
game.executeNextTick();
game.executeNextTick();

assert.equal(
  player.spawnTile(),
  selfOwnedTarget,
  "SpawnExecution relinquishes existing self-owned territory before validating an in-phase relocation",
);
assert.ok(player.numTilesOwned() > 0);

console.log("spawn relocation engine fixture passed");
