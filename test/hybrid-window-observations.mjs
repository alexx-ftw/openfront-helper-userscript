import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

function fixture() {
  const sandbox = { window: {}, state: { settings: { winFixes: true } } };
  executeClassicScript("class StructureBehavior {}", sandbox);
  executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/hybridStrategy.js"), sandbox);
  const api = sandbox.window.__OFH_hybridStrategy;
  api.configure({ enabled: true });
  const state = {
    tick: 10,
    troops: 100,
    alive: true,
    friendly: false,
    outgoing: [],
    players: null,
  };
  const me = {
    smallID: () => 1,
    type: () => "HUMAN",
    isAlive: () => true,
    isFriendly: (p) => p.smallID() === 1 || (p.smallID() === 2 && state.friendly),
    outgoingEmojis: () => [],
    outgoingAttacks: () => [],
  };
  const target = {
    smallID: () => 2,
    type: () => "NATION",
    isAlive: () => state.alive,
    troops: () => state.troops,
    outgoingAttacks: () => state.outgoing,
  };
  const other = {
    smallID: () => 3,
    type: () => "BOT",
    isAlive: () => true,
    troops: () => 50,
    outgoingAttacks: () => [],
  };
  state.players = [me, target, other];
  const game = { ticks: () => state.tick, players: () => state.players };
  const context = { game, player: me };
  const observe = () => {
    api.observeDuo(context);
    return api.describeStrikeWindow(context, 2).observations;
  };
  return { api, state, context, me, target, other, game, observe };
}

function attack(id, targetID, troops, retreating = false) {
  return { id, attackerID: 2, targetID, troops, retreating };
}

function checkDropsAndCommitments() {
  const f = fixture();
  assert.equal(f.observe().troopDropObserved, null);
  f.state.troops = 90;
  assert.equal(f.observe().troopDropObserved, null, "same tick is not a second observation");
  f.state.tick++;
  f.state.troops = 60;
  f.state.outgoing = [attack("us", 1, 20), attack("other", 3, 30), attack("recall", 1, 9, true)];
  let view = f.observe();
  assert.equal(view.status, "observed");
  assert.equal(view.previous.currentTroops, 90);
  assert.equal(view.troopDrop, 30);
  assert.equal(view.visibleCommittedTroops, 50);
  assert.equal(view.incomingFromTarget, 20);
  assert.equal(view.cancellationObserved, true);
  assert.deepEqual(Array.from(view.retreatingCommitmentIDs), ["recall"]);
  view.previous.currentTroops = 900;
  assert.equal(f.observe().troopDrop, 30, "diagnostics cannot mutate history");
  f.state.tick++;
  f.state.outgoing = [attack("us", 1, 20, true)];
  view = f.observe();
  assert.equal(view.incomingFromTarget, 0);
  assert.equal(view.visibleCommittedTroops, 0);
  assert.deepEqual(Array.from(view.disappearedCommitmentIDs), ["other"]);
  assert.deepEqual(Array.from(view.retreatingCommitmentIDs), ["us"]);
  f.state.tick++;
  f.state.outgoing = [];
  view = f.observe();
  assert.equal(view.cancellationObserved, false, "absence is not a cancellation receipt");
  f.state.tick++;
  f.state.troops = 80;
  assert.equal(f.observe().troopDropObserved, false);
  assert.equal(f.observe().troopDrop, 0);
  assert.equal(f.api.describeStrikeWindow(f.context, 1).observations.status, "unknown");
  f.state.tick++;
  f.state.outgoing = [
    {
      __src: {
        id: () => "method-attack",
        attacker: () => ({ ...f.target }),
        target: () => ({ ...f.me }),
        troops: () => 7,
        retreating: () => false,
      },
    },
  ];
  assert.equal(f.observe().incomingFromTarget, 7, "native method attacks resolve endpoints by SID");
}

