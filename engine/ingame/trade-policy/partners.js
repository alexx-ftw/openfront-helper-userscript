  function isAllowedTradePartnerForMyPlayer(myPlayer, otherPlayer, game) {
    if (!myPlayer || !otherPlayer) {
      return false;
    }
    if (!isHumanPlayer(myPlayer) || !isHumanPlayer(otherPlayer)) {
      return true;
    }

    const myId = getPlayerSmallId(myPlayer);
    const otherId = getPlayerSmallId(otherPlayer);
    if (!Number.isFinite(myId) || !Number.isFinite(otherId)) {
      return false;
    }
    if (myId === otherId) {
      return true;
    }

    {
      if (isTeamGame(game)) {
        return Boolean(myPlayer?.isOnSameTeam?.(otherPlayer));
      }
      return Boolean(myPlayer?.isAlliedWith?.(otherPlayer));
    }
  }

  function rebuildSelectiveTradePolicyCache(game, myPlayer) {
    selectiveTradePolicyAllowedPartnerIds.clear();
    runtimeState.selectiveTradePolicyMyPlayerId = null;

    const myId = getPlayerSmallId(myPlayer);
    if (!Number.isFinite(myId)) {
      return;
    }

    runtimeState.selectiveTradePolicyMyPlayerId = myId;
    selectiveTradePolicyAllowedPartnerIds.add(myId);

    for (const player of Array.from(game?.playerViews?.() || [])) {
      if (!player?.isAlive?.() || !isHumanPlayer(player)) {
        continue;
      }

      const playerId = getPlayerSmallId(player);
      if (!Number.isFinite(playerId) || playerId === myId) {
        continue;
      }

      if (isAllowedTradePartnerForMyPlayer(myPlayer, player, game)) {
        selectiveTradePolicyAllowedPartnerIds.add(playerId);
      }
    }
  }

  function isBlockedBySelectiveTradePolicy(player, otherPlayer, game = null) {
    if (!runtimeState.selectiveTradePolicyEnabled || !player || !otherPlayer) {
      return false;
    }
    if (
      !Number.isFinite(runtimeState.selectiveTradePolicyMyPlayerId) ||
      selectiveTradePolicyAllowedPartnerIds.size === 0
    ) {
      return false;
    }
    if (!isHumanPlayer(player) || !isHumanPlayer(otherPlayer)) {
      return false;
    }

    const playerId = getPlayerSmallId(player);
    const otherId = getPlayerSmallId(otherPlayer);
    if (!Number.isFinite(playerId) || !Number.isFinite(otherId)) {
      return false;
    }

    if (playerId === runtimeState.selectiveTradePolicyMyPlayerId) {
      return !selectiveTradePolicyAllowedPartnerIds.has(otherId);
    }

    if (otherId === runtimeState.selectiveTradePolicyMyPlayerId) {
      return !selectiveTradePolicyAllowedPartnerIds.has(playerId);
    }

    return false;
  }

  function ensureSelectiveTradePolicyPatchForPlayer(player) {
    if (!player || typeof player?.hasEmbargo !== "function") {
      return;
    }
    if (originalPlayerHasEmbargoMethods.has(player)) {
      return;
    }

    const originalHasEmbargo = player.hasEmbargo.bind(player);
    originalPlayerHasEmbargoMethods.set(player, originalHasEmbargo);
    player.hasEmbargo = function patchedHasEmbargo(otherPlayer) {
      if (isBlockedBySelectiveTradePolicy(player, otherPlayer)) {
        return true;
      }

      {
        return Boolean(originalHasEmbargo(otherPlayer));
      }
    };
  }

  function syncSelectiveTradePolicyPatches(game) {
    for (const player of Array.from(game?.playerViews?.() || [])) {
      ensureSelectiveTradePolicyPatchForPlayer(player);
    }
  }

  function callEmbargoMethod(target, methodName, args) {
    const method = target?.[methodName];
    if (typeof method !== "function") {
      return false;
    }

    {
      method.apply(target, args);
      return true;
    }
  }

  function tryEmbargoMethods(target, methodNames, argumentLists) {
    for (const methodName of methodNames) {
      for (const args of argumentLists) {
        if (callEmbargoMethod(target, methodName, args)) return true;
      }
    }
    return false;
  }
