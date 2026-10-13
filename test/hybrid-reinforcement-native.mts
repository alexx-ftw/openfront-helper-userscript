import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game.ts";
import { Config } from "../openfront-engine/src/core/configuration/Config.ts";
import { createGame as createGameImpl } from "../openfront-engine/src/core/game/GameImpl.ts";
import { createGame, L } from "../openfront-engine/tests/core/pathfinding/_fixtures.ts";
import { GameRunner } from "../openfront-engine/src/core/GameRunner.ts";
import { SpawnExecution } from "../openfront-engine/src/core/execution/SpawnExecution.ts";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager.ts";
import { foreignGitEnvironment } from "../scripts/git-environment.mjs";

const expectedRevision = "f372cdf9451cd8c3dc113aaaf8641e2609e2d3cb";
const revision = execFileSync("git", ["-C", "openfront-engine", "rev-parse", "HEAD"], {
  encoding: "utf8",
  env: foreignGitEnvironment(),
}).trim();
assert.equal(revision, expectedRevision, "use the inspected official engine revision");
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const engineDiffSHA = digest(
  execFileSync("git", ["-C", "openfront-engine", "diff", "HEAD", "--binary"], {
    env: foreignGitEnvironment(),
  }),
);
// Bounds and map size come from hybrid-runtime-native.mts: 2000 immunity ticks,
// 160 remaining-commitment ticks, 32x16 land. A bound fails; it never labels a loss.
const limits = { immunityTicks: 2000, receiptTicks: 2, commitmentTicks: 160 };
const terrain = createGame({ width: 32, height: 16, grid: Array(512).fill(L) });
// This pinned engine calls its production DefaultConfig implementation Config.
const game = createGameImpl(
  [],
  [],
  terrain.map(),
  terrain.miniMap(),
  new Config(terrain.config().gameConfig(), null, false, false),
);
const seed = "n5-native-reinforcement";
function spawn(info: PlayerInfo, tile: number) {
  const player = game.addPlayer(info);
  const execution = new SpawnExecution(seed, info, tile);
  execution.init(game, game.ticks());
  execution.tick(game.ticks());
  assert.equal(player.hasSpawned(), true);
  for (const owned of [...player.tiles()]) player.relinquish(owned);
  return player;
}
const me = spawn(new PlayerInfo("actor", PlayerType.Human, "actor001", "actor001"), game.ref(8, 8));
const target = spawn(
  new PlayerInfo("target", PlayerType.Nation, null, "target01"),
  game.ref(24, 8),
);
// Explicit fixture overrides: replace spawn territories with two adjacent halves;
// after native immunity, set own troops to 100000 and defender troops to 10000.
// Native production/combat remain active; neither player has strategic AI.
for (let y = 0; y < 16; y++)
  for (let x = 0; x < 32; x++) (x < 16 ? me : target).conquer(game.ref(x, y));
let failure: string | undefined;
let turn = 0;
const runner = new GameRunner(game, new Executor(game, seed, "actor001"), (update) => {
  if ("errMsg" in update) failure = update.errMsg;
});
function advance(troops?: number) {
  runner.addTurn({
    turnNumber: turn++,
    intents:
      troops === undefined
        ? []
        : [{ type: "attack", troops, targetID: target.id(), clientID: "actor001" }],
  });
  assert.equal(runner.executeNextTick(), true);
  assert.equal(failure, undefined);
}
for (let i = 0; game.isNationSpawnImmunityActive() && i < limits.immunityTicks; i++) advance();
assert.equal(game.isNationSpawnImmunityActive(), false);
me.removeTroops(me.troops());
me.addTroops(100000);
target.removeTroops(target.troops());
target.addTroops(10000);