function checkUnknowns() {
  const f = fixture();
  f.observe();
  for (const bad of [undefined, null, NaN, Infinity, -1, "80"]) {
    f.state.tick++;
    f.state.troops = bad;
    assert.equal(f.observe().status, "unknown");
    f.state.tick++;
    f.state.troops = 50;
    assert.equal(f.observe().troopDropObserved, null, "invalid observation breaks history");
  }
  for (const bad of [
    undefined,
    [attack("bad", 1, NaN)],
    [attack("bad", 1, -1)],
    [{ ...attack("bad", 1, 2), attackerID: 9 }],
    [{ ...attack("bad", 1, 2), retreating: undefined }],
    [attack("same", 1, 1), attack("same", 1, 2)],
    [attack("bad", 99, 2)],
  ]) {
    f.state.tick++;
    f.state.outgoing = bad;
    assert.equal(f.observe().status, "unknown", "malformed commitments are not zero");
    f.state.tick++;
    f.state.outgoing = [];
    assert.equal(f.observe().troopDropObserved, null);
  }
  f.state.tick++;
  f.state.outgoing = [
    attack("overflow1", 1, Number.MAX_VALUE),
    attack("overflow2", 1, Number.MAX_VALUE),
  ];
  assert.equal(f.observe().status, "unknown");
  f.state.players = null;
  assert.equal(f.observe().status, "unknown");
  assert.equal(f.api.diagnostics().windowTargets, 0);
}

function checkIdentityAndEndpoints() {
  const f = fixture();
  f.observe();
  f.state.tick++;
  f.state.troops = 70;
  f.context.game = { __src: f.game, players: () => [f.me] };
  f.context.player = { __src: f.me };
  assert.equal(f.observe().troopDrop, 30, "native list bypasses incomplete wrapper cache");
  f.context.game = { __src: f.game };
  f.context.player = { __src: f.me };
  assert.equal(f.observe().troopDrop, 30, "new wrappers retain stable game/SID history");
  f.state.players = [f.other, { ...f.target }, f.me];
  f.state.tick++;
  f.state.troops = 60;
  assert.equal(f.observe().troopDrop, 10, "player order and wrapper identity do not matter");
  f.state.friendly = true;
  assert.equal(f.observe().status, "unknown");
  f.state.friendly = false;
  assert.equal(f.observe().troopDropObserved, null, "alliance change clears history");
  f.state.alive = false;
  assert.equal(f.api.describeStrikeWindow(f.context, 2).observations.status, "unknown");
  f.state.alive = true;
  assert.equal(f.observe().troopDropObserved, null, "dead target cannot revive old history");
  f.state.players = [f.me, f.other];
  f.observe();
  assert.equal(f.api.diagnostics().windowTargets, 1, "removed player is pruned");
  f.state.players = [f.me, f.target, f.other];
  assert.equal(f.observe().troopDropObserved, null);
  f.state.players = [f.me, f.target, { ...f.target }];
  assert.equal(f.observe().status, "unknown", "duplicate SIDs invalidate authoritative list");
  assert.equal(f.api.diagnostics().windowTargets, 0);
}

function checkClocksAndScopes() {
  const f = fixture();
  f.observe();
  f.state.tick++;
  assert.equal(f.observe().status, "observed");
  f.context.generation = 1;
  assert.equal(f.observe().troopDropObserved, null);
  f.state.tick++;
  assert.equal(f.observe().status, "observed");
  f.state.tick = 9;
  assert.equal(f.observe().status, "unknown");
  f.state.tick = 12;
  assert.equal(f.observe().troopDropObserved, null, "rewind cannot reuse pre-rewind observations");
  f.state.tick++;
  assert.equal(f.observe().status, "observed");
  for (const tick of [undefined, null, "14", NaN, Infinity, -1, 1.5]) {
    f.state.tick = tick;
    assert.equal(f.observe().status, "unknown");
    assert.equal(f.api.diagnostics().windowTargets, 0);
  }
  f.state.tick = 14;
  assert.equal(f.observe().troopDropObserved, null);
  f.api.reset();
  assert.equal(f.api.diagnostics().windowTargets, 0);
  assert.equal(f.observe().troopDropObserved, null);
  f.state.tick++;
  assert.equal(f.observe().status, "observed");
  f.context.sessionId = "fixed";
  f.observe();
  f.state.tick++;
  assert.equal(f.observe().status, "observed");
  f.context.game = { ticks: () => f.state.tick, players: () => f.state.players };
  assert.equal(f.observe().troopDropObserved, null, "new raw game clears even supplied session ID");
  f.context.player = { ...f.me, smallID: () => 3, isFriendly: () => false };
  assert.equal(f.observe().troopDropObserved, null, "actor SID isolates history");
  f.api.configure({ enabled: false });
  assert.equal(f.observe().status, "unknown");
  assert.equal(f.api.diagnostics().windowTargets, 0);
}

