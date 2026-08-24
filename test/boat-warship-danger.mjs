// Warship-danger gate for transport launches. Transports are the engine's
// top-priority warship target and close at twice the boat's speed, so the
// Legendary win-fix refuses any launch whose destination sits inside the
// hunting radius. Engine-side destruction attribution is covered by the
// headless goal telemetry contract in test/headless-simulation.mjs.

import assert from "node:assert/strict";
import { createAttackBehaviorSandbox, Difficulty } from "./helpers/attack-behavior-sandbox.mjs";

const sandbox = createAttackBehaviorSandbox({
  unit: { Warship: "Warship", TransportShip: "TransportShip" },
});
assert.equal(typeof sandbox.AttackBehavior, "function");

function makeBehavior({ game, player, difficulty }) {
  const behavior = Object.create(sandbox.AttackBehavior.prototype);
  behavior.game = game;
  behavior.player = player;
  sandbox.currentDifficulty = () => difficulty;
  return behavior;
}

const gameWithWarships = (warships) => ({
  units: (type) => (type === "Warship" ? warships : []),
  manhattanDist: (a, b) => Math.abs(a - b),
});

const me = { isFriendly: () => false };

// 1. A hostile warship inside the danger radius blocks the launch.
{
  const behavior = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: gameWithWarships([
      {
        isActive: () => true,
        owner: () => ({ isPlayer: () => true }),
        tile: () => 500,
      },
    ]),
    player: me,
  });
  assert.equal(
    behavior.boatLaunchWarshipDanger(600),
    true,
    "a hostile warship within 130 tiles of the destination blocks the boat",
  );
  assert.equal(
    behavior.boatLaunchWarshipDanger(2000),
    false,
    "a distant hostile warship does not block the launch",
  );
}

// 2. Own and friendly warships never block the launch.
{
  const behavior = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: gameWithWarships([
      {
        isActive: () => true,
        owner: () => me,
        tile: () => 500,
      },
      {
        isActive: () => true,
        owner: () => ({ isPlayer: () => true }),
        tile: () => 501,
      },
    ]),
    player: me,
  });
  behavior.player.isFriendly = (owner) => owner !== me;
  assert.equal(
    behavior.boatLaunchWarshipDanger(600),
    false,
    "own and friendly warships do not block the boat",
  );
}

// 3. Non-Legendary tiers and missing APIs keep the faithful launch path.
{
  const ordinary = makeBehavior({
    difficulty: Difficulty.Impossible,
    game: gameWithWarships([
      {
        isActive: () => true,
        owner: () => ({ isPlayer: () => true }),
        tile: () => 500,
      },
    ]),
    player: me,
  });
  assert.equal(ordinary.boatLaunchWarshipDanger(600), false, "the danger gate is Legendary-only");

  const noUnits = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: { manhattanDist: (a, b) => Math.abs(a - b) },
    player: me,
  });
  assert.equal(
    noUnits.boatLaunchWarshipDanger(600),
    false,
    "a game view without units cannot prove danger and stays permissive",
  );
}

// 4. The emitBoat chokepoint itself refuses a dangerous destination.
{
  const behavior = Object.create(sandbox.AttackBehavior.prototype);
  behavior.game = gameWithWarships([
    {
      isActive: () => true,
      owner: () => ({ isPlayer: () => true }),
      tile: () => 500,
    },
  ]);
  behavior.player = { isFriendly: () => false };
  sandbox.currentDifficulty = () => Difficulty.Legendary;
  behavior.canEmitBoatToDestination = () => true;
  behavior.boatDestinationReserved = () => false;
  behavior.getEarlyGameLiveReserveTroops = () => 1000;
  behavior.getSafeBoatTroops = (requested) => requested;
  assert.equal(
    behavior.emitBoat(600, 100, "probe"),
    false,
    "emitBoat refuses a destination inside the hostile hunting radius",
  );
}

// 5. Ordinary player-boat probes register a beachhead so the existing
// reserve-gated surge lane can promote a successful landing.
{
  const behavior = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: gameWithWarships([]),
    player: { isFriendly: () => false },
  });
  sandbox.state.beachhead = null;
  behavior.game.ticks = () => 321;
  behavior.recordBoatBeachhead(600, true);
  assert.equal(sandbox.state.beachhead.tile, 600);
  assert.equal(sandbox.state.beachhead.at, 321);
  assert.equal(sandbox.state.beachhead.surged, false);
  behavior.recordBoatBeachhead(700, false);
  assert.equal(sandbox.state.beachhead.tile, 600);
  assert.equal(sandbox.state.beachhead.at, 321);
  assert.equal(sandbox.state.beachhead.surged, false);
}

