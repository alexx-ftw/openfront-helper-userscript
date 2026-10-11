import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";
import { setup } from "../openfront-engine/tests/util/Setup.ts";
import { fileURLToPath } from "node:url";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game.ts";
import { Config } from "../openfront-engine/src/core/configuration/Config.ts";
import { SAMLauncherExecution } from "../openfront-engine/src/core/execution/SAMLauncherExecution.ts";
import { MissileSiloExecution } from "../openfront-engine/src/core/execution/MissileSiloExecution.ts";
const sandbox: any = { window: {} };
executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/hybridNativeKnowledge.js"),
  sandbox,
);
const api = sandbox.window.__OFH_hybridNativeKnowledge;
const game = await setup(
  "big_plains",
  { instantBuild: true },
  ["attacker", "defender"].map((id) => new PlayerInfo(id, PlayerType.Human, id, id)),
  fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url)),
);
const player = game.player("attacker");
const tile = game.ref(10, 10);
player.conquer(tile);
const context = { game, player };
for (const type of [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV]) {
  const quote = api.quoteNuclearPurchase(context, type);
  assert.equal(quote.status, "known");
  assert.equal(quote.cost, game.config().unitInfo(type).cost(game, player));
}
const silo = player.buildUnit(UnitType.MissileSilo, tile, {});
silo.setUnderConstruction(false);
assert.equal(api.describeSilo(context, silo).readySlots, 1);
silo.launch();
assert.equal(api.describeSilo(context, silo).readySlots, 0);
const execution = new MissileSiloExecution(silo);
execution.init(game, game.ticks());
while (game.ticks() < game.config().SiloCooldown()) game.executeNextTick();
execution.tick(game.ticks());
assert.equal(
  api.describeSilo(context, silo).readySlots,
  1,
  "official execution reloads native slot",
);
const sam = player.buildUnit(UnitType.SAMLauncher, game.ref(11, 10), {});
sam.setUnderConstruction(false);
// Setup TestConfig overrides ranges. Bind the official production method explicitly.
const productionRange = Config.prototype.samRange.call(game.config(), sam.level());
const original = game.config().samRange;
game.config().samRange = function (level) {
  return Config.prototype.samRange.call(this, level);
};
assert.equal(api.describeSam(context, sam).range, productionRange);
assert.notEqual(productionRange, original.call(game.config(), sam.level()));
assert.equal(api.describeSam(context, sam).guaranteedInterception, false);
assert.equal(
  api.quoteNuclearPurchase({ game: { ticks: () => 1, config: () => ({}) }, player }, UnitType.MIRV)
    .status,
  "unknown",
);

const firstMirv = api.quoteNuclearPurchase(context, UnitType.MIRV).cost;
game.recordMirvLaunch();
const nextMirv = api.quoteNuclearPurchase(context, UnitType.MIRV).cost;
assert.ok(nextMirv > firstMirv);
assert.equal(nextMirv, game.config().unitInfo(UnitType.MIRV).cost(game, player));
const scheduler: any = new SAMLauncherExecution(player, null, sam);
scheduler.init(game, game.ticks());
scheduler.tick(game.ticks());
const attacker = game.player("defender");
const near = attacker.buildUnit(UnitType.AtomBomb, game.ref(12, 10), {
  targetTile: game.ref(12, 10),
  trajectory: [{ tile: game.ref(12, 10), targetable: true }],
});
const distant = attacker.buildUnit(UnitType.HydrogenBomb, game.ref(100, 10), {
  targetTile: game.ref(100, 10),
  trajectory: [{ tile: game.ref(100, 10), targetable: true }],
});
const score = (unit: any) => scheduler.targetingSystem.computeTargetScore({ unit });
assert.ok(
  score(near) > score(distant),
  "actual SAM priority is not always Hydro first: distance can dominate type bonus",
);

sam.launch();
assert.equal(api.describeSam(context, sam).readySlots, 0);
sam.increaseLevel();
assert.equal(
  api.describeSam(context, sam).readySlots,
  0,
  "native upgrade adds a queued slot, not an immediately ready interception",
);
assert.equal(api.describeSam(context, sam).range, game.config().dynamicSamRange(sam, game.ticks()));
const previousInfinite = game.config().gameConfig().infiniteGold;
game.config().gameConfig().infiniteGold = true;
assert.equal(api.quoteNuclearPurchase(context, UnitType.AtomBomb).cost, 0n);
game.config().gameConfig().infiniteGold = previousInfinite;
assert.equal(api.describeSam(context, { __src: sam }).range, api.describeSam(context, sam).range);
process.stdout.write("hybrid native knowledge fixtures passed\n");
