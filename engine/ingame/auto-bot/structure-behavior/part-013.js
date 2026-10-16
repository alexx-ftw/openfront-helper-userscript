      if (!attacker || !(attacker.isPlayer && attacker.isPlayer())) return true;
      return this.player.sharesBorderWith(attacker);
    }

    // getAttackFrontTiles — NationStructureBehavior.ts:246.
    // src builds a Set of attacker Player objects and tests owner-identity; we
    // build a Set of attacker smallIDs and test the neighbor owner's smallID
    // (guarding null / TerraNullius), per the contract identity rule.
    getAttackFrontTiles(landAttacks) {
      const game = this.game;
      const player = this.player;
      const attackerSet = new Set(
        landAttacks
          .map((a) => {
            const at = a.attacker();
            return at && at.isPlayer && at.isPlayer() ? at.smallID() : null;
          })
          .filter((sid) => sid !== null),
      );
      if (attackerSet.size === 0) return [];

      const frontTiles = [];
      outer: for (const borderTile of player.borderTiles()) {
        for (const neighbor of game.neighbors(borderTile)) {
          const ownerSid = game.hasOwner(neighbor) ? game.ownerID(neighbor) : null;
          if (ownerSid !== null && attackerSet.has(ownerSid)) {
            frontTiles.push(borderTile);
            continue outer;
          }
        }
      }
      return frontTiles;
    }

    // countDefensePostsNearFront — NationStructureBehavior.ts:269.
    countDefensePostsNearFront(frontTiles, cap) {
      if (frontTiles.length === 0) return 0;

      const game = this.game;
      const rangeSquared = this.defensePostEffectRangeSquared();

      let count = 0;
      for (const dp of this.player.units(UNIT.DefensePost)) {
        for (const frontTile of frontTiles) {
          if (game.euclideanDistSquared(dp.tile(), frontTile) <= rangeSquared) {
            count++;
            if (cap !== undefined && count >= cap) return count;
            break;
          }
        }
      }
      return count;
    }

    defensePostEffectRangeSquared() {
      const configuredRange = Number(this.game.config().defensePostRange?.());
      if (Number.isFinite(configuredRange) && configuredRange > 0) {
        return configuredRange ** 2;
      }
      const { borderSpacing } = this.spacingConstants();
      return (borderSpacing * 1.5) ** 2;
    }

    uncoveredDefensePostFrontTiles(frontTiles) {
      const posts = typeof this.player.units === "function"
        ? this.player.units(UNIT.DefensePost) || []
        : [];
      if (posts.length === 0) return [...frontTiles];
      const rangeSquared = this.defensePostEffectRangeSquared();
      return frontTiles.filter((frontTile) =>
        posts.every(
          (post) =>
            this.game.euclideanDistSquared(post.tile(), frontTile) > rangeSquared,
        ),
      );
    }

    rankDefensePostTiles(tiles, uncoveredFrontTiles) {
      const rangeSquared = this.defensePostEffectRangeSquared();
      const placementByTile = new Map(
        tiles.map((tile) => {
          let coverage = 0;
          let closestFrontDistanceSquared = Infinity;
          for (const frontTile of uncoveredFrontTiles) {
            const distanceSquared = this.game.euclideanDistSquared(tile, frontTile);
            if (distanceSquared <= rangeSquared) coverage++;
            closestFrontDistanceSquared = Math.min(
              closestFrontDistanceSquared,
              distanceSquared,
            );
          }
          return [tile, { coverage, closestFrontDistanceSquared }];
        }),
      );
      return this.rankStructureTilesBySamProtection(
        tiles,
        UNIT.DefensePost,
      ).sort(
        (left, right) =>
          (placementByTile.get(right)?.coverage ?? 0) -
            (placementByTile.get(left)?.coverage ?? 0) ||
          (placementByTile.get(right)?.closestFrontDistanceSquared ?? 0) -
            (placementByTile.get(left)?.closestFrontDistanceSquared ?? 0),
      );
    }

    // sampleTilesNearFront — NationStructureBehavior.ts:302.
    // DIVERGENCE: src checks `player.canBuild(unitType, t)` inside the sampler
    // (so a tile only counts toward `count` if buildable). The client canBuild is
    // async, so we drop the in-sampler canBuild check and emit the raw sampled
    // tiles; tryBuildDefensePost probes buildability down the returned list
    // (rank-then-probe). Sampling geometry/RNG and the spread-anchor filtering are
    // otherwise identical. `unitType` is retained in the signature for parity.
    sampleTilesNearFront(frontTiles, count, _unitType) {
      if (frontTiles.length === 0) return [];

      const { borderSpacing } = this.spacingConstants();
      const context = {
        anchors: this.defensePostFrontAnchors(frontTiles, borderSpacing),
        borderTiles: this.player.borderTiles(),
        count,
        maxBorderDist: Math.ceil(borderSpacing * 1.5),
        minBorderDist: Math.ceil(borderSpacing * 0.75),
        mySid: this.player.smallID(),
        searchRadius: Math.ceil(borderSpacing * 1.5),
      };
      const result = this.sampleOwnedFrontTiles(context, 6, true);

      // A shallow fallback puts the unfinished Post directly on the collapsing
      // border. If no candidate has the required territorial depth, there is no
      // survivable placement in this decision and ordinary construction stays live.
      return result;
    }

    defensePostFrontAnchors(frontTiles, borderSpacing) {
      const existingTiles = this.player
        .units(UNIT.DefensePost)
        .map((unit) => unit.tile());
      if (existingTiles.length === 0) return frontTiles;
      const spreadRangeSquared = (borderSpacing * 1.5) ** 2;
      const spreadAnchors = frontTiles.filter((frontTile) =>
        existingTiles.every(
          (postTile) =>
            this.game.euclideanDistSquared(frontTile, postTile) >=
            spreadRangeSquared,
        ),
      );
      return spreadAnchors.length > 0 ? spreadAnchors : frontTiles;
    }

    sampleOwnedFrontTiles(context, attemptMultiplier, requireBorderDepth) {
      const result = [];
      for (
        let attempt = 0;
        attempt < context.count * attemptMultiplier &&
        result.length < context.count;
        attempt++
      ) {
        const tile = this.randomOwnedFrontTile(context);
        if (tile === null) continue;
