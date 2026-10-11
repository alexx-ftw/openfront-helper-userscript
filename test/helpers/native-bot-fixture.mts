import assert from "node:assert/strict";
import { GameRunner } from "../../openfront-engine/src/core/GameRunner";
import { Executor } from "../../openfront-engine/src/core/execution/ExecutionManager";
import { TurnSchema, type Intent } from "../../openfront-engine/src/core/Schemas";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
  type Game,
  type Player,
  type Unit,
} from "../../openfront-engine/src/core/game/Game";
import { setup } from "../../openfront-engine/tests/util/Setup";
import {
  createBuildMenu,
  createMaxDifficultyOpponent,
} from "../../scripts/headless/opponent-adapter.js";
import { engineTestsUtil } from "./two-player-game.mts";

// These fixtures exercise priced purchases: unlike setupTwoPlayerGame,
// they do not enable infiniteGold. Preserve player order and client IDs.
export async function setupNativeGame(playerIDs = ["attacker", "defender"]) {
  return setup(
    "big_plains",
    { instantBuild: true },
    playerIDs.map((id) => new PlayerInfo(id, PlayerType.Human, id, id)),
    engineTestsUtil,
  );
}

function createNativeRunner(
  game: Game,
  gameID: string,
  onUpdate: ConstructorParameters<typeof GameRunner>[2],
) {
  return new GameRunner(game, new Executor(game, gameID, "attacker"), (update) => {
    assert.ok(!("errMsg" in update));
    onUpdate(update);
  });
}

export function createNativeStep(game: Game, runner: GameRunner) {
  return (intents: Intent[] = []) => {
    runner.addTurn(
      TurnSchema.parse({
        turnNumber: game.ticks(),
        intents: intents.map((intent) => ({ ...intent, clientID: "attacker" })),
      }),
    );
    assert.equal(runner.executeNextTick(), true);
  };
}

export async function attachNativeBot(
  bot: ReturnType<typeof createMaxDifficultyOpponent>,
  runner: GameRunner,
) {
  await initializeNativeBot(bot, runner);
  const menu = installNativeBuildMenu(bot);
  bot.harness.internals.state.settings.enabled = true;
  bot.harness.internals.state.settings.winFixes = true;
  return { menu, nuke: bot.nationBot.nukeBehavior };
}

// TestConfig uses {1,1}; these two blast-geometry fixtures need real radii.
export function useProductionNukeMagnitudes(game: Game) {
  game.config().nukeMagnitudes = (unitType) => {
    switch (unitType) {
      case UnitType.MIRVWarhead:
        return { inner: 12, outer: 18 };
      case UnitType.AtomBomb:
        return { inner: 12, outer: 30 };
      default:
        return { inner: 80, outer: 100 };
    }
  };
}

export function loadUnitToLevel(unit: Unit, level: number) {
  for (let slot = unit.level(); slot < level; slot++) {
    unit.increaseLevel();
    unit.reloadMissile();
  }
}

export async function setupNativeDuel() {
  const game = await setupNativeGame();
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  return { game, attacker, defender };
}

// The three interception fixtures share this exact priced range. Keep the
// defender's distant tile so a successful hit cannot end the match early.
export async function setupNativeSamRange() {
  const { game, attacker, defender } = await setupNativeDuel();
  const source = game.ref(1, 80);
  const target = game.ref(80, 1);
  attacker.addGold(100_000_000n);
  attacker.conquer(source);
  defender.conquer(target);
  defender.conquer(game.ref(180, 180));
  return { game, attacker, defender, source, target };
}

export function createNativeLoop(
  game: Game,
  gameID: string,
  onUpdate: ConstructorParameters<typeof GameRunner>[2],
) {
  const runner = createNativeRunner(game, gameID, onUpdate);
  const step = createNativeStep(game, runner);
  return { runner, step };
}

export function nativeSiloFlightTicks(
  bot: ReturnType<typeof createMaxDifficultyOpponent>,
  target: number,
  samID: ReturnType<Unit["id"]>,
) {
  return bot.nationBot.nukeBehavior.getAvailableSiloEntries(
    [bot.nationBot.player.units(UnitType.MissileSilo)[0]],
    target,
    new Set([samID]),
  )[0].flightTicks;
}

export function nativeMissileImpactTicks(
  bot: ReturnType<typeof createMaxDifficultyOpponent>,
  missiles: Unit[],
) {
  return missiles.map((missile) => {
    const plan = bot.api.game.motionPlans().get(missile.id());
    assert.ok(plan);
    return plan.startTick + plan.path.length;
  });
}

export async function initializeNativeBot(
  bot: ReturnType<typeof createMaxDifficultyOpponent>,
  runner: GameRunner,
) {
  bot.attach({ runner, clientID: "attacker" });
  await bot.api.beginTick(bot.pageGame.myPlayer());
  bot.nationBot.player = bot.api.game.myPlayer();
  bot.nationBot.initializeBehaviors();
}

export function installNativeBuildMenu(bot: ReturnType<typeof createMaxDifficultyOpponent>) {
  const menu = createBuildMenu(bot);
  bot.harness.current.buildMenu = menu;
  bot.harness.current.eventBus = menu.eventBus;
  return menu;
}

export async function attachNativeCombatBot(
  bot: ReturnType<typeof createMaxDifficultyOpponent>,
  runner: GameRunner,
  defender: Player,
) {
  const { menu, nuke } = await attachNativeBot(bot, runner);
  const rival = bot.api.game.playerBySmallID(defender.smallID());
  return { menu, nuke, rival };
}
