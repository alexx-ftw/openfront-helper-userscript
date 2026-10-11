import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";
import { setup } from "../openfront-engine/tests/util/Setup.ts";
import { fileURLToPath } from "node:url";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game.ts";
import { EmojiExecution } from "../openfront-engine/src/core/execution/EmojiExecution.ts";
import { AttackExecution } from "../openfront-engine/src/core/execution/AttackExecution.ts";
import { getSpawnTiles } from "../openfront-engine/src/core/execution/Util.ts";
import { flattenedEmojiTable } from "../openfront-engine/src/core/Util.ts";
import {
  createGame as createCoastalGame,
  L,
  W,
} from "../openfront-engine/tests/core/pathfinding/_fixtures.ts";
import { TransportShipExecution } from "../openfront-engine/src/core/execution/TransportShipExecution.ts";
import { unpackMotionPlans } from "../openfront-engine/src/core/game/MotionPlans.ts";
import { BoatRetreatExecution } from "../openfront-engine/src/core/execution/BoatRetreatExecution.ts";
import { PseudoRandom } from "../openfront-engine/src/core/PseudoRandom.ts";
const game = await setup(
  "big_plains",
  { instantBuild: true },
  ["leader01", "support1", "enemy001"].map((id) => new PlayerInfo(id, PlayerType.Human, id, id)),
  fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url)),
);
const leader = game.player("leader01"),
  me = game.player("support1"),
  enemy = game.player("enemy001");
leader.conquer(game.ref(3, 3));
me.conquer(game.ref(80, 80));
for (let y = 2; y < 32; y++) for (let x = 4; x < 34; x++) enemy.conquer(game.ref(x, y));
leader.addTroops(20000);
me.addTroops(20000);
enemy.addTroops(30000);
game.createAllianceRequest(leader, me)!.accept();
const sandbox: any = {
  window: {},
  state: { settings: { winFixes: true } },
  UNIT: UnitType,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  isLegendaryDifficulty: () => false,
  profileStructureAsync: async (_profile, _name, fn) => fn(),
};
executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js") +
    "\nwindow.baseStructure=StructureBehavior;",
  sandbox,
);
executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/hybridStrategy.js"), sandbox);
const strategy = sandbox.window.__OFH_hybridStrategy;
const random = new PseudoRandom(1);
const baseline = strategy.createStructureBehavior(random, game, me);
assert.equal(baseline.constructor, sandbox.window.baseStructure);
strategy.configure({ enabled: true });
const behavior = strategy.createStructureBehavior(random, game, me);
assert.ok(behavior instanceof sandbox.window.baseStructure);
const hooks = [
  "handleStructures",
  "legendaryConstructionActionGroups",
  "legendaryConstructionActionGroupResult",
  "legendaryConstructionCandidates",
  "maybeSpawnStructure",
  "structureSpawnBuildable",
  "buildableFor",
  "buildableForUnits",
  "availableGoldAfterReserve",
  "spendableConstructionGold",
  "isUsableStructureBuildable",
  "genericStructureUpgradeAllowed",
  "maybeUpgradeLegendaryCityCapacity",
  "tileInsideActiveHostileMissileImpact",
];
for (const hook of hooks) assert.equal(typeof behavior[hook], "function", hook);
let probes = 0;
behavior.handleActiveMissileSamMaximumPriority = async () => {
  probes++;
  return false;
};
behavior.maybeSpawnStructure = () =>
  assert.fail("inherited defense hold must not fallback-purchase");
