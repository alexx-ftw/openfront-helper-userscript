import assert from "node:assert/strict";
import { INGAME_FILES } from "../scripts/build/sources.mjs";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";

const RATE_LIMIT_SOURCE = readRepositoryFile("engine/ingame/intent-rate-limit.js");
const CONTEXT_SOURCE = readRepositoryFile("engine/ingame/auto-bot/context.js");
const WS_HOOK_SOURCE = readRepositoryFile("engine/ingame/ws-hook.js");

function createSandbox() {
  let now = 0;
  const emitted = [];
  const eventBus = { emit: (event) => emitted.push(event) };
  const buildMenu = { eventBus };
  const sandbox = {
    Date: { now: () => now },
    Math,
    Map,
    Number,
    Object,
    String,
    console,
    document: {
      querySelector: (selector) => (selector === "build-menu" ? buildMenu : null),
    },
    window: {},
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(
    `${RATE_LIMIT_SOURCE}\n${CONTEXT_SOURCE}\nglobalThis.__intentTest = { emitIntent, tryAcquireIntentRateLimit, discoverCtors, getIntentRateLimitSnapshot, hasIntentRateLimitCapacity, sendAutoBotBuildOrUpgrade, autoBotBuildReservedGold, autoBotBuildPendingNukes };`,
    sandbox,
    { filename: repositoryFilePath("engine/ingame/intent-rate-limit.js") },
  );
  return {
    api: sandbox.__intentTest,
    eventBus,
    emitted,
    setNow: (value) => {
      now = value;
    },
  };
}

class TestIntent {
  constructor(...args) {
    this.args = args;
  }
}

class TestCancelAttackIntent {
  constructor(attackID) {
    this.attackID = attackID;
  }
}

const cancellationDiscovery = createSandbox();
cancellationDiscovery.eventBus.listeners = new Map([[TestCancelAttackIntent, new Set()]]);
assert.equal(
  cancellationDiscovery.api.discoverCtors(cancellationDiscovery.eventBus).cancelAttack,
  TestCancelAttackIntent,
  "the runtime constructor probe discovers CancelAttackIntentEvent by attackID shape",
);

const perSecond = createSandbox();
for (let i = 0; i < 9; i += 1) {
  assert.equal(
    perSecond.api.emitIntent(TestIntent, i),
    true,
    "the first nine intents in a burst are emitted locally",
  );
}
assert.equal(
  perSecond.api.emitIntent(TestIntent, 9),
  false,
  "the tenth immediate intent is held back for the server's per-second window cap",
);
assert.equal(perSecond.emitted.length, 9);
perSecond.setNow(99);
assert.equal(
  perSecond.api.emitIntent(TestIntent, 10),
  false,
  "less than one tenth of a second must not refill a full token",
);
perSecond.setNow(500);
assert.equal(
  perSecond.api.emitIntent(TestIntent, 11),
  false,
  "mid-window drip-refilled tokens stay unusable inside the same second window (server parity)",
);
perSecond.setNow(1000);
assert.equal(
  perSecond.api.emitIntent(TestIntent, 12),
  true,
  "the next second window admits new intents",
);

const perMinute = createSandbox();
let accepted = 0;
for (let i = 0; i < 300; i += 1) {
  perMinute.setNow(i * 200);
  if (perMinute.api.emitIntent(TestIntent, i)) accepted += 1;
}
assert.equal(accepted, 140, "the per-minute window cap applies across the whole anchored minute");
assert.equal(
  perMinute.api.emitIntent(TestIntent, 300),
  false,
  "the minute window cap must hold until the window rolls over",
);
assert.equal(
  perMinute.api.hasIntentRateLimitCapacity(),
  false,
  "a depleted bucket must be observable without consuming another rejection",
);
perMinute.setNow(59900);
assert.equal(
  perMinute.api.emitIntent(TestIntent, 301),
  false,
  "drip-refilled minute tokens stay unusable inside the same minute window",
);
perMinute.setNow(60000);
assert.equal(
  perMinute.api.emitIntent(TestIntent, 302),
  true,
  "the next minute window admits new intents",
);
assert.equal(
  perMinute.api.hasIntentRateLimitCapacity(),
  true,
  "a freshly rolled window leaves observable capacity for the next producers",
);

const snapshot = perMinute.api.getIntentRateLimitSnapshot();
assert.equal(snapshot.intentsPerSecond, 10);
assert.equal(snapshot.intentsPerMinute, 150);
assert.equal(snapshot.rejected, 0, "a deferring producer never consumes a rejection");

const backpressure = createSandbox();
let deferred = 0;
for (let i = 0; i < 300; i += 1) {
  backpressure.setNow(i * 200);
  if (!backpressure.api.emitIntent(TestIntent, i)) deferred += 1;
}
assert.equal(deferred, 160, "the per-minute window defers everything past the cap");
assert.equal(
  backpressure.api.getIntentRateLimitSnapshot().rejected,
  0,
  "capacity pre-checks observe backpressure without consuming a rejection",
);
assert.equal(
  backpressure.api.tryAcquireIntentRateLimit(),
  false,
  "a direct acquire on the drained bucket is still refused",
);
assert.equal(
  backpressure.api.getIntentRateLimitSnapshot().rejected,
  1,
  "an unhandled acquire attempt is counted as local backpressure",
);

assert.match(
  WS_HOOK_SOURCE,
  /tryAcquireIntentRateLimit\(/,
  "direct WebSocket intent fallback must use the shared budget",
);
const rateLimitIndex = INGAME_FILES.indexOf("engine/ingame/intent-rate-limit.js");
const wsHookIndex = INGAME_FILES.indexOf("engine/ingame/ws-hook.js");
assert.ok(rateLimitIndex >= 0, "the authoritative build inventory includes the shared budget");
assert.ok(wsHookIndex >= 0, "the authoritative build inventory includes the WebSocket bridge");
assert.ok(
  rateLimitIndex < wsHookIndex,
  "the shared budget must be included before the WebSocket bridge in builds",
);

process.stdout.write("INTENT RATE LIMIT OK — 10/s and 150/min client budget enforced\n");

class TestBuildUnitIntent {
  constructor(unit, tile, rocketDirectionUp) {
    this.unit = unit;
    this.tile = tile;
    this.rocketDirectionUp = rocketDirectionUp;
  }
}
class ReplacementBuildUnitIntent extends TestBuildUnitIntent {}
const zeroTile = createSandbox();
for (const Ctor of [TestBuildUnitIntent, ReplacementBuildUnitIntent]) {
  const delivered = [];
  const bus = {
    listeners: new Map([[Ctor, []]]),
    emit(event) {
      if (event.constructor === Ctor) delivered.push(event);
    },
  };
  let hidden = false;
  const acceptedBefore = zeroTile.api.getIntentRateLimitSnapshot().accepted;
  const menu = {
    eventBus: bus,
    uiState: { rocketDirectionUp: false },
    hideMenu() {
      hidden = true;
    },
    sendBuildOrUpgrade(buildable, tile) {
      // Mirrors the upstream BuildMenu's truthiness check.
      if (buildable.canBuild)
        bus.emit(new Ctor(buildable.type, tile, this.uiState.rocketDirectionUp));
      this.hideMenu();
    },
  };
  assert.equal(
    zeroTile.api.sendAutoBotBuildOrUpgrade(
      menu,
      { type: "Atom Bomb", canBuild: 0, canUpgrade: false, cost: 100n },
      0,
      { ticks: () => 0 },
      { id: () => "zero", gold: () => 100n },
    ),
    true,
  );
  assert.equal(
    delivered.length,
    1,
    `${Ctor.name}: tile zero must emit exactly one build on the current event bus`,
  );
  assert.equal(delivered[0].tile, 0);
  assert.equal(delivered[0].unit, "Atom Bomb");
  assert.equal(delivered[0].rocketDirectionUp, false);
  assert.equal(hidden, true);
  assert.equal(zeroTile.api.getIntentRateLimitSnapshot().accepted, acceptedBefore + 1);
}

const construction = createSandbox();
{
  const nuclear = createSandbox();
  let tick = 0;
  const game = { ticks: () => tick };
  const missiles = [];
  const missile = (id, target = 12) => ({ id: () => id, targetTile: () => target });
  missiles.push(missile(1));
  const player = {
    id: () => "nuclear",
    gold: () => 1_000n,
    units: (type) => (type === "Atom Bomb" ? missiles : []),
  };
  const buildable = { type: "Atom Bomb", cost: 1n };
  const menu = { sendBuildOrUpgrade() {} };
  const pending = () => nuclear.api.autoBotBuildPendingNukes(game, player);
  assert.equal(
    nuclear.api.sendAutoBotBuildOrUpgrade(menu, buildable, 12, game, player, { salvoId: 7 }),
    true,
  );
  assert.equal(
    pending()[0].salvoId,
    7,
    "the shared dispatch ledger retains nuclear salvo identity",
  );
  assert.equal(
    pending().length,
    1,
    "an old missile at the same target cannot acknowledge a new intent",
  );
  // Give the second accepted dispatch native capacity without exercising source projection here.
  player.units = (type) =>
    type === "Atom Bomb"
      ? missiles
      : [{ id: () => 9, level: () => 3, missileTimerQueue: () => [], tile: () => 0 }];
  game.manhattanDist = (a, b) => Math.abs(a - b);
  assert.equal(
    nuclear.api.sendAutoBotBuildOrUpgrade(menu, buildable, 12, game, player, true),
    true,
  );
  missiles.push(missile(2, 99));
  assert.equal(pending().length, 2, "another destination cannot acknowledge the prefix");
  assert.equal(
    pending()[1].salvoId,
    null,
    "ordinary nuclear intents cannot inherit a salvo identity",
  );
  missiles.push(missile(3));
  assert.equal(pending().length, 1, "one receipt acknowledges only one of two identical intents");
  assert.equal(pending().length, 1, "repeated reconciliation cannot reuse a claimed receipt");
  assert.equal(nuclear.api.autoBotBuildPendingNukes({}, player).length, 0);
  assert.equal(nuclear.api.autoBotBuildPendingNukes(game, { id: () => "other" }).length, 0);
  missiles.push(missile(4));
  assert.equal(pending().length, 0);
  assert.equal(
    nuclear.api.autoBotBuildReservedGold(game, player),
    2n,
    "missile acknowledgement does not release the independent gold grace",
  );
  const syncMenu = {
    sendBuildOrUpgrade() {
      missiles.push(missile(5));
    },
  };
  assert.equal(
    nuclear.api.sendAutoBotBuildOrUpgrade(syncMenu, buildable, 12, game, player, true),
    true,
  );
  assert.equal(pending().length, 0, "IDs are sampled before even a synchronous dispatch");
  assert.equal(
    nuclear.api.sendAutoBotBuildOrUpgrade(
      menu,
      { ...buildable, cost: 2_000n },
      12,
      game,
      player,
      true,
    ),
    false,
  );
  assert.equal(pending().length, 0, "rejected purchases create no nuclear reservation");
  assert.equal(
    nuclear.api.sendAutoBotBuildOrUpgrade(menu, buildable, 12, game, player, true),
    true,
  );
  tick = 5;
  assert.equal(pending().length, 1);
  tick = 6;
  assert.equal(pending().length, 0, "nuclear occupancy expires at the existing grace boundary");
  tick = 10;
  assert.equal(
    nuclear.api.sendAutoBotBuildOrUpgrade(menu, buildable, 12, game, player, true),
    true,
  );
  tick = 11;
  assert.equal(
    nuclear.api.sendAutoBotBuildOrUpgrade(menu, buildable, 12, game, player, true),
    true,
  );
  missiles.push(missile(6));
  assert.equal(pending().length, 1);
  tick = 16;
  assert.equal(
    pending().length,
    1,
    "an expired earlier claim cannot acknowledge a later intent again",
  );
}
let constructionTick = 100;
const purchases = [];
const constructionMenu = {
  sendBuildOrUpgrade: (...args) => purchases.push(args),
};
const constructionGame = { ticks: () => constructionTick };
const constructionPlayer = { id: () => "bot", gold: () => 1_000_000n };
for (const cost of [-1n, -1]) {
  assert.equal(
    construction.api.sendAutoBotBuildOrUpgrade(
      constructionMenu,
      { cost },
      12,
      constructionGame,
      constructionPlayer,
    ),
    false,
    "negative costs must not credit the shared purchase budget",
  );
}
assert.equal(
  construction.api.sendAutoBotBuildOrUpgrade(
    constructionMenu,
    { cost: 1n },
    12,
    null,
    constructionPlayer,
  ),
  false,
  "a purchase without a game context cannot acquire a reservation",
);
assert.equal(
  construction.api.sendAutoBotBuildOrUpgrade(
    constructionMenu,
    { cost: 750_000n },
    12,
    constructionGame,
    constructionPlayer,
  ),
  true,
  "the first exact-cost construction reserves its gold",
);
assert.equal(
  construction.api.sendAutoBotBuildOrUpgrade(
    constructionMenu,
    { cost: 500_000n },
    13,
    constructionGame,
    constructionPlayer,
  ),
  false,
  "a second build cannot spend gold already committed by another bot phase",
);
assert.equal(purchases.length, 1, "only the affordable construction reaches the build menu");
assert.equal(
  construction.api.autoBotBuildReservedGold(constructionGame, constructionPlayer),
  750_000n,
);
assert.equal(
  construction.api.autoBotBuildReservedGold(constructionGame, { id: () => "other" }),
  0n,
);
assert.equal(
  construction.api.autoBotBuildReservedGold({ ticks: () => 100 }, constructionPlayer),
  0n,
);
const replayGame = { ticks: () => 0 };
assert.equal(
  construction.api.sendAutoBotBuildOrUpgrade(
    constructionMenu,
    { cost: 500_000n },
    14,
    replayGame,
    constructionPlayer,
  ),
  true,
  "a new game with the same player ID must not inherit the previous game's gold reservation",
);
assert.equal(
  construction.api.sendAutoBotBuildOrUpgrade(
    constructionMenu,
    { cost: 500_000n },
    13,
    constructionGame,
    constructionPlayer,
  ),
  false,
  "switching games must not release an outstanding purchase in the original game",
);
constructionTick += 6;
assert.equal(construction.api.autoBotBuildReservedGold(constructionGame, constructionPlayer), 0n);
assert.equal(
  construction.api.sendAutoBotBuildOrUpgrade(
    constructionMenu,
    { cost: 500_000n },
    13,
    constructionGame,
    constructionPlayer,
  ),
  true,
  "the reservation expires on the exact client intent grace boundary",
);
