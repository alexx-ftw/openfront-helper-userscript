        );
      }
      const centerScore = legendaryPlacementProximityScore(centerDistance, radius);
      const borderScore = Number.isFinite(borderDistance)
        ? legendaryPlacementProximityScore(borderDistance, radius)
        : 0;
      // The border term is dominant: this explicitly selects the own border
      // segment closest to the team's geometric center, then favors tiles near
      // the center itself as the tie-break.
      return spacing * (1.5 * borderScore + 0.5 * centerScore);
    }

    enemyMissileSiloPressure() {
      return this.enemyMissileSiloCapacityTarget();
    }

    // Custom missile parity target: count the projected level sum of each
    // hostile player's relevant unit and choose the strongest single opponent.
    // An under-construction unit counts as one future level so the target does
    // not lag behind a unit that is about to complete.
    enemyUnitCapacityParityTarget(type, maxCapacity) {
      const enemyUnitLevels = [];
      for (const enemy of this.legendaryNuclearHostilePlayers()) {
        const levels = this.enemyProjectedUnitLevels(enemy, type);
        if (levels.length > 0) enemyUnitLevels.push(levels);
      }
      return maxCapacity(enemyUnitLevels);
    }

    enemyProjectedUnitLevels(enemy, type) {
      {
        if (enemy.isAlive && enemy.isAlive() === false) return [];
        return (enemy.units(type) || [])
          .map((unit) => this.projectedUnitLevel(unit))
          .filter((level) => level !== null);
      }
    }

    projectedUnitLevel(unit) {
      if (unit.isUnderConstruction && unit.isUnderConstruction()) return 1;
      if (unit.isActive && unit.isActive() === false) return null;
      const level = Number(unit.level?.() ?? 1);
      return Number.isFinite(level) ? Math.max(1, Math.floor(level)) : null;
    }

    enemySamCapacityParityTarget() {
      return this.enemyUnitCapacityParityTarget(
        UNIT.SAMLauncher,
        legendaryMaxEnemySamCapacity,
      );
    }

    enemyMissileSiloCapacityParityTarget() {
      return this.enemyUnitCapacityParityTarget(
        UNIT.MissileSilo,
        legendaryMaxEnemySiloCapacity,
      );
    }

    enemyUnitCapacityTarget(type) {
      if (type === UNIT.MissileSilo) {
        return this.hostileMissileSiloCapacitySummary()?.hostileSiloCapacity ?? 0;
      }
      const hostile = this.liveNuclearHostilePlayers();
      if (hostile === null) return 0;
      let capacity = 0;
      for (const enemy of hostile) {
        const metrics = this.playerUnitCapacitySummary(enemy, type);
        if (metrics !== null) capacity += metrics.capacity;
      }
      return capacity;
    }

    enemyMissileSiloCapacityTarget() {
      // Unlike offensive target selection, defensive capacity must include
      // every live hostile silo: all of them can contribute to one salvo.
      return this.enemyUnitCapacityTarget(UNIT.MissileSilo);
    }

    missileSiloParityTarget() {
      return state.settings.winFixes ? this.enemySamCapacityParityTarget() : 0;
    }

    missileSiloParityGap() {
      return Math.max(
        0,
        this.missileSiloParityTarget() - this.ownedLevels(UNIT.MissileSilo),
      );
    }

    missileSiloPhysicalCapReached() {
      const siloCount = (this.player?.units?.(UNIT.MissileSilo) ?? []).length;
      const parityGap = this.missileSiloParityGap();
      return (
        siloCount >= MAX_MISSILE_SILOS &&
        (parityGap <= 0 || !Number.isFinite(parityGap))
      );
    }

    ownMaximumSamLevel() {
      let maximum = 0;
      for (const sam of this.player.units(UNIT.SAMLauncher) || []) {
        {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) continue;
          if (sam.isActive && sam.isActive() === false) continue;
          const level = Number(sam.level?.() ?? 1);
          if (Number.isFinite(level)) {
            maximum = Math.max(maximum, Math.max(1, Math.floor(level)));
          }
        }
      }
      return maximum;
    }

    samLevelParityTarget() {
      return state.settings.winFixes
        // Match the documented parity rule: compare against the strongest
        // hostile player's Silo network, not the sum of unrelated enemies.
        ? this.enemyMissileSiloCapacityParityTarget()
        : 0;
    }

    samLevelParityGap() {
      return Math.max(0, this.samLevelParityTarget() - this.ownSamCapacity());
    }

    /**
     * Returns the greatest built-silo level sum belonging to one live hostile
     * player. A level-1 Silo contributes one; under-construction Silos are not
     * included because this is the current threat, not a future projection.
     */
    hostileSiloLevelSumTarget() {
      const hostilePlayers = this.liveNuclearHostilePlayers();
      if (!Array.isArray(hostilePlayers)) return 0;

      let maximum = 0;
      for (const enemy of hostilePlayers) {
        maximum = Math.max(maximum, this.hostileBuiltSiloLevelSum(enemy));
      }
      return maximum;
    }

    // A placed silo network belonging to any live nuclear-hostile player
    // changes our defensive requirement immediately, without waiting for
    // construction to finish. Breakable allies remain hostile, while permanent
    // teammates are excluded. Keep the target per player: unrelated level-one
    // Silos must not be added into a fictitious single salvo.
    externalSiloLevelSumTarget() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return this.hostileSiloLevelSumTarget();
      }
      const mySid = this.readPlayerSmallId(this.player);
      let maximum = 0;
      for (const other of this.game.players()) {
        if (!this.isLiveNuclearHostilePlayer(other, mySid)) continue;
        const capacity = this.playerUnitCapacitySummary(
          other,
          UNIT.MissileSilo,
        )?.capacity ?? 0;
        maximum = Math.max(maximum, capacity);