// 6. Corridor gate: a hunter's LIVE coverage disk over the crossing line
// blocks the launch even when the destination itself is clear; docking or
// displacing the hunter reopens it (keyed to live anchors, not a fixed box).
{
  const corridorGame = (warships) => ({
    units: (type) => (type === "Warship" ? warships : []),
    manhattanDist: (a, b) => Math.abs(Number(a) - Number(b)),
    isValidCoord: () => true,
    ref: (x) => x,
    x: (tile) => Number(tile),
    y: () => 0,
  });
  const corridorPlayer = {
    isFriendly: () => false,
    nameLocation: () => ({ x: 0, y: 0 }),
  };
  const hunter = (tile, patrolTile, shipState = "patrolling") => ({
    isActive: () => true,
    owner: () => ({ isPlayer: () => true }),
    tile: () => tile,
    warshipState: () => ({ state: shipState, patrolTile }),
  });
  // Hunter's patrol disk (180) covers the mid-corridor (~tile 500) while its
  // live tile (1600) is far from the destination (1000).
  const behavior = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: corridorGame([hunter(1600, 450)]),
    player: corridorPlayer,
  });
  assert.equal(
    behavior.boatLaunchWarshipDanger(1000),
    true,
    "a hunter's patrol disk over the crossing blocks the launch",
  );
  const dockedBehavior = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: corridorGame([hunter(1600, 450, "docked")]),
    player: corridorPlayer,
  });
  assert.equal(
    dockedBehavior.boatLaunchWarshipDanger(1000),
    false,
    "a docked hunter neither moves nor fires and reopens the corridor",
  );
  const displacedBehavior = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: corridorGame([hunter(1600, 3000)]),
    player: corridorPlayer,
  });
  assert.equal(
    displacedBehavior.boatLaunchWarshipDanger(1000),
    false,
    "a hunter re-anchored off the corridor reopens the launch",
  );
}

// 7. Adaptive corridor sampling: on a long crossing (L > 450) a hunter whose
// patrol disk covers the corridor BETWEEN the old 8 fixed samples must still
// block the launch — the sample count scales with crossing length so the
// spacing never exceeds 50 tiles (a lethal hunter is then within 130+25 of
// some sample and the 155/205 disks see it).
{
  const game2d = (warships) => ({
    units: (type) => (type === "Warship" ? warships : []),
    manhattanDist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y),
    isValidCoord: () => true,
    ref: (x, y) => ({ x, y }),
    x: (tile) => tile.x,
    y: (tile) => tile.y,
  });
  const player2d = {
    isFriendly: () => false,
    nameLocation: () => ({ x: 0, y: 0 }),
  };
  const hunterAt = (x, y, patrolX, patrolY) => ({
    isActive: () => true,
    owner: () => ({ isPlayer: () => true }),
    tile: () => ({ x, y }),
    warshipState: () => ({
      state: "patrolling",
      patrolTile: { x: patrolX, y: patrolY },
    }),
  });
  const behavior = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: game2d([hunterAt(500, 300, 500, 160)]),
    player: player2d,
  });
  // Crossing (0,0) -> (1000,0): old samples sat at x≈111..889 (step 111), so
  // the hunter's patrol disk at (500,160) was >205 manhattan from every
  // sample (nearest: 56+160=216) — invisible. Adaptive samples step by 50,
  // so the sample at (500,0) sees it (0+160=160 <= 205).
  assert.equal(
    behavior.boatLaunchWarshipDanger({ x: 1000, y: 0 }),
    true,
    "a hunter covering a long corridor between fixed samples still blocks it",
  );
  // Short crossings keep the original 8-sample behavior (count floors at 8).
  const samples = behavior.boatCorridorSamples({ x: 0, y: 0 }, { x: 400, y: 0 });
  assert.equal(samples.length, 8, "short crossings keep 8 interior samples");
  const longSamples = behavior.boatCorridorSamples({ x: 0, y: 0 }, { x: 1000, y: 0 });
  assert.equal(
    longSamples.length,
    19,
    "a 1000-tile crossing samples every ~50 tiles (ceil(1000/50)-1)",
  );
}

// 8. Destination ring stays at the historically validated 110: an
// "engine-exact" 130 ring was measured (2026-08-23) to block many more
// destinations on hunter-crowded 5MM boards — flipping 5mm-basket-01's win
// into a loss and stripping temp-04's veterancy — while the corridor
// SAMPLING fix alone carries the boats conversion. A hunter 125 manhattan
// from the destination is therefore accepted (known margin), 100 is not.
{
  const behavior = makeBehavior({
    difficulty: Difficulty.Legendary,
    game: {
      units: (type) =>
        type === "Warship"
          ? [
              {
                isActive: () => true,
                owner: () => ({ isPlayer: () => true }),
                tile: () => 475,
              },
            ]
          : [],
      manhattanDist: (a, b) => Math.abs(Number(a) - Number(b)),
    },
    player: { isFriendly: () => false },
  });
  assert.equal(
    behavior.boatLaunchWarshipDanger(600),
    false,
    "a hunter 125 manhattan from the destination stays launchable at the 110 ring",
  );
  assert.equal(
    behavior.boatLaunchWarshipDanger(575),
    true,
    "a hunter 100 manhattan from the destination still blocks the launch",
  );
}

process.stdout.write("boat warship danger tests passed\n");
