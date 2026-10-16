  function trySetEmbargo(player, otherPlayer, shouldEmbargo, game) {
    const directCandidates = shouldEmbargo
      ? [
          [otherPlayer],
          [otherPlayer, true],
          [getPlayerSmallId(otherPlayer)],
          [getPlayerSmallId(otherPlayer), true],
        ]
      : [
          [otherPlayer, false],
          [otherPlayer],
          [getPlayerSmallId(otherPlayer), false],
          [getPlayerSmallId(otherPlayer)],
        ];
    const directMethods = shouldEmbargo
      ? [
          "setEmbargo",
          "embargo",
          "embargoPlayer",
          "addEmbargo",
          "setTradeEmbargo",
        ]
      : [
          "setEmbargo",
          "removeEmbargo",
          "clearEmbargo",
          "unembargo",
          "setTradeEmbargo",
        ];

    if (tryEmbargoMethods(player, directMethods, directCandidates)) return true;

    const gameMethods = shouldEmbargo
      ? ["setEmbargo", "embargoPlayer", "embargo"]
      : ["setEmbargo", "removeEmbargo", "clearEmbargo"];
    const gameArgs = shouldEmbargo
      ? [
          [player, otherPlayer],
          [getPlayerSmallId(player), getPlayerSmallId(otherPlayer)],
          [player, otherPlayer, true],
        ]
      : [
          [player, otherPlayer, false],
          [getPlayerSmallId(player), getPlayerSmallId(otherPlayer), false],
          [player, otherPlayer],
        ];

    return tryEmbargoMethods(game, gameMethods, gameArgs);
  }

  function isEligibleTradePeer(player, myPlayer) {
    if (!player?.isAlive?.() || !isHumanPlayer(player)) return false;
    const playerId = getPlayerSmallId(player);
    const myId = getPlayerSmallId(myPlayer);
    return (
      Number.isFinite(playerId) &&
      Number.isFinite(myId) &&
      playerId !== myId
    );
  }

  function syncTradeEmbargoes(game, myPlayer, shouldAllowTrade) {
    for (const player of Array.from(game?.playerViews?.() || [])) {
      if (!isEligibleTradePeer(player, myPlayer)) continue;
      const allowTrade = shouldAllowTrade(player);
      trySetEmbargo(myPlayer, player, !allowTrade, game);
      trySetEmbargo(player, myPlayer, !allowTrade, game);
    }
  }

  function applySelectiveTradePolicy(gameOverride = null) {
    const context = gameOverride ? { game: gameOverride } : getOpenFrontGameContext();
    const game = context?.game ?? gameOverride;
    if (!isSelectiveTradePolicyAvailable(game)) {
      runtimeState.selectiveTradePolicyEnabled = false;
      runtimeState.selectiveTradePolicyNeedsEmbargoSync = false;
      selectiveTradePolicyAllowedPartnerIds.clear();
      runtimeState.selectiveTradePolicyMyPlayerId = null;
      reportSelectiveTradePolicyAvailability(game);
      return;
    }

    runtimeState.selectiveTradePolicyEnabled = true;
    runtimeState.selectiveTradePolicyNeedsEmbargoSync = true;
    const myPlayer = game?.myPlayer?.();
    reportSelectiveTradePolicyAvailability(game);

    rebuildSelectiveTradePolicyCache(game, myPlayer);
    syncSelectiveTradePolicyPatches(game);

    syncTradeEmbargoes(game, myPlayer, (player) =>
      isAllowedTradePartnerForMyPlayer(myPlayer, player, game),
    );

    runtimeState.selectiveTradePolicyNeedsEmbargoSync = false;
  }

  function clearSelectiveTradePolicy(gameOverride = null) {
    const context = gameOverride ? { game: gameOverride } : getOpenFrontGameContext();
    const game = context?.game ?? gameOverride;
    const myPlayer = game?.myPlayer?.();

    runtimeState.selectiveTradePolicyEnabled = false;
    runtimeState.selectiveTradePolicyNeedsEmbargoSync = false;
    selectiveTradePolicyAllowedPartnerIds.clear();
    runtimeState.selectiveTradePolicyMyPlayerId = null;
    reportSelectiveTradePolicyAvailability(game);

    if (!game || !myPlayer?.isPlayer?.() || !isHumanPlayer(myPlayer)) {
      return;
    }

    syncTradeEmbargoes(game, myPlayer, () => true);
  }

  function setSelectiveTradePolicyEnabled(enabled, gameOverride = null) {
    if (enabled) {
      applySelectiveTradePolicy(gameOverride);
      return;
    }

    clearSelectiveTradePolicy(gameOverride);
  }
