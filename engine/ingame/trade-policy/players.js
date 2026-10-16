  function isTeamGame(game) {
    const mode = String(game?.config?.().gameMode ?? game?.config?.().gameMode?.() ?? "")
      .trim()
      .toLowerCase();
    if (mode === "team") {
      return true;
    }
    if (mode === "free for all" || mode === "ffa") {
      return false;
    }

    const players = Array.from(game?.playerViews?.() || []).filter((player) =>
      player?.isAlive?.(),
    );
    return players.some((player) => {
      const team = getPlayerTeamName(player);
      return team && team !== "Bot";
    });
  }

  function isHumanPlayer(player) {
    {
      const playerType = player?.type?.() ?? player?.data?.playerType;
      return playerType === "HUMAN";
    }
  }

  function isSelectiveTradePolicyAvailable(game) {
    const myPlayer = game?.myPlayer?.();
    return Boolean(
      game &&
      isTeamGame(game) &&
      myPlayer?.isPlayer?.() &&
      isHumanPlayer(myPlayer)
    );
  }

  function reportSelectiveTradePolicyAvailability(game = null) {
    const available = isSelectiveTradePolicyAvailable(game);
    if (available === runtimeState.lastReportedSelectiveTradePolicyAvailability) {
      return;
    }

    runtimeState.lastReportedSelectiveTradePolicyAvailability = available;
    postToExtension("SELECTIVE_TRADE_POLICY_AVAILABILITY", {
      available,
    });
  }
