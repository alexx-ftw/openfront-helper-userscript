// Warship micromanagement unit checks: veterancy-weighted battle simulation,
// per-ship retreat anchors (including the portless fallback), and the
// trade-hunt leash that refuses prey shadowed by hostile warships. These are
// policy-level checks against synthetic unit stubs; the integrated targeting
// behavior is covered end-to-end by test/warship-target-selection-fixture.mts
// against the real engine.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const UNIT = { TransportShip: "Transport", TradeShip: "Trade", Warship: "Warship", Port: "Port" };
const sandbox = {
  UNIT,
  state: {
    settings: { winFixes: true, warshipEvade: true },
    stats: { builds: 0 },
  },
  WORKER_TIMEOUT_MS: 100,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  setLastAction() {},
  tr: (value) => value,
  console,
  Math,
  Number,
  Array,
  Object,
  Map,
  Set,
  Infinity,
  NaN,
  undefined,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${read("engine/ingame/auto-bot/naval-interception.js")}\n${read(
    "engine/ingame/auto-bot/warshipBehavior.js",
  )}\nglobalThis.__WarshipBehavior = WarshipBehavior;`,
  sandbox,
  { filename: "warship-micro.vm.js" },
);

const makeGame = (overrides = {}) => ({
  ticks: () => 100,
  config: () => ({ isUnitDisabled: () => false }),
  manhattanDist: (a, b) => Math.abs(Number(a) - Number(b)),
  forEachNeighbor: (tile, visit) => {
    visit(Number(tile) + 1);
  },
  isWater: () => true,
  getWaterComponent: () => 1,
  ...overrides,
});

// ── Veterancy-weighted battle simulation ────────────────────────────────────
{
  const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
  behavior.game = makeGame({ config: () => ({ warshipVeterancyShellDamageBonus: () => 20 }) });
  const greenShip = (hp) => ({
    health: () => hp,
    veterancy: () => 0,
    maxHealth: () => 1000,
    tile: () => 100,
  });
  const veteranShip = (hp) => ({
    health: () => hp,
    veterancy: () => 10,
    maxHealth: () => 1000,
    tile: () => 100,
  });
  // Equal hull counts: the flat model called this a comfortable win; with
  // veterancy weighting the veterans' 3x damage each flips the verdict.
  const flatVerdict = behavior.simulateBattle(
    [greenShip(1000), greenShip(1000), greenShip(1000)],
    [greenShip(1000), greenShip(1000)],
    1000,
    null,
  );
  assert.equal(flatVerdict.win, true, "three green hulls still beat two green hulls");
  const veteranVerdict = behavior.simulateBattle(
    [greenShip(1000), greenShip(1000), greenShip(1000)],
    [veteranShip(1000), veteranShip(1000)],
    1000,
    null,
  );
  assert.equal(
    veteranVerdict.win,
    false,
    "two high-veterancy hulls beat three green hulls once shell damage is weighted",
  );
  assert.equal(
    behavior.battleFleetUnitPower(veteranShip(1000), 20),
    3,
    "veterancy power scales as 1 + veterancy * bonusPercent / 100",
  );
  assert.equal(
    behavior.battleFleetUnitPower({ health: () => 5 }, 20),
    1,
    "units without an exposed veterancy stay at neutral power",
  );
}

// ── Per-ship retreat anchors ────────────────────────────────────────────────
{
  const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
  behavior.game = makeGame();
  const ship = { tile: () => 10 };
  const distantShip = { tile: () => 5000 };
  const nearPort = { tile: () => 14 };
  const farPort = { tile: () => 4990 };
  assert.equal(
    behavior.combatRetreatTarget(ship, [nearPort, farPort], []),
    15,
    "a ship retreats to the water tile beside ITS nearest port",
  );
  assert.equal(
    behavior.combatRetreatTarget(distantShip, [nearPort, farPort], []),
    4991,
    "a ship on the far side of the map no longer crosses it to the fleet's shared anchor",
  );
  assert.equal(
    behavior.combatRetreatTarget(ship, [], []),
    null,
    "with no ports and no enemies there is nowhere to retreat to",
  );
  const waypoint = behavior.combatRetreatTarget(ship, [], [{ tile: () => 12 }]);
  assert.ok(
    waypoint !== null && waypoint !== undefined,
    "a portless wounded ship still breaks contact via a safe waypoint",
  );
}

// ── Trade-hunt leash ────────────────────────────────────────────────────────
{
  const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
  behavior.game = makeGame();
  const hunter = { tile: () => 100 };
  const prey = { tile: () => 140 };
  const escortNearPrey = { tile: () => 150 };
  const escortFarAway = { tile: () => 900 };
  assert.equal(
    behavior.tradeHuntTarget(hunter, [prey], [escortFarAway]),
    140,
    "an unescorted trade ship remains a valid hunt target",
  );
  assert.equal(
    behavior.tradeHuntTarget(hunter, [prey], [escortNearPrey]),
    null,
    "a trade ship shadowed by a hostile warship within 30 tiles is not chased",
  );
  assert.equal(
    behavior.tradeHuntTarget(hunter, [], [escortNearPrey]),
    null,
    "no prey means no hunt",
  );
}

// ── Move-intent pacing (shared budget protection) ───────────────────────────
{
  let intentSnapshot = null;
  sandbox.getIntentRateLimitSnapshot = () => intentSnapshot;
  const makePacingBehavior = () => {
    const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
    behavior.game = makeGame();
    behavior.moveWarship = () => true;
    return behavior;
  };
  const pacingShip = {
    id: () => "pacing-1",
    tile: () => 10,
    health: () => 10,
    maxHealth: () => 100,
    warshipState: () => ({ patrolTile: 999 }),
  };
  const pacingState = {
    invasionAssignments: new Map(),
    cooldown: new Map(),
    lastMoveTargets: new Map(),
  };
  const pacingContext = (overrides = {}) => ({
    smartState: pacingState,
    friendlyPorts: [{ tile: () => 14, isActive: () => true, isUnderConstruction: () => false }],
    enemyWarships: [],
    myWarships: [pacingShip],
    enemyTradeShips: [],
    maxHp: 100,
    retreatPct: 0.5,
    huntTrade: false,
    ...overrides,
  });

  // No limiter in most sandboxes: moves flow.
  let moves = 0;
  const freeBehavior = makePacingBehavior();
  freeBehavior.moveWarship = () => {
    moves++;
    return true;
  };
  freeBehavior.handleWarshipCombat(pacingShip, pacingContext());
  assert.equal(moves, 1, "without a rate limiter the first combat move is emitted");

  // Hysteresis: a near-identical target keeps the standing order.
  pacingState.cooldown.clear();
  freeBehavior.handleWarshipCombat(pacingShip, pacingContext());
  assert.equal(moves, 1, "a target within the hysteresis radius does not re-task the ship");

  // A genuinely different target (the far port) re-tasks.
  pacingState.cooldown.clear();
  freeBehavior.handleWarshipCombat(
    pacingShip,
    pacingContext({ friendlyPorts: [{ tile: () => 400, isActive: () => true }] }),
  );
  assert.equal(moves, 2, "a target beyond the hysteresis radius re-tasks the ship");

  // The per-pass cap stops later ships once the pass budget is spent.
  const cappedBehavior = makePacingBehavior();
  let cappedMoves = 0;
  cappedBehavior.moveWarship = () => {
    cappedMoves++;
    return true;
  };
  pacingState.cooldown.clear();
  pacingState.lastMoveTargets.clear();
  cappedBehavior.handleWarshipCombat(
    pacingShip,
    pacingContext({ movesIssued: 2, friendlyPorts: [{ tile: () => 800, isActive: () => true }] }),
  );
  assert.equal(cappedMoves, 0, "a combat pass emits at most its capped number of moves");

  // A drained shared budget leaves the reserve for non-warship producers.
  intentSnapshot = { secondTokens: 9, minuteTokens: 10 };
  pacingState.cooldown.clear();
  pacingState.lastMoveTargets.clear();
  const drainedBehavior = makePacingBehavior();
  let drainedMoves = 0;
  drainedBehavior.moveWarship = () => {
    drainedMoves++;
    return true;
  };
  drainedBehavior.handleWarshipCombat(pacingShip, pacingContext());
  assert.equal(drainedMoves, 0, "warship moves stop when the minute-token reserve is breached");

  intentSnapshot = { secondTokens: 9, minuteTokens: 120 };
  pacingState.cooldown.clear();
  pacingState.lastMoveTargets.clear();
  drainedBehavior.handleWarshipCombat(pacingShip, pacingContext());
  assert.equal(drainedMoves, 1, "a healthy budget admits the warship move again");
  delete sandbox.getIntentRateLimitSnapshot;
}

// ── Nuke-dodge pacing (survival-critical but budget-aware) ──────────────────
{
  sandbox.discoverCtors = () => ({ moveWarship: {} });
  sandbox.getEventBus = () => ({});
  let dodgeEmits = 0;
  sandbox.emitIntent = () => {
    dodgeEmits++;
    return true;
  };
  const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
  behavior.game = makeGame({
    x: (tile) => Number(tile),
    y: () => 0,
    manhattanDist: (a, b) => Math.abs(Number(a) - Number(b)),
  });
  behavior.findNukeEscapeTile = () => ({ tile: 100, eta: 10 });
  const dodgeShip = { id: () => "dodge-1", tile: () => 50, warshipState: () => ({}) };
  const dodgeState = {
    invasionAssignments: new Map(),
    cooldown: new Map(),
    lastDodgeMoves: new Map(),
  };
  const zones = [{ tx: 5, ty: 0, r2: 100, eta: 5 }];
  const coveredEta = () => 5;

  behavior.dodgeWarshipFromNukes(dodgeShip, zones, coveredEta, dodgeState, 100);
  assert.equal(dodgeEmits, 1, "the first dodge order is emitted immediately");

  behavior.dodgeWarshipFromNukes(dodgeShip, zones, coveredEta, dodgeState, 101);
  assert.equal(
    dodgeEmits,
    1,
    "a near-identical escape tile within the cooldown is not re-sent every tick",
  );

  behavior.findNukeEscapeTile = () => ({ tile: 500, eta: 20 });
  behavior.dodgeWarshipFromNukes(dodgeShip, zones, coveredEta, dodgeState, 102);
  assert.equal(dodgeEmits, 2, "a genuinely different escape tile bypasses the cooldown");

  sandbox.getIntentRateLimitSnapshot = () => ({ secondTokens: 5, minuteTokens: 3 });
  behavior.findNukeEscapeTile = () => ({ tile: 900, eta: 30 });
  behavior.dodgeWarshipFromNukes(dodgeShip, zones, coveredEta, dodgeState, 103);
  assert.equal(dodgeEmits, 2, "a drained minute budget blocks even the dodge re-task");
  delete sandbox.getIntentRateLimitSnapshot;
  delete sandbox.emitIntent;
  delete sandbox.getEventBus;
  delete sandbox.discoverCtors;
}

process.stdout.write("warship micro tests passed\n");
