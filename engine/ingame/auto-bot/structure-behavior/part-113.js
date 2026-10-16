      let maxPairwiseSquared = 0;
      for (let i = 0; i < coveredTiles.length; i++) {
        for (let j = i + 1; j < coveredTiles.length; j++) {
          const distSquared = game.euclideanDistSquared(
            coveredTiles[i],
            coveredTiles[j],
          );
          if (distSquared > maxPairwiseSquared) maxPairwiseSquared = distSquared;
        }
      }
      if (maxPairwiseSquared <= 0) return 0;
      const maxPairwise = Math.sqrt(maxPairwiseSquared);
      const range = Math.max(1, Number(game.config?.()?.defaultSamRange?.() ?? 0));
      // Normalize spread against the SAM range: a pair separated by the full
      // range diameter earns the whole bonus; a pair separated by less than a
      // quarter of the range is treated as a clump and earns nothing.
      const spreadRatio = Math.min(1, Math.max(0, (maxPairwise / range - 0.25) / 0.75));
      return spreadRatio * spacing;
    }

    // missileSiloValue — NationStructureBehavior.ts:892.
    missileSiloValue() {
      const game = this.game;
      const borderTiles = this.player.borderTiles();
      const otherUnits = this.player.units(UNIT.MissileSilo);
      const { borderSpacing, structureSpacing } = this.spacingConstants();

      return (tile) => {
        let w = 0;

        // Prefer higher elevations
        w += game.magnitude(tile);

        // Prefer to be away from the border
        const closest = closestTile(game, borderTiles, tile);
        const closestBorderDist = closest[1];
        w += Math.min(closestBorderDist, borderSpacing);

        // Prefer to be away from other structures of the same type
        const otherTiles = new Set(otherUnits.map((u) => u.tile()));
        otherTiles.delete(tile);
        const closestOther = closestTwoTiles(game, otherTiles, [tile]);
        if (closestOther !== null) {
          const d = game.manhattanDist(closestOther.x, tile);
          w += Math.min(d, structureSpacing);
        }

        // WIN-FIX (NOT in src): build the silo INSIDE a SAM's protection so it's defended
        // against enemy nukes — our OWN SAM first, an ALLY's SAM as a fallback if we have
        // none, closest-to-SAM best. The huge base makes coverage dominate the elevation/
        // spacing terms while those still break ties WITHIN the covered tiles.
        if (state.settings.winFixes) {
          w += this.samCoverageBonus(tile);
        }

        return w;
      };
    }

    // samCoverageBonus — large score if `tile` sits inside a SAM's range. OWN SAMs win
    // (≥100000) over ALLY SAMs (≥50000), and being CLOSER to the covering SAM scores a
    // little higher; 0 when no friendly SAM covers it. Used to steer silo placement.
    samCoverageBonus(tile) {
      const game = this.game;
      if (typeof game.nearbyUnits !== "function") return 0;
      let cfg;
      {
        cfg = game.config();
      }
      const maxRange =
        typeof ofhGameMaxSamRange === "function"
          ? ofhGameMaxSamRange(game, 150)
          : 150;
      let nearby;
      {
        nearby = game.nearbyUnits(tile, maxRange, UNIT.SAMLauncher);
      }
      const mySid = this.player.smallID();
      let bestOwn = -1;
      let bestAlly = -1;
      for (const entry of nearby || []) {
        const coverage = this.friendlySamCoverage(entry, tile, cfg, mySid);
        if (coverage === null) continue;
        if (coverage.isOwn) bestOwn = Math.max(bestOwn, coverage.closeness);
        else bestAlly = Math.max(bestAlly, coverage.closeness);
      }
      if (bestOwn >= 0) return 100000 + bestOwn;
      if (bestAlly >= 0) return 50000 + bestAlly;
      return 0;
    }

    friendlySamCoverage(entry, tile, cfg, mySid) {
      const unit = entry.unit || entry;
      const owner = unit.owner?.();
      if (!owner || unit.isUnderConstruction?.()) return null;
      const isOwn = owner.smallID?.() === mySid;
      if (!this.isOwnOrFriendlySamOwner(owner, isOwn)) return null;
      const range = Number(cfg?.samRange?.(Number(unit.level?.()) || 1)) || 0;
      if (range <= 0) return null;
      const distSquared = this.samEntryDistanceSquared(entry, unit, tile);
      if (!this.isWithinSamRange(distSquared, range)) return null;
      return { isOwn, closeness: range - Math.sqrt(distSquared) };
    }

    isWithinSamRange(distanceSquared, range) {
      return distanceSquared != null && distanceSquared <= range * range;
    }

    isOwnOrFriendlySamOwner(owner, isOwn) {
      return isOwn || this.player.isFriendly(owner) === true;
    }

    samEntryDistanceSquared(entry, unit, tile) {
      if (entry.distSquared != null) return entry.distSquared;
      if (!this.game.euclideanDistSquared || !unit.tile) return null;
      return this.game.euclideanDistSquared(tile, unit.tile());
    }

    // Candidate tiles inside the eventual range of an existing own or allied
    // SAM. Sampling is shared fairly across launchers and begins at each SAM's
    // center, so the bounded probe set can actually express "as close as
    // possible" instead of filling itself from one launcher's range edge.
    tilesNearFriendlySams(maxTiles) {
      const game = this.game;
      if (typeof game.units !== "function") return [];
      const mySid = this.player.smallID();
      let allSams;
      {
        allSams = game.units(UNIT.SAMLauncher) || [];
      }
      const { own, ally } = this.partitionFriendlySams(allSams, mySid);
      const useSams = own.concat(ally);
      if (useSams.length === 0) return [];
      let cfg;
      {
        cfg = game.config();
      }
      const out = [];
      const seen = new Set();
      const perSamLimit = Math.max(1, Math.ceil(maxTiles / useSams.length));
      for (const unit of useSams) {
        const local = [];
        this.appendTilesNearSam({
          unit,
          cfg,
          mySid,
          seen,
          out: local,
          maxTiles: perSamLimit,
        });
        out.push(...local);
        if (out.length >= maxTiles) return out;
      }
      return out.slice(0, maxTiles);
    }

    partitionFriendlySams(allSams, mySid) {
      const own = [];
      const ally = [];
      for (const unit of allSams) {
