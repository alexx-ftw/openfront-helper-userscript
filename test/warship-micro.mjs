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
const UNIT = {
  TransportShip: "Transport",
  TradeShip: "Trade",
  Warship: "Warship",
  Port: "Port",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  City: "City",
};
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
  BigInt,
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

// ── Trade-owner attackability ────────────────────────────────────────────────
{
  const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
  const me = {
    isFriendly: () => false,
    canAttackPlayer: (owner) => owner.attackable === true,
  };
  behavior.player = me;
  assert.equal(
    behavior.canWarshipHuntOwner({ isPlayer: () => true, attackable: false }),
    false,
    "a diplomatically unattackable trade owner is not a hunt target",
  );
  assert.equal(
    behavior.canWarshipHuntOwner({ isPlayer: () => true, attackable: true }),
    true,
    "an attackable trade owner remains a hunt target",
  );
}

// ── Pirate-immunity anchor filtering ────────────────────────────────────────
{
  const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
  behavior.game = makeGame({
    units: () => [
      // Recently shoreline-tagged: still immune, must not consume an anchor slot.
      { tile: () => 10, lastSetSafeFromPirates: () => 95 },
      // Immunity expired long ago: valid lane.
      { tile: () => 20, lastSetSafeFromPirates: () => 40 },
      // No immunity signal available: eligible (older clients/replays).
      { tile: () => 60 },
    ],
    x: (tile) => tile,
    y: () => 0,
  });
  behavior.openWaterTileNear = (x) => x;
  behavior.nearestOpenWaterTile = () => null;
  const anchors = behavior.liveTradeRaidAnchors();
  assert.equal(anchors.length, 2, "immune traffic does not consume anchor slots");
  assert.equal(anchors[0], 20, "expired-immunity traffic anchors first");
  assert.equal(anchors[1], 60, "traffic without an immunity signal still anchors");
}

// ── Pre-veterancy raid bootstrap ─────────────────────────────────────────────
{
  const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
  const ships = [
    { id: () => 1, veterancy: () => 0, warshipState: () => ({ patrolTile: undefined }) },
    { id: () => 2, veterancy: () => 1, warshipState: () => ({ patrolTile: undefined }) },
  ];
  behavior.player = { units: () => ships };
  const state = { cooldown: new Map(), invasionAssignments: new Map(), raidFlagshipId: null };
  const available = behavior.collectIdleRaidShips(state, 100, new Map([[20, 0]]));
  assert.equal(available.length, 2, "all green hulls can bootstrap commerce raids before level 3");
  assert.equal(
    available[0].id(),
    2,
    "the highest-veterancy hull leads the commerce candidate order",
  );
  assert.equal(available[1].id(), 1, "green hulls follow the flagship in candidate order");
  ships[1].veterancy = () => 3;
  state.raidFlagshipId = "2";
  const afterPromotion = behavior.collectIdleRaidShips(state, 100, new Map([[20, 0]]));
  assert.equal(afterPromotion.length, 1, "the level-3 flagship is protected after promotion");
  assert.equal(afterPromotion[0].id(), 1);
}

