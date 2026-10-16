        .map((tile) => ({ tile, compactness: compactness(tile) }))
        .sort((left, right) =>
          this.compareStructurePlacementScores(
            { v: 0, compactness: left.compactness },
            { v: 0, compactness: right.compactness },
          ),
        )
        .map((entry) => entry.tile);
    }

    nearestTileDistanceScorer(refs, excludeCandidate = false) {
      const coordinates = [];
      for (const ref of refs) {
        const x = Number(this.game.x(ref));
        const y = Number(this.game.y(ref));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        coordinates.push({ ref, x, y });
      }
      return (tile) => {
        const x = Number(this.game.x(tile));
        const y = Number(this.game.y(tile));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
        let nearest = Infinity;
        for (const coordinate of coordinates) {
          if (excludeCandidate && coordinate.ref === tile) continue;
          const distance = Math.abs(coordinate.x - x) + Math.abs(coordinate.y - y);
          if (distance < nearest) nearest = distance;
        }
        return nearest;
      };
    }

    structurePlacementCompactnessRanker(type) {
      if (!state.settings.winFixes) return null;
      // A launcher's own placement is ranked by the umbrella it would ADD, not
      // by the economic clustering axes below.
      if (type === UNIT.SAMLauncher) return this.samPlacementCoverageRanker();
      let range;
      {
        range = Number(this.game.config().defaultSamRange());
      }
      if (!Number.isFinite(range) || range <= 0) return null;
      const rangeSquared = range * range;
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      // Placement ranks up to 25 candidates.  Snapshot the immutable geometry
      // once, rather than repeatedly crossing the GameView wrapper for every
      // candidate × SAM/structure pair.  A structure decision is synchronous,
      // so this is the same snapshot the old per-candidate reads observed.
      const structureTiles = structures.map((structure) => structure.tile());
      const config = this.game.config();
      const sams = this.legendaryFriendlySamUnits().map((sam) => ({
        tile: sam.tile(),
        range: Number(config.samRange(sam.level())),
      }));
      const maxRange = Number(this.game.config().maxSamRange?.());
      const blastColocation = this.missileBlastColocationProfile(type);
      return (tile) => {
        let existingSamCoverage = 0;
        let upgradeSamCoverage = 0;
        let currentSamDistanceSquared = Number.POSITIVE_INFINITY;
        let samDistanceSquared = Number.POSITIVE_INFINITY;
        for (const sam of sams) {
          const distanceSquared = this.game.euclideanDistSquared(tile, sam.tile);
          const samRange = sam.range;
          if (
            Number.isFinite(samRange) &&
            distanceSquared <= samRange * samRange
          ) {
            existingSamCoverage = 1;
            currentSamDistanceSquared = Math.min(
              currentSamDistanceSquared,
              distanceSquared,
            );
          }
          const eventualRange = Number.isFinite(maxRange) && maxRange > 0
            ? maxRange
            : samRange;
          if (
            Number.isFinite(eventualRange) &&
            distanceSquared <= eventualRange * eventualRange
          ) {
            upgradeSamCoverage = 1;
            samDistanceSquared = Math.min(samDistanceSquared, distanceSquared);
          }
        }
        return {
          existingSamCoverage,
          upgradeSamCoverage,
          currentSamDistanceSquared,
          samDistanceSquared,
          sharedSamCoverage: structureTiles.reduce(
            (count, structureTile) =>
              count +
              (this.game.euclideanDistSquared(tile, structureTile) <= rangeSquared
                ? 1
                : 0),
            0,
          ),
          missileBlastColocationPenalty:
            blastColocation === null ? 0 : blastColocation(tile),
        };
      };
    }

    // SAM candidates are ranked by how much protectable infrastructure a
    // launcher on this tile would ADD. Counting only the structures outside
    // every existing friendly SAM's current range stops a second launcher from
    // stacking on the clump the first one already defends and sends it to the
    // exposed flank instead. The duplicate count breaks ties toward the least
    // redundant coverage circle. The generic SAM-protection axes stay neutral
    // (a launcher does not benefit from standing inside another SAM's range).
    samPlacementCoverageRanker() {
      const config = this.game.config?.();
      const fallbackRange = Number(config?.defaultSamRange?.() ?? 0);
      if (!Number.isFinite(fallbackRange) || fallbackRange <= 0) return null;
      if (typeof this.player?.units !== "function") return null;
      const configSamRange = Number(config.samRange?.(1));
      const range =
        Number.isFinite(configSamRange) && configSamRange > 0
          ? configSamRange
          : fallbackRange;
      const rangeSquared = range * range;
      const protectableTiles = this.samPlayerProtectableStructureTiles(
        this.player,
      );
      const existingSams = this.legendaryFriendlySamUnits().map((sam) => {
        const samRange = Number(config.samRange(sam.level()));
        const normalized =
          Number.isFinite(samRange) && samRange > 0 ? samRange : fallbackRange;
        return { tile: sam.tile(), rangeSquared: normalized * normalized };
      });
      const blastColocation = this.missileBlastColocationProfile(
        UNIT.SAMLauncher,
      );
      return (tile) => {
        let samIncrementalCoverage = 0;
        let samDuplicateCoverage = 0;
        for (const structureTile of protectableTiles) {
          if (
            this.game.euclideanDistSquared(tile, structureTile) > rangeSquared
          ) {
            continue;
          }
          let alreadyCovered = false;
          for (const sam of existingSams) {
            if (
              this.game.euclideanDistSquared(structureTile, sam.tile) <=
              sam.rangeSquared
            ) {
              alreadyCovered = true;
              break;
            }
          }
          if (alreadyCovered) samDuplicateCoverage++;
          else samIncrementalCoverage++;