// Observer-only Ridge adapter: IDs, commitments, pressure, shares, ticks and
// labels are native. Reserve/floor are zero fixture inputs, not sender parity.
// shortcut: no compact geometry or sender guard proof, use the full bridge for that coverage.
const sandbox = {
  window: { localStorage: undefined },
  state: { settings: { winFixes: true } },
  PlayerType,
};
vm.createContext(sandbox);
const policySource = fs.readFileSync(
  new URL("../engine/ingame/auto-bot/hybridCombat.js", import.meta.url),
  "utf8",
);
// Only the policy classic script is evaluated; no executable test imports.
vm.runInContext(policySource, sandbox);
const policy = vm.runInContext("hybridCombatPolicy", sandbox);
const behavior = {
  player: me,
  game,
  currentAttackDecisionTick: () => game.ticks(),
  getOutboundAttackSnapshot: () =>
    me
      .outgoingAttacks()
      .filter((attack) => attack.sourceTile() === null)
      .map((attack) => ({
        id: attack.id(),
        troops: attack.troops(),
        target: attack.target(),
        targetKey: String(attack.target().smallID()),
      })),
  getOutboundTransportSnapshot: () => [],
  botAttackPendingIntentCommitments: [],
  botPendingDonationIntentCommitments: [],
  outboundTransportTargets: new Map(),
  getEarlyGameLiveReserveTroops: () => 0,
  getPlayerAttackPreferredTroopFloor: () => 0,
  incomingHostileAttackPressure: () => {
    const incoming = me
      .incomingAttacks()
      .filter((attack) => !me.isFriendly(attack.attacker()))
      .reduce((sum, attack) => sum + attack.troops(), 0);
    return incoming === 0 ? 0 : incoming / me.troops();
  },
};
const outcomes = () => policy.ledger.filter((row) => row.kind === "outcome");
const beforeSamples = { ...policy.diagnostics().samples };
const beforeModel = JSON.stringify(policy.exportModel());
const beforeActWeights = Array.from(policy.exportModel().models.act.weights);
const beforeTargetWeights = Array.from(policy.exportModel().models.target.weights);
const beforeOutcomes = outcomes().length;
function assertNoLearning() {
  assert.deepEqual({ ...policy.diagnostics().samples }, beforeSamples);
  assert.equal(JSON.stringify(policy.exportModel()), beforeModel);
  assert.equal(outcomes().length, beforeOutcomes);
  assert.equal(policy.lastOutcome, null);
}
// Ordinary order goes through the actual official Executor -> AttackExecution.
advance(20000);
for (let i = 0; me.outgoingAttacks().length === 0 && i < limits.receiptTicks; i++) advance();
assert.equal(me.outgoingAttacks().length, 1);
const oldAttack = me.outgoingAttacks()[0];
const oldID = oldAttack.id();
const oldTroops = oldAttack.troops();
const observation = policy.actionObservation(behavior, target);
assert.ok(observation, "visible native commitment permits reinforcement observation");
assert.deepEqual(Array.from(observation.attackIds), [String(oldID)]);
assert.equal(observation.preexistingCommitmentTroops, oldTroops);
assert.equal(observation.commitmentScope, "remaining-target-commitment");
// Capture at the emission boundary; native admission is verified below.
policy.recordAcceptedAction(behavior, target, observation, policy.generation);
policy.observe(behavior);
assert.equal(Boolean(policy.pending.confirmed), false, "old ID cannot confirm reinforcement");
assertNoLearning();
advance(20000);
const replacements = me.outgoingAttacks();
assert.equal(replacements.length, 1, "native reinforcement absorbs the old attack");
const replacement = replacements[0];
const newID = replacement.id();
assert.notEqual(newID, oldID, "reinforcement has a genuinely new observable native ID");
assert.equal(
  replacements.some((attack) => attack.id() === oldID),
  false,
);
assert.equal(oldAttack.isActive(), false, "old native attack is deleted");
// Existing executions tick before new execution init, so absorbed troops may
// differ from the capture-time amount. Both values are read from the engine.
assert.equal(replacement.troops(), oldAttack.troops() + 20000);
policy.observe(behavior);
assert.equal(policy.pending.confirmed, true);
assert.equal(policy.pending.receiptID, String(newID));
assert.equal(policy.ledger.filter((row) => row.kind === "receipt").length, 1);
assertNoLearning();
let liveTicks = 0;
for (let i = 0; policy.pending && i < limits.commitmentTicks; i++) {
  advance();
  const liveCommitment = behavior
    .getOutboundAttackSnapshot()
    .filter((attack) => attack.targetKey === String(target.smallID()))
    .reduce((sum, attack) => sum + attack.troops, 0);
  policy.observe(behavior);
  if (target.isAlive() && liveCommitment > 0) {
    liveTicks++;
    assert.ok(policy.pending, "remaining native target commitment prevents early outcome");
    assertNoLearning();
  }
}
assert.ok(liveTicks > 0, "observe a live replacement beyond the admission tick");
assert.equal(policy.pending, null, "native remaining commitment ends within fixture bound");
assert.ok(
  !target.isAlive() || behavior.getOutboundAttackSnapshot().length === 0,
  "native target death or exhausted attacks ends the remaining target war",
);
assert.equal(outcomes().length, beforeOutcomes + 1);
const outcome = policy.lastOutcome;
assert.equal(outcome.confirmed, true);
assert.equal(outcome.receiptID, String(newID));
assert.equal(outcome.preexistingCommitmentTroops, oldTroops);
assert.equal(outcome.commitmentScope, "remaining-target-commitment");
assert.equal(outcome.actionTick, observation.tick);
assert.equal(outcome.outcomeTick, game.ticks());
assert.equal(outcome.reward, me.numTilesOwned() / game.numLandTiles() - observation.share);
assert.equal(outcome.terminal, false);
assert.equal(outcome.truncated, false);
assert.equal(policy.diagnostics().samples.act, beforeSamples.act + 1);
assert.equal(policy.diagnostics().samples.target, beforeSamples.target + 1);
assert.equal(policy.diagnostics().samples.wait, beforeSamples.wait);
assert.notDeepEqual(Array.from(policy.exportModel().models.act.weights), beforeActWeights);
assert.notDeepEqual(Array.from(policy.exportModel().models.target.weights), beforeTargetWeights);
process.stdout.write(
  JSON.stringify({
    revision,
    engineDiffSHA,
    policySHA: digest(policySource),
    limits,
    oldID,
    newID,
    oldTroops,
    absorbedTroops: oldAttack.troops(),
    liveTicks,
    finalTick: game.ticks(),
    outcome,
    limitation:
      "Ridge observer only; no full-match, strength, compact geometry or sender-guard parity; reward is own-land-share delta over remaining target war, not marginal causal reinforcement",
  }) + "\n",
);