// ── Defense subfleet selection (Legendary commerce arbitration) ─────────────
{
  sandbox.currentDifficulty = () => "Legendary";
  const raidState = () => ({
    cooldown: new Map(),
    invasionAssignments: new Map(),
    raidFlagshipId: null,
    defenseSubfleetIds: new Set(),
    defenseSubfleetSignature: null,
    warshipFleetEverBuilt: false,
  });
  const raidShip = (id, tile, veterancy = 0, options = {}) => ({
    id: () => id,
    tile: () => tile,
    veterancy: () => veterancy,
    isActive: () => true,
    isUnderConstruction: () => false,
    warshipState: () => ({
      patrolTile: undefined,
      veterancy: options.progress ?? 0,
      veterancyProgress: (options.progress ?? 0) * 10,
    }),
  });
  const makeDefenseBehavior = ({ fleet, sams = [] }) => {
    const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
    const port = { tile: () => 0, isActive: () => true, isUnderConstruction: () => false };
    behavior.game = makeGame();
    behavior.player = {
      smallID: () => 1,
      units: (type) => {
        const pools = {
          [UNIT.Warship]: fleet,
          [UNIT.Port]: [port],
          [UNIT.SAMLauncher]: sams,
        };
        return pools[type] ?? [];
      },
    };
    behavior.friendlyCombatPorts = () => [port];
    return behavior;
  };

  // Reserve sizes: single-hunter concentration — all but one hull defends.
  for (const [n, expected] of [
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
    [5, 4],
    [6, 5],
    [7, 6],
    [8, 7],
    [9, 8],
    [10, 9],
  ]) {
    const fleet = Array.from({ length: n }, (_, i) => raidShip(i + 1, 100 + i));
    const behavior = makeDefenseBehavior({ fleet });
    const s = raidState();
    const defenseIds = behavior.commerceDefenseSubfleetIds(s);
    assert.equal(defenseIds.size, expected, `fleet of ${n} reserves ${expected} defense hulls`);
    const idle = behavior.collectIdleRaidShips(s, 100, new Map([[500, 0]]));
    assert.equal(idle.length, n - expected, `fleet of ${n} leaves ${n - expected} commerce hulls`);
  }

  // Adaptive hunter escalation: late game + heavy traffic + large fleet
  // opens a second lane; a capture deficit opens a third; the hostile
  // defense floor clamps escalation back.
  {
    const trafficUnits = (traffic) => Array.from({ length: traffic }, () => ({ tile: () => 1 }));
    const hostileUnits = (hostile) =>
      Array.from({ length: hostile }, () => ({
        isActive: () => true,
        owner: () => ({ isPlayer: () => true }),
      }));
    const escalationGame = ({ tick, traffic, hostile }) => ({
      ticks: () => tick,
      manhattanDist: (a, b) => Math.abs(Number(a) - Number(b)),
      units: (type) => {
        const pools = {
          [UNIT.TradeShip]: trafficUnits(traffic),
          [UNIT.Warship]: hostileUnits(hostile),
        };
        return pools[type] ?? [];
      },
    });
    const makeAdaptive = ({ fleet, tick, traffic, hostile, progress = 0 }) => {
      const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
      behavior.game = escalationGame({ tick, traffic, hostile });
      behavior.player = {
        smallID: () => 1,
        units: (type) => (type === UNIT.Warship ? fleet : []),
        isFriendly: () => false,
      };
      behavior.friendlyCombatPorts = () => [];
      const s = raidState();
      s.commerceCaptureEstimate = progress;
      s.commerceCaptureEstimateAtTick = tick;
      return { behavior, s };
    };
    const fleetOf = (n, progress = 0) =>
      Array.from({ length: n }, (_, i) => raidShip(i + 1, 100 + i, 0, { progress }));

    // Escalation: 8 hulls, late game, heavy traffic, capture far behind.
    const escalated = makeAdaptive({
      fleet: fleetOf(8),
      tick: 9000,
      traffic: 200,
      hostile: 0,
      progress: 5,
    });
    assert.equal(
      escalated.behavior.commerceHunterCount(escalated.s, 8),
      3,
      "a large late fleet behind the capture pace fields three hunters",
    );
    // De-escalation: light traffic keeps the single hunter.
    const light = makeAdaptive({
      fleet: fleetOf(8),
      tick: 9000,
      traffic: 50,
      hostile: 0,
    });
    assert.equal(
      light.behavior.commerceHunterCount(light.s, 8),
      1,
      "light traffic keeps the single-hunter optimum",
    );
    // Elapsed gate: early game stays single-hunter.
    const early = makeAdaptive({
      fleet: fleetOf(8),
      tick: 3000,
      traffic: 200,
      hostile: 0,
    });
    assert.equal(
      early.behavior.commerceHunterCount(early.s, 8),
      1,
      "the early game keeps full defense strength",
    );
    // Hostile floor: six hostile warships bound hunters within the
    // four-hull defense floor (8-4=4 max; the deficit asks only 3).
    const threatened = makeAdaptive({
      fleet: fleetOf(8),
      tick: 9000,
      traffic: 200,
      hostile: 6,
      progress: 5,
    });
    assert.equal(
      threatened.behavior.commerceHunterCount(threatened.s, 8),
      3,
      "fleet-war pressure bounds hunters within the four-hull defense floor",
    );
    const besieged = makeAdaptive({
      fleet: fleetOf(5),
      tick: 9000,
      traffic: 200,
      hostile: 6,
      progress: 5,
    });
    assert.equal(
      besieged.behavior.commerceHunterCount(besieged.s, 5),
      1,
      "a small fleet under fleet-war pressure keeps the single hunter",
    );
    // On-pace fleet skips the third hunter.
    const onPace = makeAdaptive({
      fleet: fleetOf(8),
      tick: 9000,
      traffic: 200,
      hostile: 0,
      progress: 40,
    });
    assert.equal(
      onPace.behavior.commerceHunterCount(onPace.s, 8),
      2,
      "an on-pace capture economy keeps two hunters",
    );
  }

  // Stable identity: equal-distance hulls keep the first ID after wrapper churn.
  {
    const fleetA = [raidShip(7, 50), raidShip(8, 50)];
    const behavior = makeDefenseBehavior({ fleet: fleetA });
    const s = raidState();
    const first = behavior.commerceDefenseSubfleetIds(s);
    assert.equal(first.size, 1, "tie selects exactly one hull");
    const chosen = [...first][0];
    const fleetB = [raidShip(8, 50), raidShip(7, 50)];
    behavior.player.units = (type) =>
      type === UNIT.Warship ? fleetB : behavior.player.units(type);
    const second = behavior.commerceDefenseSubfleetIds(s);
    assert.equal([...second][0], chosen, "reordered fresh wrappers keep the cached defense ID");
  }

  // Nearest-to-port ranking: the closest hull defends, the far hull raids.
  {
    const near = raidShip("near", 10);
    const far = raidShip("far", 900);
    const behavior = makeDefenseBehavior({ fleet: [near, far] });
    const s = raidState();
    const defenseIds = behavior.commerceDefenseSubfleetIds(s);
    assert.ok(defenseIds.has("near"), "the hull nearest a friendly port defends");
    const idle = behavior.collectIdleRaidShips(s, 100, new Map([[500, 0]]));
    assert.equal(idle.length, 1, "only the far hull raids commerce");
    assert.equal(idle[0].id(), "far", "the reserved near hull does not raid");
  }

  // Stale IDs are pruned when a reserved hull disappears (next tick).
  {
    const fleet = [raidShip(1, 10), raidShip(2, 20), raidShip(3, 900)];
    const behavior = makeDefenseBehavior({ fleet });
    let tick = 100;
    behavior.game = makeGame({ ticks: () => tick });
    const s = raidState();
    behavior.commerceDefenseSubfleetIds(s);
    fleet.shift();
    tick += 1;
    const afterLoss = behavior.commerceDefenseSubfleetIds(s);
    assert.ok(!afterLoss.has(1), "a destroyed reserved hull is pruned from the defense set");
    assert.equal(afterLoss.size, 1, "the re-ranked fleet still reserves one hull");
    const memoSameTick = behavior.commerceDefenseSubfleetIds(s);
    assert.equal(
      memoSameTick,
      afterLoss,
      "repeat calls within one tick reuse the memoized selection",
    );
  }

  // Replacement floor gate: only after a fleet existed AND a SAM is queued.
  {
    const completedPort = { tile: () => 0, isActive: () => true, isUnderConstruction: () => false };
    const floorUnits = (warships, sams) => (type) => {
      const pools = {
        [UNIT.Warship]: warships,
        [UNIT.Port]: [completedPort],
        [UNIT.SAMLauncher]: sams,
      };
      return pools[type] ?? [];
    };
    const behavior = makeDefenseBehavior({ fleet: [raidShip(1, 10)] });
    const s = raidState();
    assert.equal(behavior.shouldRestoreDefenseFloor(s), false, "no prior fleet blocks the floor");
    s.warshipFleetEverBuilt = true;
    assert.equal(behavior.shouldRestoreDefenseFloor(s), false, "no SAM in queue blocks the floor");
    behavior.player.units = floorUnits([raidShip(1, 10)], [{ tile: () => 1 }]);
    assert.equal(
      behavior.shouldRestoreDefenseFloor(s),
      true,
      "queued SAM plus sub-2 fleet restores the floor",
    );
    behavior.player.units = floorUnits([raidShip(1, 10), raidShip(2, 20)], [{ tile: () => 1 }]);
    assert.equal(
      behavior.shouldRestoreDefenseFloor(raidState()),
      false,
      "a two-hull fleet does not trigger the replacement floor",
    );
  }

  // Meter-aware duel steering: a loaded flagship defers hunter duels to a
  // green hull (a warship final blow zeroes the victor's meter); trade-lane
  // and interception picks keep the flagship preferred. At veterancy 2
  // (promotion rank) the duel final blow IS the level-3 promotion and the
  // meter reset is free at the cap — the flagship then takes the duel.
  {
    const flagship = {
      id: () => "flag",
      tile: () => 100,
      veterancy: () => 1,
      isActive: () => true,
      isUnderConstruction: () => false,
      warshipState: () => ({ patrolTile: 100, veterancyProgress: 200 }),
    };
    const greenHull = {
      id: () => "green",
      tile: () => 300,
      veterancy: () => 0,
      isActive: () => true,
      isUnderConstruction: () => false,
      warshipState: () => ({ patrolTile: 300, veterancyProgress: 0 }),
    };
    const behavior = makeDefenseBehavior({ fleet: [flagship, greenHull] });
    behavior.player.units = (type) => (type === UNIT.Warship ? [flagship, greenHull] : []);
    const s = raidState();
    s.raidFlagshipId = "flag";
    const duel = behavior.selectClosestIdleWarship(120, s, 100, 0, true);
    assert.equal(duel?.warship.id(), "green", "a loaded flagship skips the hunter duel");
    const lane = behavior.selectClosestIdleWarship(120, s, 100, 0, false);
    assert.equal(lane?.warship.id(), "flag", "trade-lane response still prefers the nearest hull");
    flagship.warshipState = () => ({ patrolTile: 100, veterancyProgress: 40 });
    const cheapReset = behavior.selectClosestIdleWarship(120, s, 100, 0, true);
    assert.equal(
      cheapReset?.warship.id(),
      "flag",
      "a nearly-empty meter may take the free duel level",
    );
    // Promotion rank: veterancy 2 with a fully loaded meter still duels —
    // the warship kill promotes instantly and the reset costs nothing.
    flagship.veterancy = () => 2;
    flagship.warshipState = () => ({ patrolTile: 100, veterancyProgress: 200 });
    const promotionDuel = behavior.selectClosestIdleWarship(250, s, 100, 0, true);
    assert.equal(
      promotionDuel?.warship.id(),
      "flag",
      "a vet-2 flagship takes the hunter duel even with a loaded meter",
    );
    assert.equal(
      behavior.warshipDuelDefersFlagship(s, flagship),
      false,
      "retaliation never swaps a vet-2 flagship out of its promotion duel",
    );
    const farDuel = behavior.selectClosestIdleWarship(3000, s, 100, 0, true);
    assert.equal(
      farDuel?.warship.id(),
      "green",
      "an out-of-reach flagship falls through so nearer hulls still dispatch",
    );
  }

  // First-SAM reserve always wins over the floor bypass.
  {
    const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
    behavior.cost = () => 500_000n;
    behavior.shouldDeferWarshipForFirstSam = () => true;
    behavior.shouldDeferWarshipForDefense = () => true;
    behavior.shouldRestoreDefenseFloor = () => true;
    assert.equal(
      behavior.shouldDeferWarshipBuildForFloor(false, {}),
      true,
      "the first-SAM reserve outranks the defense floor bypass",
    );
    behavior.shouldDeferWarshipForFirstSam = () => false;
    assert.equal(
      behavior.shouldDeferWarshipBuildForFloor(false, {}),
      false,
      "the floor bypass defeats the ordinary offensive reserve",
    );
    behavior.shouldRestoreDefenseFloor = () => false;
    assert.equal(
      behavior.shouldDeferWarshipBuildForFloor(false, {}),
      true,
      "without the floor the ordinary offensive reserve applies again",
    );
  }

  // Non-Legendary keeps the subfleet empty.
  {
    sandbox.currentDifficulty = () => "Impossible";
    const behavior = makeDefenseBehavior({ fleet: [raidShip(1, 10), raidShip(2, 20)] });
    const s = raidState();
    assert.equal(behavior.commerceDefenseSubfleetIds(s).size, 0, "non-Legendary reserves nothing");
    sandbox.currentDifficulty = () => "Legendary";
  }

  // A temporarily vanished port reference retains the live reserved IDs.
  {
    const fleet = [raidShip(1, 10), raidShip(2, 20)];
    const behavior = makeDefenseBehavior({ fleet });
    let tick = 100;
    behavior.game = makeGame({ ticks: () => tick });
    const s = raidState();
    const reserved = behavior.commerceDefenseSubfleetIds(s);
    assert.equal(reserved.size, 1, "one hull is reserved with ports visible");
    tick += 1;
    behavior.friendlyCombatPorts = () => [];
    const retained = behavior.commerceDefenseSubfleetIds(s);
    assert.equal(
      [...retained].join(","),
      [...reserved].join(","),
      "lost references retain the live reserve",
    );
    fleet.shift();
    tick += 1;
    const pruned = behavior.commerceDefenseSubfleetIds(s);
    assert.equal(pruned.size, 0, "a stale reserved ID is dropped once its hull is gone");
  }

  // A rejected commerce emit must not mute the hull for 60 ticks.
  {
    const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
    behavior.game = makeGame({ ticks: () => 500 });
    behavior.raidingTierActive = () => true;
    behavior.incomingNavalTransports = () => [];
    behavior.commerceRaidAnchors = () => [200];
    behavior.countRaidStationedShips = () => new Map([[200, 0]]);
    behavior.warshipMoveBudgetAvailable = () => true;
    const ship = raidShip("raider", 900);
    const state = raidState();
    state.raidAnchors = [200];
    behavior.player = { smallID: () => 1, units: (type) => (type === UNIT.Warship ? [ship] : []) };
    behavior.activeWarships = () => [ship];
    behavior.friendlyCombatPorts = () => [];
    let emitAttempts = 0;
    sandbox.getEventBus = () => ({});
    sandbox.discoverCtors = () => ({ moveWarship: class {} });
    sandbox.emitIntent = () => {
      emitAttempts += 1;
      return false;
    };
    behavior.serviceCommerceRaids(state, 500);
    assert.equal(emitAttempts, 1, "the rejected move was attempted once");
    assert.equal(state.cooldown.has("raider"), false, "a rejected emit sets no cooldown");
    sandbox.emitIntent = () => true;
    behavior.serviceCommerceRaids(state, 501);
    assert.equal(
      state.cooldown.get("raider"),
      501,
      "a retry after rejection can succeed and cooldown",
    );
    delete sandbox.getEventBus;
    delete sandbox.discoverCtors;
    delete sandbox.emitIntent;
  }

  // Emergency replacement integration: the floor bypass lets a lone survivor
  // rebuild below the ordinary offensive gold threshold once a SAM is queued.
  {
    const completedPort = { tile: () => 0, isActive: () => true, isUnderConstruction: () => false };
    const queuedSam = { tile: () => 1, isUnderConstruction: () => true };
    const survivor = raidShip(1, 10);
    const makeReplacementBehavior = ({ sams }) => {
      const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
      behavior.game = makeGame({ ticks: () => 500, units: () => [] });
      behavior.random = { chance: () => true, randElement: (arr) => arr[0] };
      behavior.player = {
        smallID: () => 1,
        gold: () => 600_000n,
        unitsOwned: () => 1,
        units: (type) => {
          const pools = {
            [UNIT.Warship]: [survivor],
            [UNIT.Port]: [completedPort],
            [UNIT.SAMLauncher]: sams,
            [UNIT.MissileSilo]: [],
            [UNIT.City]: [],
          };
          return pools[type] ?? [];
        },
      };
      behavior.shouldDeferWarshipForFirstSam = () => false;
      behavior.shouldDeferWarshipForDefense = () => true;
      behavior.warshipSpawnTile = () => 200;
      behavior.buildableWarship = async () => ({ canBuild: 200 });
      behavior.tryEmitWarshipBuild = () => true;
      return behavior;
    };
    const withoutSam = makeReplacementBehavior({ sams: [] });
    const stateNo = raidState();
    stateNo.warshipFleetEverBuilt = true;
    const noBuild = await withoutSam.maybeSpawnWarship();
    assert.equal(noBuild, false, "without a queued SAM the ordinary reserve blocks the rebuild");
    const withSam = makeReplacementBehavior({ sams: [queuedSam] });
    const stateYes = raidState();
    stateYes.warshipFleetEverBuilt = true;
    const rebuilt = await withSam.maybeSpawnWarship();
    assert.equal(
      rebuilt,
      true,
      "a queued SAM plus the defense floor permits the emergency rebuild",
    );
  }
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
  // Capture concentration: with a flagship hunt origin, the fleet chases the
  // prey nearest THE FLAGSHIP even when another trade ship is closer to the
  // hunting hull itself.
  const preyNearFlagship = { tile: () => 300 };
  const preyNearHunter = { tile: () => 104 };
  assert.equal(
    behavior.tradeHuntTarget(hunter, [preyNearFlagship, preyNearHunter], [], 290),
    300,
    "hunters converge on the prey nearest the flagship, not nearest themselves",
  );
}

