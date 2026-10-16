        if (metrics === null) continue;
        hostileSiloCount += metrics.count;
        hostileSiloCapacity += metrics.capacity;
        builtHostileSiloCount += metrics.builtCount;
      }

      const summary = {
        hostileSiloCount,
        hostileSiloCapacity,
        builtHostileSiloCount,
      };
      if (snapshotTick !== null) {
        this._hostileSiloCapacitySnapshotTick = snapshotTick;
        this._hostileSiloCapacitySnapshot = summary;
      }
      return summary;
    }

    hasBuiltMissileSilo(player) {
      return (
        this.playerUnitCapacitySummary(player, UNIT.MissileSilo)?.builtCount ??
        0
      ) > 0;
    }

    hasBuiltHostileSiloThreat() {
      const summary = this.hostileMissileSiloCapacitySummary();
      return summary !== null && summary.builtHostileSiloCount > 0;
    }

    hasBuiltExternalSiloThreat() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return false;
      }
      const mySid = this.readPlayerSmallId(this.player);
      return this.game.players().some(
        (other) =>
          this.isLiveNuclearHostilePlayer(other, mySid) &&
          this.hasBuiltMissileSilo(other),
      );
    }

    hasPlacedHostileSiloThreat() {
      const summary = this.hostileMissileSiloCapacitySummary();
      return summary !== null && summary.hostileSiloCount > 0;
    }

    // A Silo placed by any live nuclear-hostile player is an immediate global
    // defense trigger. Breakable diplomatic allies remain hostile for nuclear
    // planning; permanent teammates do not. Do not cache the result because a
    // build event may arrive between two structure decisions in one game tick.
    hasPlacedSiloOnMap() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return false;
      }
      const mySid = this.readPlayerSmallId(this.player);
      for (const other of this.game.players()) {
        if (!this.isLiveNuclearHostilePlayer(other, mySid)) continue;
        const metrics = this.playerUnitCapacitySummary(other, UNIT.MissileSilo);
        if (metrics !== null && metrics.count > 0) return true;
      }
      return false;
    }

    isLiveOtherPlayer(other, mySid) {
      if (!other || other === this.player) return false;
      if (typeof other.isPlayer === "function" && !other.isPlayer()) return false;
      const otherSid = this.readPlayerSmallId(other);
      if (mySid !== null && otherSid === mySid) return false;
      return !(typeof other.isAlive === "function" && !other.isAlive());
    }

    // Gold alone opens the SAM-building gate, but it does not justify running
    // the full trajectory planner: until a hostile silo or missile exists the
    // forecast has no incoming routes to model. Keep this cheap signal separate
    // from hostileThreatSnapshot(), whose gold thresholds are still used by the
    // construction policy.
    missileDefenseSignalSnapshot() {
      const signalTick =
        typeof this.game?.ticks === "function"
          ? Number(this.game.ticks())
          : null;
      const cacheSignal = (signal) => {
        if (Number.isFinite(signalTick)) {
          this._missileDefenseSignalTick = signalTick;
          this._missileDefenseSignalCache = signal;
        }
        return signal;
      };
      const hostile = this.liveNuclearHostilePlayers();
      if (hostile === null) return cacheSignal(null);

      const hasBuiltHostileSilo = hostile.some((other) =>
        this.hasBuiltMissileSilo(other),
      );
      const hasActiveHostileMissile = this.activeHostileMissileSnapshot(true);
      if (hasActiveHostileMissile === null) {
        return cacheSignal({
          hasBuiltHostileSilo,
          hasActiveHostileMissile: null,
        });
      }
      return cacheSignal({ hasBuiltHostileSilo, hasActiveHostileMissile });
    }

    hasMissileDefenseSignal() {
      const signal = this.missileDefenseSignalSnapshot();
      if (signal === null) return null;
      if (
        signal.hasActiveHostileMissile === null &&
        !signal.hasBuiltHostileSilo
      ) {
        return null;
      }
      return (
        signal.hasBuiltHostileSilo || signal.hasActiveHostileMissile === true
      );
    }

    hasObservedHostileMissileLaunch() {
      if (this._hostileMissileLaunchObserved === true) return true;
      if (this.activeHostileMissileSnapshot() !== true) return false;
      this._hostileMissileLaunchObserved = true;
      return true;
    }

    activeHostileMissileSnapshot(forceRefresh = false) {
      const tick = safeStructureGameTick(this.game);
      if (
        !forceRefresh &&
        Number.isFinite(tick) &&
        this._activeHostileMissileTick === tick
      ) {
        return this._activeHostileMissileCache;
      }
      const cache = (value) => {
        if (Number.isFinite(tick)) {
          this._activeHostileMissileTick = tick;
          this._activeHostileMissileCache = value;
        }
        return value;
      };
      if (typeof this.game?.units !== "function") return cache(null);
      const activeMissiles = this.missileFamilyUnitsSnapshot(
          UNIT.AtomBomb,
          UNIT.HydrogenBomb,
          UNIT.MIRV,
          UNIT.MIRVWarhead,
        );
      if (!Array.isArray(activeMissiles)) return cache(null);
      const mySid = this.player.smallID();
      for (const missile of activeMissiles) {
        if (isHostileActiveMissile(this.player, missile, mySid)) return cache(true);
      }
      return cache(false);
    }

    activeHostileMissileImpactZones() {
      const tick = safeStructureGameTick(this.game);
      if (
