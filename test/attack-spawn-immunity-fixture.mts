import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { AttackExecution } from "../openfront-engine/src/core/execution/AttackExecution";
import { PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";
import { TestConfig } from "../openfront-engine/tests/util/TestConfig";

const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const game = await setup(
  "big_plains",
  { infiniteGold: true, infiniteTroops: true },
  [
    new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
    new PlayerInfo("defender", PlayerType.Human, null, "defender"),
  ],
  engineTestsUtil,
);
const config = game.config() as TestConfig;
config.setSpawnImmunityDuration(5);

const attacker = game.player("attacker");
const defender = game.player("defender");
assert.equal(attacker.canAttackPlayer(defender, false), false);

const troopsBeforeRejectedAttack = attacker.troops();
game.addExecution(new AttackExecution(1_000, attacker, defender.id()));
game.executeNextTick();

assert.equal(
  attacker.outgoingAttacks().length,
  0,
  "AttackExecution rejects a human target during spawn immunity",
);
assert.equal(
  attacker.troops(),
  troopsBeforeRejectedAttack,
  "a rejected immune-target attack removes no troops",
);

for (let tick = 1; tick < config.spawnImmunityDuration(); tick++) {
  game.executeNextTick();
}
assert.equal(
  attacker.canAttackPlayer(defender, false),
  true,
  "the same hostile human becomes attackable when spawn immunity expires",
);

game.addExecution(new AttackExecution(1_000, attacker, defender.id()));
game.executeNextTick();

assert.equal(
  attacker.outgoingAttacks().length,
  1,
  "AttackExecution accepts the same hostile target after immunity expires",
);

console.log("attack spawn-immunity engine fixture passed");
