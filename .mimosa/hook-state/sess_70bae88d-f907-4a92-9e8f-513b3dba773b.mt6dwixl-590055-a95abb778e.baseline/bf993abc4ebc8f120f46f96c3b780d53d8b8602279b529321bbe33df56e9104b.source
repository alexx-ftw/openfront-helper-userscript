// Notify the lobby layer when the current game enters its spawn phase.

const gameStartNotificationDetector = createGameStartNotificationDetector();

function pollGameStartNotification() {
  let context;
  {
    context = typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null;
  }

  const game = context?.game;
  if (!game || typeof game.inSpawnPhase !== "function") {
    return;
  }

  let inSpawnPhase;
  {
    inSpawnPhase = game.inSpawnPhase();
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
