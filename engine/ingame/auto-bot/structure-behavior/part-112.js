      const context = { centers, referenceDistance: 120 };
      this._legendarySiloReachContext = context;
      return context;
    }

    legendarySiloOffensiveReachScore(tile, context, spacing) {
      if (!context || context.centers.length === 0) return 0;
      const tx = this.game.x(tile);
      const ty = this.game.y(tile);
      let nearestSquared = Infinity;
      for (const { x, y } of context.centers) {
        const dx = tx - x;
        const dy = ty - y;
        const distSquared = dx * dx + dy * dy;
        if (distSquared < nearestSquared) nearestSquared = distSquared;
      }
      if (!Number.isFinite(nearestSquared)) return 0;
      const distance = Math.sqrt(nearestSquared);
      const reference = Math.max(1, Number(context.referenceDistance) || 1);
      // Linear falloff: at distance 0 the candidate earns the full spacing
      // bonus; at the reference distance (and beyond) it earns nothing. The
      // bonus is capped at one spacing unit so it cannot pull a silo out of
      // its defensive SAM umbrella (the samCoverageBonus base is ≥50000).
      const ratio = Math.min(1, Math.max(0, 1 - distance / reference));
      return ratio * spacing;
    }

    legendarySamCoveragePlacementContext() {
      const config = this.game.config();
      const range = Number(config.defaultSamRange());
      if (range <= 0) return null;
      const existingSams = this.legendaryFriendlySamUnits();
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      const samRangeByLevel = new Map();
      const samRangeForLevel = (level) => {
        if (!samRangeByLevel.has(level)) {
          samRangeByLevel.set(level, Number(config.samRange(level)));
        }
        return samRangeByLevel.get(level);
      };
      const existingSamCoverage = [];
      for (const sam of existingSams) {
        const samRange = samRangeForLevel(sam.level());
        existingSamCoverage.push({
          tile: sam.tile(),
          rangeSquared: samRange * samRange,
        });
      }
      // Existing SAM coverage does not depend on the candidate tile. Resolve
      // it once per placement decision so every candidate is evaluated only
      // against structures that still need defensive coverage.
      const uncoveredStructures = [];
      for (const structure of structures) {
        const structureTile = structure.tile();
        let covered = false;
        for (const {
          tile: samTile,
          rangeSquared: samRangeSquared,
        } of existingSamCoverage) {
          if (
            this.game.euclideanDistSquared(structureTile, samTile) <=
            samRangeSquared
          ) {
            covered = true;
            break;
          }
        }
        if (!covered) {
          uncoveredStructures.push({ structure, tile: structureTile });
        }
      }
      const criticalValueCache = new Map();
      return {
        rangeSquared: range * range,
        candidateSamRange: samRangeForLevel(1),
        uncoveredStructures,
        criticalValueCache,
        spacing: this.spacingConstants().structureSpacing,
      };
    }

    legendarySamCoveragePlacementScore(
      tile,
      missileContext = null,
      coverageContext = null,
    ) {
      const coverage =
        coverageContext || this.legendarySamCoveragePlacementContext();
      if (coverage === null) return 0;
      let score = 0;
      const {
        rangeSquared,
        candidateSamRange,
        uncoveredStructures,
        criticalValueCache,
        spacing,
      } = coverage;
      // Track the positions this candidate covers so we can reward genuine
      // geographic spread. Two critical structures far apart represent two
      // independent targets an opponent could choose between; a tight clump is
      // one blast zone that a single SAM already covers completely. Without a
      // spread signal, every candidate that happens to sit near one dense
      // cluster ties, and the tie-break ignores that a different candidate
      // might shield a second, otherwise-uncovered cluster.
      const coveredTiles = [];
      let coveredCritical = 0;
      for (const { structure, tile: structureTile } of uncoveredStructures) {
        if (
          this.game.euclideanDistSquared(tile, structureTile) > rangeSquared
        ) {
          continue;
        }
        let criticalValue = criticalValueCache.get(structure);
        if (criticalValue === undefined) {
          criticalValue = this.legendaryCriticalStructureValue(structure);
          criticalValueCache.set(structure, criticalValue);
        }
        score += spacing * criticalValue;
        coveredTiles.push(structureTile);
        if (criticalValue > 0) coveredCritical++;
      }
      // Diversity bonus: when a candidate covers two or more critical
      // structures that are spatially separated, it is strictly more valuable
      // than one whose covered structures cluster within a single blast
      // radius. Reward the spread so a candidate shielding two distinct
      // production sites outranks one double-counting the same cluster.
      if (coveredCritical >= 2) {
        score += this.legendarySamCoverageSpreadBonus(
          tile,
          coveredTiles,
          spacing,
        );
      }
      return (
        score +
        this.legendarySamImpactMarginScore(
          tile,
          missileContext || this.getMissileDefenseContext(),
          1,
          candidateSamRange,
        )
      );
    }

    // Diversity bonus for a SAM candidate that shields several critical
    // structures at once. The bonus grows with the pairwise spread of the
    // covered tiles relative to the candidate SAM's range, so a candidate
    // whose covered structures sit at opposite edges of its envelope earns
    // more than one whose covered structures huddle near the centre (the
    // latter is a single cluster any repositioned SAM could still reach).
    // The bonus is bounded by one spacing unit so it can break ties between
    // otherwise-equivalent candidates without overriding raw coverage count.
    legendarySamCoverageSpreadBonus(tile, coveredTiles, spacing) {
      if (!Array.isArray(coveredTiles) || coveredTiles.length < 2) return 0;
      const game = this.game;
