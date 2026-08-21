// Warship-danger gate for transport launches. Transports are the engine's
// top-priority warship target and close at twice the boat's speed, so the
// Legendary win-fix refuses any launch whose destination sits inside the
// hunting radius. Engine-side destruction attribution is covered by the
// headless goal telemetry contract in test/headless-simulation.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");

const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const sandbox = {
  UNIT: { Warship: "Warship", TransportShip: "TransportShip" },
  Difficulty,
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  currentDifficulty: () => Difficulty.Legendary,
  state: { settings: { winFixes: true }, stats: {} },
};
executeClassicScript(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
  filename: sourcePath,
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
    "a hostile warship within 110 tiles of the destination blocks the boat",
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

process.stdout.write("boat warship danger tests passed\n");
