      // remaining arrival. Unknown timing retains the full-capacity fallback.
      const unavailable = queue.filter((firedAt) =>
        Number.isFinite(firedAt) && firedAt + cooldown > lastArrivalTick).length;
      return Math.max(0, sam.level() - unavailable);
    }

    /**
     * On Impossible difficulty, when no good nuke target is available (score <= 0),
     * attempt to destroy enemy SAMs by overwhelming them with atom bombs.
     * A SAM of level N can intercept N nukes before going on cooldown,
     * so we need N+1 bombs to destroy it (accounting for all covering SAMs).
     */
    // ── maybeDestroyEnemySam — NationNukeBehavior.ts:780 (now async) ──────────
    // Deliverable-capacity realism: a silo only contributes shots it can
    // launch this window. Same slot projection as getAvailableSiloEntries —
    // cooldown queues and pending launches are not capacity.
    readySiloShotCapacity(silos) {
      const projected = typeof autoBotBuildNukeSlots === "function"
        ? autoBotBuildNukeSlots(this.game, this.player) : null;
      return (silos || []).reduce(
        (sum, silo) => sum + this.siloReadyShotSlots(silo, projected),
        0,
      );
    }

    siloReadyShotSlots(silo, projected) {
      if (silo?.isUnderConstruction?.() === true || silo?.isActive?.() === false) return 0;
      if (projected) return projected.get(String(silo.id())) ?? 0;
      const queue = Number(silo.missileTimerQueue?.()?.length) || 0;
      return Math.max(0, (Number(silo.level?.()) || 1) - queue);
    }

    rankableSiloTiles(silos) {
      const projected = typeof autoBotBuildNukeSlots === "function"
        ? autoBotBuildNukeSlots(this.game, this.player) : null;
      const readySilos = (silos || []).filter(
        (silo) => this.siloReadyShotSlots(silo, projected) > 0,
      );
      return (readySilos.length > 0 ? readySilos : silos || []).map((u) => u.tile());
    }

    getAvailableSiloEntries(silos, targetTile, coveringSamIds) {
      if (silos.length === 0) return [];
      const speed = this.game.config().defaultNukeSpeed();
      const projected = typeof autoBotBuildNukeSlots === "function"
        ? autoBotBuildNukeSlots(this.game, this.player) : null;
      const entries = silos.map((silo) => {
        // DIVERGENCE: retained client views can change during the async price probe.
        if (silo.isActive?.() === false || silo.isUnderConstruction?.() === true) return null;
        const slots = projected
          ? projected.get(String(silo.id())) ?? 0 : silo.level() - silo.missileTimerQueue().length;
        if (slots <= 0) return null;
        const pathFinder = UniversalPathFinding.Parabola(this.game, {
          increment: speed, distanceBasedHeight: true, directionUp: true,
        });
        const trajectory = pathFinder.findPath(silo.tile(), targetTile) ?? [];
        if (trajectory.length === 0) return null;
        return {
          silo, slots, flightTicks: trajectory.length,
          interceptable: this.isTrajectoryInterceptableBySam(
            silo.tile(), targetTile, coveringSamIds,
          ),
        };
      }).filter(Boolean);
      return entries.sort((a, b) =>
        this.game.manhattanDist(a.silo.tile(), targetTile) -
        this.game.manhattanDist(b.silo.tile(), targetTile));
    }

    createSamLaunchSequence(siloEntries) {
      return siloEntries.flatMap((entry) =>
        Array.from({ length: entry.slots }, () => ({
          flightTicks: entry.flightTicks,
          interceptable: entry.interceptable,
        })));
    }

    findSamArrivalWindow(bombs, maxSpread) {
      const sorted = [...bombs].sort((a, b) => a.flightTicks - b.flightTicks);
      let bestStart = 0;
      let bestCount = 0;
      for (let start = 0; start < sorted.length; start++) {
        let end = start;
        while (end < sorted.length &&
          sorted[end].flightTicks - sorted[start].flightTicks <= maxSpread) end++;
        if (end - start > bestCount) {
          bestStart = start;
          bestCount = end - start;
        }
      }
      return sorted.slice(bestStart, bestStart + bestCount);
    }

    createSamOverwhelmPlan(targetSam, silos, nukeTarget = null) {
      const demandTargetTile = state.nukeWantSlots?.targetSamId;
      const pinnedTile =
        demandTargetTile !== null &&
        demandTargetTile !== undefined &&
        String(state.nukeWantSlots.targetSamId) === String(targetSam.id())
          ? state.nukeWantSlots.targetTile
          : null;
      const targetTile = pinnedTile ?? this.samSalvoAimTile(targetSam, nukeTarget);
      if (targetTile == null ||
          (pinnedTile != null && this.blastHitsFriendlyLand(targetTile, UNIT.AtomBomb))) {
        return null;
      }
      const coveringSams = this.findEnemySamsCoveringTile(targetTile, true);
      const coveringSamIds = new Set(coveringSams.map((sam) => sam.id()));
      const coveringSamLevels = coveringSams.reduce(
        (sum, sam) => sum + sam.level(),
        0,
      );
      const bombsNeeded = coveringSamLevels + 1;
      const totalBombs = bombsNeeded + Math.floor(bombsNeeded / 5);
      const siloEntries = this.getAvailableSiloEntries(silos, targetTile, coveringSamIds);
      const launchSequence = this.createSamLaunchSequence(siloEntries);
      const unblocked = launchSequence
        .map((bomb, index) => ({ ...bomb, index }))
        .filter((bomb) => !bomb.interceptable);
      const maxSpread = Math.floor(this.game.config().SAMCooldown() / 2);
      const window = this.findSamArrivalWindow(unblocked, maxSpread);
      return {
        targetTile, coveringSamIds, coveringSamLevels, targetSamId: targetSam.id(),
        totalBombs, siloEntries,
        launchSequence, maxSpread, window,
        capacityMissing: unblocked.length < totalBombs || window.length < totalBombs,
      };
    }

    // Aim-point selection for anti-SAM salvos: the bomb must still destroy
    // the SAM (kept inside the outer blast radius), but among the tiles that
    // qualify, prefer the one whose blast also covers the most enemy
    // structure value — measured bombs routinely landed on structure-poor
    // tiles and converted a full salvo into zero destroyed gold.
    samSalvoAimTile(targetSam, nukeTarget = null) {
      const samTile = targetSam.tile();
      const magnitude = this.game.config().nukeMagnitudes(UNIT.AtomBomb);
      const radius = Number(magnitude?.outer) || 0;
      if (radius <= 0) return this.safeSamSalvoAimTile(samTile);
      const enemy = targetSam.owner?.();
      const structures = unitsOfTypes(enemy);
      if (nukeTarget?.smallID?.() !== enemy?.smallID?.()) {
        structures.push(...unitsOfTypes(nukeTarget));
      }
      if (structures.length === 0) return this.safeSamSalvoAimTile(samTile);
      const bestTile = this.bestSamSalvoAimTile(samTile, structures, magnitude, radius);
      return bestTile !== null && !this.blastHitsFriendlyLand(bestTile, UNIT.AtomBomb)
        ? bestTile
        : null;
    }

    safeSamSalvoAimTile(tile) {
      return this.blastHitsFriendlyLand(tile, UNIT.AtomBomb) ? null : tile;
    }

    bestSamSalvoAimTile(samTile, structures, magnitude, radius) {
      const samX = this.game.x(samTile);
      const samY = this.game.y(samTile);
      let bestTile = null;
      // DIVERGENCE: monetary enemy value needs a monetary friendly-loss penalty.
      let bestValue = -Infinity;
      if (!this.blastHitsFriendlyLand(samTile, UNIT.AtomBomb)) {
        bestTile = samTile;
        bestValue = this.blastStructureValue(samTile, structures, radius) -
          this.friendlyFirePenalty(samTile, magnitude, true);
      }
      for (const structure of structures) {
        const tile = structure.tile?.();
        if (tile == null) continue;
        const dx = this.game.x(tile) - samX;
        const dy = this.game.y(tile) - samY;
        const candidateX = Math.round(samX + dx * 0.5);
        const candidateY = Math.round(samY + dy * 0.5);
        if (!this.game.isValidCoord(candidateX, candidateY)) continue;
        const candidate = this.game.ref(candidateX, candidateY);
        // The SAM itself must remain inside the blast or the salvo loses
        // its anti-SAM purpose.
        if (this.game.euclideanDistSquared(candidate, samTile) >= radius * radius) continue;
        if (this.blastHitsFriendlyLand(candidate, UNIT.AtomBomb)) continue;
        const value = this.blastStructureValue(candidate, structures, radius) -
          this.friendlyFirePenalty(candidate, magnitude, true);
        if (value > bestValue) {
          bestValue = value;
          bestTile = candidate;
        }
      }
      return bestTile;
    }

    blastStructureValue(tile, structures, radius) {