assert.equal(await behavior.handleStructures(), false);
assert.equal(
  probes,
  1,
  "actual inherited handleStructures caller enters native-order safety guard",
);
// The safety branch above is controlled; remaining fixtures execute actual native executions.
const context = { game, player: me };
game.addExecution(new AttackExecution(10000, leader, enemy.id()));
game.executeNextTick();
game.executeNextTick();
const attack = leader.outgoingAttacks()[0];
assert.ok(attack);
strategy.observeDuo(context);
assert.equal(flattenedEmojiTable.indexOf("✋"), 17);
assert.equal(flattenedEmojiTable.indexOf("⏳"), 29);
game.addExecution(new EmojiExecution(leader, me.id(), 17));
game.executeNextTick();
game.executeNextTick();
executeClassicScript(
  readRepositoryFile("engine/ingame/companion/actions.js") +
    "\nwindow.supportEmoji=companionSupportEmoji;",
  sandbox,
);
sandbox.companionState = {};
let sentPackets = 0;
sandbox.sendGamePacket = (intent) => {
  sentPackets++;
  assert.equal(intent.type, "emoji");
  assert.equal(intent.recipient, leader.id());
  assert.equal(intent.emoji, 29);
  game.addExecution(new EmojiExecution(me, intent.recipient, intent.emoji));
  return true;
};
const pending = strategy.observeDuo(context)[0];
assert.equal(pending.status, "ack-pending");
assert.equal(strategy.getJointPlan(context, leader.smallID()), null);
assert.equal(sandbox.window.supportEmoji(game, me, leader, "⏳"), true);
assert.equal(sentPackets, 1);
assert.equal(
  strategy.getJointPlan(context, leader.smallID()),
  null,
  "send true is still not native ACK",
);
game.executeNextTick();
game.executeNextTick();
const plan = strategy.getJointPlan(context, leader.smallID());
assert.ok(plan);
assert.equal(plan.attackId, attack.id());
assert.equal(plan.targetSid, enemy.smallID());
assert.equal(plan.ackTick, me.outgoingEmojis()[0].createdAt);
while (game.ticks() < plan.expiresTick) game.executeNextTick();
assert.equal(
  strategy.getJointPlan(context, leader.smallID()),
  null,
  "native age equality expires ACK exchange",
);
// Negative contract perturbation of scratch GameImpl only, after native feed expiry.
const nativeExpiry = game.ticks();
(game as any)._ticks = plan.ackTick;
assert.equal(
  strategy.getJointPlan(context, leader.smallID()),
  null,
  "expired native ACK cannot revive after rollback",
);
(game as any)._ticks = nativeExpiry;
assert.equal(
  strategy.getJointPlan(context, leader.smallID()),
  null,
  "catching up cannot replay the invalidated REQUEST",
);
game.addExecution(new EmojiExecution(leader, me.id(), 17));
game.executeNextTick();
game.executeNextTick();
assert.equal(
  strategy.observeDuo(context)[0].status,
  "ack-pending",
  "only a newer native REQUEST may replace the terminal exchange",
);
game.addExecution(new EmojiExecution(me, leader.id(), 29));
game.executeNextTick();
game.executeNextTick();
const renewed = strategy.getJointPlan(context, leader.smallID());
assert.ok(renewed);
assert.ok(renewed.requestTick > nativeExpiry);
assert.ok(renewed.ackTick >= renewed.requestTick);
// A genuinely new lifecycle is independent of the old session clock barrier.
(game as any)._ticks = 2;
const nextGeneration = { ...context, generation: 1 };
strategy.observeDuo(nextGeneration);
assert.equal(strategy.observe(nextGeneration).enabled, true);
assert.equal(strategy.getJointPlan(nextGeneration, leader.smallID()), null);
(game as any)._ticks = renewed.ackTick;
const spawnSandbox: any = {};
executeClassicScript(readRepositoryFile("engine/ingame/spawn-index.js"), spawnSandbox);
const center = game.ref(40, 40);
const footprint = spawnSandbox.__OFHSpawnIndex.legalFootprint(game, center);
assert.deepEqual(
  Array.from(footprint).sort((a: any, b: any) => a - b),
  getSpawnTiles(game, center).sort((a, b) => a - b),
);
enemy.conquer(game.ref(41, 40));
assert.equal(
  spawnSandbox.__OFHSpawnIndex.legalFootprint(game, center),
  null,
  "free center cannot mask an owned tile in the footprint",
);
// Unknown localized threat does not veto; a live native impact predicate does.
behavior.availableGoldAfterReserve = () => 100n;
behavior.tileInsideActiveHostileMissileImpact = () => false;
me.addGold(100n);
assert.equal(
  strategy.admitEconomicPurchase({
    ...context,
    buildable: { type: UnitType.City, cost: 1n },
    tile: 0,
    reservedGold: 0n,
  }).blocked,
  false,
);
behavior.tileInsideActiveHostileMissileImpact = (tile) => tile === 0;
assert.equal(
  strategy.admitEconomicPurchase({
    ...context,
    buildable: { type: UnitType.City, cost: 1n },
    tile: 0,
    reservedGold: 0n,
  }).reason,
  "incoming-impact",
);
assert.equal(
  strategy.admitEconomicPurchase({
    ...context,
    buildable: { type: UnitType.SAMLauncher, cost: 1000n },
    tile: 0,
    reservedGold: 100n,
  }).scope,
  "unmanaged",
);

const width = 40,
  height = 20,
  grid = Array(width * height).fill(W);
