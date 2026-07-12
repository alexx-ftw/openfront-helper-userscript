// Notify the lobby layer once the current game's spawn phase has ended.

const gameStartNotificationDetector = createGameStartNotificationDetector();

function pollGameStartNotification() {
  let context = null;
  try {
    context = typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null;
  } catch (_error) {
    return;
  }

  const game = context?.game;
  if (!game || typeof game.inSpawnPhase !== "function") {
    return;
  }

  let inSpawnPhase;
  try {
    inSpawnPhase = game.inSpawnPhase();
  } catch (_error) {
    return;
  }

  if (
    typeof inSpawnPhase === "boolean" &&
    gameStartNotificationDetector.observe(game, inSpawnPhase)
  ) {
    postToExtension("GAME_STARTED_AFTER_SPAWN", {});
  }
}

if (typeof registerHelperTickListener === "function") {
  registerHelperTickListener(pollGameStartNotification);
}
