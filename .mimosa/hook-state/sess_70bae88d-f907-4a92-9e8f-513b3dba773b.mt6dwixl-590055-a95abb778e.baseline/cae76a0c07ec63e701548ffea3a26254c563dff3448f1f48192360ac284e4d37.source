// Spawn-position voice prompts. This uses the game's authoritative spawn-phase
// turn counter rather than a wall-clock timer, so pausing or lag cannot make the
// five-second cue fire early or late.

const spawnVoicePromptDetector = createSpawnVoicePromptDetector();

function createSpawnVoicePromptDetector() {
  let currentGame = null;
  let wasInSpawnPhase = false;
  let finalPrompted = false;

  function reset(game) {
    if (game === currentGame) return;
    currentGame = game;
    wasInSpawnPhase = false;
    finalPrompted = false;
  }

  function remainingSpawnPrompt(game) {
    const config = game.config?.();
    const spawnTurns = Number(config?.numSpawnPhaseTurns?.());
    const ticks = Number(game.ticks?.());
    const msPerTick = Number(config?.msPerTick?.());
    if (!Number.isFinite(msPerTick) || msPerTick <= 0) return null;
    const fiveSecondTicks = Math.ceil(5_000 / msPerTick);
    if (
      finalPrompted ||
      !Number.isFinite(spawnTurns) ||
      !Number.isFinite(ticks) ||
      ticks < spawnTurns - fiveSecondTicks
    ) return null;
    finalPrompted = true;
    return "SPAWN, SPAWN";
  }

  return {
    observe(game, inSpawnPhase) {
      if (!game || (inSpawnPhase !== true && inSpawnPhase !== false)) return null;
      reset(game);
      const enteredSpawnPhase = inSpawnPhase && !wasInSpawnPhase;
      wasInSpawnPhase = inSpawnPhase;
      if (!inSpawnPhase) return null;
      if (enteredSpawnPhase) return "PICK SPAWN";
      return remainingSpawnPrompt(game);
    },
  };
}

function pollSpawnVoicePrompt() {
  const context = typeof getOpenFrontGameContext === "function"
    ? getOpenFrontGameContext()
    : null;
  const game = context?.game;
  if (!game || typeof game.inSpawnPhase !== "function") return;
  const prompt = spawnVoicePromptDetector.observe(game, game.inSpawnPhase());
  if (prompt === null) return;
  window.__OFH?.speakSpawnPrompt?.(prompt);
}

if (typeof registerHelperTickListener === "function") {
  registerHelperTickListener(pollSpawnVoicePrompt);
}
