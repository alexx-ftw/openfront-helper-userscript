      // Preserve the legacy random draw so existing seed streams do not shift
      // on tiers that already use connectivity. Its result is intentionally
      // ignored: a Factory must always score reachable trade destinations.
      this.shouldUseConnectivityScore(currentDifficulty());
      const railState = this.readRailroadState(game);

      // Factories are the train source. Unlike a cosmetic placement preference,
      // knowing whether one can reach a City or Port directly determines whether
      // its trains can generate trade gold at all, so this must apply on every
      // difficulty rather than being randomized for the easier tiers.
      const reachableStations = this.getOrBuildFactoryTradeDestinations();
      const minRangeSquared = game.config().trainStationMinRange() ** 2;

      // Cross-type spacing: prefer to be away from cities.
      const cityTiles = new Set(player.units(UNIT.City).map((u) => u.tile()));
      const nearestCity = this.nearestTileDistanceScorer(cityTiles);

      return (tile) => {
        let w = 0;

        // Prefer higher elevations
        w += game.magnitude(tile);

        // Prefer to be away from the border
        const closestBorderDist = nearestBorder(tile);
        w += Math.min(closestBorderDist, borderSpacing);

        // Prefer to be away from other factories
        const closestOtherDist = nearestOther(tile);
        if (Number.isFinite(closestOtherDist)) {
          w += Math.min(closestOtherDist, stationRange);
        }

        // Prefer to be away from cities (cross-type spacing)
        const closestCityDist = nearestCity(tile);
        if (Number.isFinite(closestCityDist)) {
          w += Math.min(closestCityDist, structureSpacing);
        }

        w += this.commercialRailPlacementScore(
          tile,
          reachableStations,
          minRangeSquared,
          stationRangeSquared,
          { structureSpacing, railState },
        );

        return w;
      };
    }

    /**
     * Return only the part of our border that exposes an economic structure to
     * unowned terrain or a non-friendly player. A seam shared exclusively with
     * teammates/allies is part of the team's economic interior: penalizing it
     * can push Cities and Factories away from the strongest commercial rail
     * connection for no corresponding safety benefit.
     *
     * Mixed seams remain exposed. If a tile touches both an ally and an enemy,
     * the hostile/unowned neighbor wins, so this cannot pull production onto a
     * contested frontier. When the client cannot classify ownership reliably,
     * preserve the conservative upstream behavior and keep the full border.
     */
    economicExposureBorderTiles() {
      const borderTiles = this.player.borderTiles();
      if (!state.settings.winFixes) return borderTiles;
      if (!this.canClassifyEconomicBorder()) return borderTiles;

      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._economicExposureBorderTick === tick &&
        this._economicExposureBorderTiles !== null
      ) {
        return this._economicExposureBorderTiles;
      }

      const ownSid = this.player.smallID();
      const exposed = Array.from(borderTiles).filter((tile) =>
        this.economicBorderTileIsExposed(tile, ownSid),
      );

      if (Number.isFinite(tick)) {
        this._economicExposureBorderTick = tick;
        this._economicExposureBorderTiles = exposed;
      }
      return exposed;
    }

    canClassifyEconomicBorder() {
      return (
        typeof this.game.neighbors === "function" &&
        typeof this.game.hasOwner === "function" &&
        typeof this.game.ownerID === "function" &&
        typeof this.game.playerBySmallID === "function" &&
        typeof this.player.smallID === "function"
      );
    }

    economicBorderTileIsExposed(tile, ownSid) {
      const externalOwners = (this.game.neighbors(tile) || [])
        .map((neighbor) =>
          this.game.hasOwner(neighbor) ? this.game.ownerID(neighbor) : null,
        )
        .filter((ownerSid) => ownerSid !== ownSid);
      return (
        externalOwners.length === 0 ||
        externalOwners.some((ownerSid) => !this.economicBorderOwnerIsFriendly(ownerSid))
      );
    }

    economicBorderOwnerIsFriendly(ownerSid) {
      if (ownerSid === null) return false;
      const owner = this.game.playerBySmallID(ownerSid);
      return Boolean(
        owner &&
          (this.player.isFriendly?.(owner) === true ||
            this.player.isOnSameTeam?.(owner) === true),
      );
    }

    // Prefer a City or Port that connects to the existing trade network, and
    // strongly prefer the engine's exact "snap to railroad" placement.  The
    // latter is intentionally read from GameView's live railroadState rather
    // than inferred from map direction or station geometry: RailNetworkImpl
    // splits a real rail when a station is built within its fixed radius of 3.
    // The local 7×7 search is bounded (49 reads per scored candidate) and runs
    // only for the existing 25-candidate placement budget.
    commercialRailPlacementScore(
      tile,
      reachableStations,
      minRangeSquared,
      stationRangeSquared,
      options,
    ) {
      const structureSpacing = Number(options?.structureSpacing ?? options);
      const railState = options?.railState ?? this.readRailroadState(this.game);
      const connectivity = this.computeConnectivityScore(
        tile,
        reachableStations,
        minRangeSquared,
        stationRangeSquared,
      );
      const snapDistance = this.existingRailSnapDistance(tile, railState);
      if (snapDistance === null) return connectivity * structureSpacing;

      // Retain the connectivity contribution, then make a legal direct snap
      // decisive over generic spacing.  The bounded closeness term only breaks
      // ties between candidates that can all join the same active railway.
      return (
        connectivity * structureSpacing +
        structureSpacing * (2 + Math.max(0, 3 - snapDistance) / 3)
      );
    }

    existingRailSnapDistance(
      tile,
      railState = this.readRailroadState(this.game),
    ) {
      if (!railState || railState.length === 0) return null;