// ── Veterancy concentration & retention ─────────────────────────────────────
{
  const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
  behavior.game = makeGame();

  // combatFlagshipHuntTile: null off-tier, null once promoted, otherwise the
  // pre-vet-3 flagship's tile.
  behavior.raidingTierActive = () => false;
  assert.equal(
    behavior.combatFlagshipHuntTile({}, []),
    null,
    "no hunt origin outside the raiding tier",
  );
  behavior.raidingTierActive = () => true;
  behavior.selectRaidFlagshipId = () => "flag";
  assert.equal(
    behavior.combatFlagshipHuntTile({}, [{ id: () => "flag", veterancy: () => 3, tile: () => 42 }]),
    null,
    "a promoted flagship releases the hunt origin",
  );
  assert.equal(
    behavior.combatFlagshipHuntTile({}, [{ id: () => "flag", veterancy: () => 1, tile: () => 42 }]),
    42,
    "the pre-vet-3 flagship's tile becomes the fleet hunt origin",
  );

  // Manual orders never trap a wounded hull below the engine repair-retreat
  // line (a manual move disables that retreat for 50 ticks).
  assert.equal(
    behavior.manualOrderWouldTrapWoundedHull({ health: () => 70, maxHealth: () => 100 }),
    true,
    "a hull below 75% HP is not hand-ordered into a fight",
  );
  assert.equal(
    behavior.manualOrderWouldTrapWoundedHull({ health: () => 80, maxHealth: () => 100 }),
    false,
    "a healthy hull may still take manual orders",
  );
  assert.equal(
    behavior.manualOrderWouldTrapWoundedHull({ health: () => 10 }),
    false,
    "hulls without a maxHealth accessor are not blocked",
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
