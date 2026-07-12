// Notify the lobby layer when the current game enters its spawn phase.

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
    (inSpawnPhase === true || inSpawnPhase === false || inSpawnPhase === null) &&
    gameStartNotificationDetector.observe(game, inSpawnPhase)
  ) {
    postToExtension("GAME_STARTED", {});
  }
}

if (typeof registerHelperTickListener === "function") {
  registerHelperTickListener(pollGameStartNotification);
}
