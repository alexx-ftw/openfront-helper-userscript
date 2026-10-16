// Direct salvo targets follow the same ally and postgame rules as interceptors.

import assert from "node:assert/strict";
import { createNukeAllySamFixture } from "./helpers/nuke-ally-sam-fixture.mjs";

const {
  permanentTeammate,
  winner,
  makeSam,
  nearbySams,
  directAllySam,
  directTarget,
  behavior,
  coveringBehavior,
  adaptedClientGame,
  nativeWinnerGame,
  nativeCancelledGame,
  fallbackGame,
  missedWinnerGame,
  cancellationGame,
  setClientUpdates,
  setCancellationUpdates,
  setMissedWinnerGameOver,
  setGameType,
} = createNukeAllySamFixture();

const adaptedHasWinner = () =>
  typeof adaptedClientGame.hasWinner === "function" ? adaptedClientGame.hasWinner() : null;

const winnerlessCancellationFirst = cancellationGame.hasWinner();
setCancellationUpdates({});
const winnerlessCancellationAfterEmptyBatch = cancellationGame.hasWinner();
const missedWinnerBeforeGameOver = missedWinnerGame.hasWinner();
setMissedWinnerGameOver(true);
const missedWinnerAfterGameOver = missedWinnerGame.hasWinner();

const actual = {
  hostileInterceptors: nearbySams.map((sam) => behavior.isHostileSamIntercept(sam, new Set())),
  coveringEnemySams: Array.from(behavior.findEnemySamsCoveringTile(0), (sam) => sam.id()),
  directAllySalvoTargets: Array.from(behavior.samSalvoTargetsFor(directTarget), (sam) => sam.id()),
  coveringSurvivesAllyFilter: Array.from(coveringBehavior.samSalvoTargetsFor(directTarget), (sam) =>
    sam.id(),
  ),
  cancelledWinHasWinner: adaptedHasWinner(),
  cancelledWinTeammate: behavior.isEnemyNukeSam(
    makeSam(permanentTeammate, "cancelled-teammate").unit,
  ),
  winnerlessCancellationHasWinner: winnerlessCancellationFirst,
  winnerlessCancellationAfterEmptyBatch,
  missedWinnerBeforeGameOver,
  missedWinnerAfterGameOver,
};
setClientUpdates({ Win: [{ type: "Win", winner, allPlayersStats: {} }] });
actual.winningUpdateHasWinner = adaptedHasWinner();
setClientUpdates({ Win: [] });
actual.latchedWinnerAfterUpdate = adaptedHasWinner();
actual.postgameTeammate = behavior.isEnemyNukeSam(makeSam(permanentTeammate, "teammate").unit);
actual.postgameDiplomaticAlly = behavior.isEnemyNukeSam(directAllySam);
setGameType("Singleplayer");
actual.singleplayerTeammate = behavior.isEnemyNukeSam(
  makeSam(permanentTeammate, "singleplayer-teammate").unit,
);
actual.nativeWinnerHasWinner =
  typeof nativeWinnerGame.hasWinner === "function" ? nativeWinnerGame.hasWinner() : null;
actual.nativeCancelledHasWinner =
  typeof nativeCancelledGame.hasWinner === "function" ? nativeCancelledGame.hasWinner() : null;
actual.getWinnerPassthrough = nativeWinnerGame.getWinner() === winner;
actual.getWinnerFallback = fallbackGame.getWinner();
actual.fallbackHasWinner =
  typeof fallbackGame.hasWinner === "function" ? fallbackGame.hasWinner() : null;

assert.deepEqual(
  actual,
  {
    hostileInterceptors: [false, false, false, true],
    coveringEnemySams: ["enemy"],
    directAllySalvoTargets: [],
    coveringSurvivesAllyFilter: ["enemy-covering"],
    cancelledWinHasWinner: false,
    cancelledWinTeammate: false,
    winnerlessCancellationHasWinner: false,
    winnerlessCancellationAfterEmptyBatch: false,
    missedWinnerBeforeGameOver: false,
    missedWinnerAfterGameOver: true,
    winningUpdateHasWinner: true,
    latchedWinnerAfterUpdate: true,
    postgameTeammate: true,
    postgameDiplomaticAlly: false,
    singleplayerTeammate: false,
    nativeWinnerHasWinner: true,
    nativeCancelledHasWinner: false,
    getWinnerPassthrough: true,
    getWinnerFallback: null,
    fallbackHasWinner: false,
  },
  "direct salvos exclude allies and only allow permanent teammates after multiplayer game over",
);
