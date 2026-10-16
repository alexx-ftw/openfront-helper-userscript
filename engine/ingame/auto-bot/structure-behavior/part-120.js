            sam.isUnderConstruction()
          );
        }
      })
        .map((sam) => {
        {
          const samRange = Number(config.samRange(sam.level()));
          return {
            tile: sam.tile(),
            rangeSquared: samRange * samRange,
          };
        }
      })
        .filter((sam) => sam !== null && Number.isFinite(sam.rangeSquared));
      const scoredStructureEntries = structureEntries.map((entry) => {
        const alreadyCovered = existingSamProfiles.some((sam) => {
          return (
            game.euclideanDistSquared(entry.tile, sam.tile) <=
            sam.rangeSquared
          );
        });
        return {
          ...entry,
          uncoveredWeight: alreadyCovered ? 0 : entry.weight,
        };
      });
      return (tile) => {
        let totalCoverage = 0;
        let newCoverage = 0;
        let centeredCoverage = 0;
        for (const entry of scoredStructureEntries) {
          const structureTile = entry.tile;
          let distanceSquared;
          {
            distanceSquared = game.euclideanDistSquared(tile, structureTile);
          }
          if (distanceSquared > rangeSquared) continue;
          totalCoverage += entry.weight;
          centeredCoverage += entry.weight * Math.max(0, 1 - distanceSquared / rangeSquared);

          newCoverage += entry.uncoveredWeight;
        }

        return totalCoverage * (totalWeight + 1) + newCoverage + centeredCoverage;
      };
    }

    // samLauncherValue — NationStructureBehavior.ts:1233.
    samLauncherValue() {
      const game = this.game;
      const player = this.player;
      const borderTiles = player.borderTiles();
      const otherUnits = player.units(UNIT.SAMLauncher);
      const { borderSpacing, structureSpacing } = this.spacingConstants();

      const difficulty = currentDifficulty();
      const weightByLevel = isAtLeastHardDifficulty(difficulty);

      const protectEntries = [];
      for (const unit of player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.MissileSilo,
        UNIT.Port,
      )) {
        switch (unit.type()) {
          case UNIT.City:
          case UNIT.Factory:
          case UNIT.MissileSilo:
          case UNIT.Port:
            protectEntries.push({
              tile: unit.tile(),
              weight: weightByLevel ? unit.level() : 1,
            });
        }
      }
      const range = game.config().defaultSamRange();
      const rangeSquared = range * range;
      const friendlySamNetworkScore = this.friendlyUsefulSamPlacementScore(
        this.samProtectableStructureTiles(),
        structureSpacing,
      );
      const otherTiles = new Set(otherUnits.map((unit) => unit.tile()));
      const nearestBorder = this.nearestTileDistanceScorer(borderTiles);
      const nearestOther = this.nearestTileDistanceScorer(otherTiles, true);

      const useCoverageWeighting = isLegendaryDifficulty(difficulty)
        ? true
        : difficulty !== Difficulty.Easy && this.random.nextInt(0, 100) < 25;

      // Pre-compute existing SAM coverage for each protectable structure.
      let structureCoverage = null;
      if (useCoverageWeighting) {
        structureCoverage = this.existingSamStructureCoverage(protectEntries);
      }

      return (tile) => {
        let w = 0;

        // Prefer higher elevations
        w += game.magnitude(tile);

        // Prefer to be away from the border
        w += Math.min(nearestBorder(tile), borderSpacing);

        // Prefer to be away from other structures of the same type
        const closestOtherDist = nearestOther(tile);
        if (Number.isFinite(closestOtherDist)) {
          w += Math.min(closestOtherDist, structureSpacing);
        }

        // Prefer to be in range of other structures (skip on easy difficulty)
        if (difficulty !== Difficulty.Easy) {
          for (const entry of protectEntries) {
            const distanceSquared = game.euclideanDistSquared(tile, entry.tile);
            if (distanceSquared > rangeSquared) continue;
            if (useCoverageWeighting && structureCoverage !== null) {
              const coverage = structureCoverage.get(entry.tile) ?? 0;
              const coverageWeight = 1 / (1 + coverage);
              w += structureSpacing * entry.weight * coverageWeight;
            } else {
              w += structureSpacing * entry.weight;
            }
          }
        }

        // Extend a useful friendly SAM umbrella only when this site protects an
        // additional asset. This favors coherent own/allied coverage without
        // stacking a redundant launcher inside an already complete umbrella.
        w += friendlySamNetworkScore(tile);

        return w;
      };
    }

    friendlyUsefulSamPlacementScore(protectedTiles, structureSpacing) {
      if (protectedTiles === null || protectedTiles.size === 0) {
        return () => 0;
      }
      const config = this.game.config();
      const candidateRange = Math.max(
        0,
        Number(config.samRange?.(1) ?? config.defaultSamRange?.() ?? 0),
      );
      if (candidateRange <= 0) return () => 0;
      const anchors = this.legendaryFriendlySamUnits()
        .map((sam) => {
          const level = Math.max(1, Number(sam.level()));
          const currentRange = Math.max(0, Number(config.samRange(level)));
          const upgradedRange = Math.max(
            currentRange,
            Number(config.samRange(level + 1)),
          );
          return { tile: sam.tile(), currentRange, upgradedRange };
        })
        .filter((anchor) => anchor.currentRange > 0 && anchor.upgradedRange > 0);
      if (anchors.length === 0) return () => 0;
      const candidateRangeSquared = candidateRange * candidateRange;
      const anchorProfiles = anchors
        .map((anchor) => {