function checkExpiredConsent() {
  const f = fixture();
  let requests = [],
    acknowledgements = [];
  const peer = {
    smallID: () => 4,
    type: () => "HUMAN",
    isAlive: () => true,
    outgoingAttacks: () => [{ ...attack("joint", 2, 10), attackerID: 4 }],
    outgoingEmojis: () => requests,
  };
  f.me.isFriendly = (p) => p.smallID() === 1 || p.smallID() === 4;
  f.me.outgoingEmojis = () => acknowledgements;
  f.game.config = () => ({ emojiMessageDuration: () => 5 });
  f.state.players.push(peer);
  f.api.observeDuo(f.context);
  requests = [{ senderID: 4, recipientID: 1, message: "✋", createdAt: 10 }];
  acknowledgements = [{ senderID: 1, recipientID: 4, message: "⏳", createdAt: 10 }];
  assert.ok(f.api.getJointPlan(f.context, 4));
  f.state.tick = 15;
  assert.equal(f.api.getJointPlan(f.context, 4), null, "expiry equality closes confirmed plan");
  f.state.tick = 10;
  assert.equal(f.api.getJointPlan(f.context, 4), null, "rewind cannot revive expired confirmation");
  f.state.tick = 15;
  assert.equal(f.api.getJointPlan(f.context, 4), null, "catch-up does not revive old native feeds");
  f.state.tick = 16;
  requests = [{ senderID: 4, recipientID: 1, message: "✋", createdAt: 16 }];
  acknowledgements = [{ senderID: 1, recipientID: 4, message: "⏳", createdAt: 16 }];
  assert.ok(f.api.getJointPlan(f.context, 4), "fresh native exchange remains supported");
}

function checkBoundedHistoryAndSnapshot() {
  const f = fixture();
  for (let sid = 4; sid < 104; sid++) {
    f.state.tick++;
    f.state.players = [f.me, { ...f.target, smallID: () => sid }];
    f.api.observeDuo(f.context);
    assert.equal(
      f.api.diagnostics().windowTargets,
      1,
      "history follows current players, not past SIDs",
    );
  }
  f.state.players = [f.me, f.target];
  f.state.tick++;
  f.target.troops = () => {
    f.state.tick++;
    return 10;
  };
  assert.equal(f.observe().status, "unknown", "tick drift cannot label a current observation");
  assert.equal(f.api.diagnostics().windowTargets, 0);
  f.target.troops = () => 10;
  f.context.game = { __src: f.game, ticks: () => f.state.tick - 1 };
  assert.equal(f.observe().status, "unknown", "stale wrapper clock cannot stamp native state");
  f.context.game = f.game;
  f.me.isAlive = () => false;
  assert.equal(f.observe().status, "unknown");
  assert.equal(f.api.diagnostics().windowTargets, 0);
  f.me.isAlive = () => true;
  assert.equal(f.observe().troopDropObserved, null);
}

function checkDescribeOnlyClocks() {
  const f = fixture();
  f.observe();
  f.state.tick = 11;
  f.state.troops = 70;
  assert.equal(f.observe().troopDrop, 30);
  const wrapper = { ...f.context, game: { __src: f.game, ticks: () => 11 } };
  assert.equal(f.api.describeStrikeWindow(wrapper, 2).observations.status, "observed");
  f.state.tick = 12;
  assert.equal(
    f.api.describeStrikeWindow(wrapper, 2).observations.status,
    "unknown",
    "describe alone rejects a frozen wrapper clock after native time advances",
  );
  f.api.reset();
  f.state.tick = 20;
  f.observe();
  f.state.tick = 21;
  f.state.troops = 40;
  assert.equal(f.observe().troopDrop, 30);
  const duringRead = { ...f.context, game: { __src: f.game, ticks: () => 21 } };
  f.target.isAlive = () => {
    f.state.tick = 22;
    return true;
  };
  assert.equal(
    f.api.describeStrikeWindow(duringRead, 2).observations.status,
    "unknown",
    "describe rechecks native time after reading endpoint facts",
  );
}

checkDropsAndCommitments();
checkUnknowns();
checkIdentityAndEndpoints();
checkClocksAndScopes();
checkExpiredConsent();
checkBoundedHistoryAndSnapshot();
checkDescribeOnlyClocks();
process.stdout.write("hybrid window observations passed\n");