for (let y = 3; y < 17; y++) for (let x = 2; x < 12; x++) grid[y * width + x] = L;
for (let y = 3; y < 17; y++) for (let x = 27; x < 38; x++) grid[y * width + x] = L;
const coast = createCoastalGame({ width, height, grid });
const sailor = coast.addPlayer(new PlayerInfo("sender", PlayerType.Human, null, "sender01"));
for (let y = 3; y < 17; y++) for (let x = 2; x < 12; x++) sailor.conquer(coast.ref(x, y));
sailor.addTroops(20000);
assert.equal(sailor.unitCount(UnitType.Port), 0);
const destination = coast.ref(27, 10);
assert.notEqual(sailor.canBuild(UnitType.TransportShip, destination), false);
const execution = new TransportShipExecution(sailor, destination, 7000);
execution.init(coast, 0);
const boat = sailor.units(UnitType.TransportShip)[0];
assert.equal(boat.troops(), 7000);
const navalContext = { game: coast, player: sailor };
const packed = coast.drainPackedMotionPlans();
assert.ok(packed);
const nativePlans = unpackMotionPlans(packed);
const plans = new Map(
  nativePlans.filter((plan) => plan.kind === "grid").map((plan) => [plan.unitId, plan]),
);
const motion = plans.get(boat.id())!;
assert.ok(motion);
strategy.observeNaval(navalContext, [boat], plans);
assert.equal(
  strategy.transportCommitment(navalContext, boat.id()).arrivalTick,
  motion.startTick + (motion.path.length - 1) * motion.ticksPerStep,
);
const recall = new BoatRetreatExecution(sailor, boat.id());
recall.init(coast, 0);
recall.tick(0);
assert.equal(boat.transportShipState().isRetreating, true);
strategy.observeNaval(navalContext, [boat], plans);
assert.equal(strategy.transportCommitment(navalContext, boat.id()).status, "recalled");
strategy.observeNaval(navalContext, [], new Map());
assert.equal(strategy.transportCommitment(navalContext, boat.id()).status, "unconfirmed");
// Actual Warship refresh caller consumes native units, not a helper-only assertion.
executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/warshipBehavior.js") +
    "\nwindow.Warship=WarshipBehavior;",
  sandbox,
);
const warship = Object.create(sandbox.window.Warship.prototype);
warship.game = coast;
warship.player = sailor;
const patrol = { transportPos: new Map(), losses: [] };
warship.refreshTransportEvents(patrol, coast.ticks(), sailor.smallID());
assert.equal(strategy.transportCommitment(navalContext, boat.id()).status, "recalled");
assert.equal(patrol.losses.length, 0);
// Actual Companion footprint caller rejects the owned ring, no center-only acceptance.
executeClassicScript(readRepositoryFile("engine/ingame/spawn-index.js"), sandbox);
executeClassicScript(
  readRepositoryFile("engine/ingame/companion/actions.js") +
    "\nwindow.spawnCandidate=companionValidSpawnCandidate;",
  sandbox,
);
assert.equal(sandbox.window.spawnCandidate(game, 40, 40), null);
for (let extra = 0; extra < 2; extra++) {
  const launch = new TransportShipExecution(sailor, destination, 500);
  launch.init(coast, 0);
}
assert.equal(sailor.unitCount(UnitType.TransportShip), coast.config().boatMaxNumber());
assert.equal(sailor.canBuild(UnitType.TransportShip, destination), false);
const fourth = new TransportShipExecution(sailor, destination, 500);
fourth.init(coast, 0);
assert.equal(fourth.isActive(), false);
assert.equal(sailor.unitCount(UnitType.Port), 0);

// The subclass observes the inherited bounded worker-probe interface; returned
// affordability/site and price below are calculated by the official engine.
me.addGold(5_000_000n);
behavior.availableGoldAfterReserve = () => me.gold();
behavior.tileInsideActiveHostileMissileImpact = () => false;
(me as any).buildables = async (tile, types) =>
  types.map((type) => ({
    type,
    cost: game.config().unitInfo(type).cost(game, me),
    canBuild: me.canBuild(type, tile),
    canUpgrade: false,
  }));
sandbox.withTimeout = async (promise) => promise;
const threat = enemy.buildUnit(UnitType.AtomBomb, game.ref(79, 80), {
  targetTile: game.ref(80, 80),
  trajectory: [{ tile: game.ref(79, 80), targetable: true }],
});
assert.equal(threat.isActive(), true);
const defensiveQuote = await behavior.buildableFor(UnitType.SAMLauncher, game.ref(80, 80));
assert.equal(defensiveQuote.cost, game.config().unitInfo(UnitType.SAMLauncher).cost(game, me));
assert.notEqual(defensiveQuote.canBuild, false);
const protectedCost = me.gold() - defensiveQuote.cost + 1n;
assert.equal(
  strategy.admitEconomicPurchase({
    ...context,
    buildable: { type: UnitType.Port, cost: protectedCost, canUpgrade: false },
    tile: game.ref(80, 80),
    reservedGold: 0n,
  }).reason,
  "urgent-defense-quote",
);
process.stdout.write("native coastal lifecycle and Warship/Companion callers passed\n");
