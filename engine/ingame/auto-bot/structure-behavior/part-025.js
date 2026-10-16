        Number.isFinite(tick) &&
        this._hostileMissileImpactZonesTick === tick
      ) {
        return this._hostileMissileImpactZonesCache;
      }
      const cache = (zones) => {
        if (Number.isFinite(tick)) {
          this._hostileMissileImpactZonesTick = tick;
          this._hostileMissileImpactZonesCache = zones;
        }
        return zones;
      };
      if (typeof this.game?.units !== "function") return cache([]);
      const config = this.game.config?.();
      if (!config || typeof config.nukeMagnitudes !== "function") {
        return cache([]);
      }
      const missiles = this.missileFamilyUnitsSnapshot(
        UNIT.AtomBomb,
        UNIT.HydrogenBomb,
        UNIT.MIRV,
        UNIT.MIRVWarhead,
      );
      if (!Array.isArray(missiles)) return cache([]);

      const zones = [];
      for (const missile of missiles) {
        const zone = this.hostileMissileImpactZone(missile, config);
        if (zone !== null) zones.push(zone);
      }
      return cache(zones);
    }

    hostileMissileImpactZone(missile, config) {
      // NukeExecution deletes every structure inside the blast regardless of
      // owner or alliance. Own and allied missiles are therefore placement
      // hazards too, even though only hostile missiles drive SAM strategy.
      if (!isActiveStructureMissileThreat(missile)) return null;
      const targetTile = missile.targetTile?.();
      const type = missile.type?.();
      // A MIRV carrier has no direct magnitude, but it deterministically emits
      // warheads across a 1500-tile field around its destination. Construction
      // inside that potential field is doomed even before the individual
      // warhead destinations become visible. Derive the conservative zone from
      // the supported warhead magnitude without querying nukeMagnitudes(MIRV),
      // which the authoritative engine intentionally does not define.
      const magnitudeType = type === UNIT.MIRV ? UNIT.MIRVWarhead : type;
      const warheadFieldRadius = type === UNIT.MIRV
        ? MIRV_CARRIER_TARGET_RADIUS
        : 0;
      const radius =
        warheadFieldRadius + Number(config.nukeMagnitudes(magnitudeType)?.outer);
      if (targetTile === null || targetTile === undefined) return null;
      if (!Number.isFinite(radius) || radius <= 0) return null;
      return { targetTile, radiusSquared: radius * radius };
    }

    tileInsideActiveHostileMissileImpact(tile) {
      if (tile === null || tile === undefined) return false;
      if (typeof this.game?.euclideanDistSquared !== "function") return false;
      for (const zone of this.activeHostileMissileImpactZones()) {
        if (
          this.game.euclideanDistSquared(tile, zone.targetTile) <=
          zone.radiusSquared
        ) {
          return true;
        }
      }
      return false;
    }

    observeHostileMissileLaunch() {
      return this.hasObservedHostileMissileLaunch();
    }

    hasHostileReachedSiloGoldThreshold() {
      const snapshot = this.hostileThreatSnapshot();
      return snapshot === null ? null : snapshot.reachedSiloGoldThreshold;
    }

    hasHostileSiloThreat() {
      const snapshot = this.hostileThreatSnapshot();
      return snapshot === null ? null : snapshot.siloThreat;
    }

    hostileThreatSnapshot() {
      const snapshotTick = safeStructureGameTick(this.game);
      if (
        snapshotTick !== null &&
        this._hostileThreatSnapshotTick === snapshotTick &&
        this._hostileThreatSnapshot !== null
      ) {
        return this._hostileThreatSnapshot;
      }

      const hostile = this.liveNuclearHostilePlayers();
      if (hostile === null) return null;
      const siloSummary = this.hostileMissileSiloCapacitySummary();
      const goldThreat = this.hostileGoldThreat(hostile);
      const snapshot = {
        reachedSiloGoldThreshold: goldThreat.reachedSiloGoldThreshold,
        siloThreat:
          goldThreat.siloThreat ||
          (siloSummary !== null && siloSummary.builtHostileSiloCount > 0),
        hostileSiloCount: siloSummary?.hostileSiloCount ?? 0,
        hostileSiloCapacity: siloSummary?.hostileSiloCapacity ?? 0,
      };
      if (snapshotTick !== null) {
        this._hostileThreatSnapshotTick = snapshotTick;
        this._hostileThreatSnapshot = snapshot;
      }
      return snapshot;
    }

    hostileGoldThreat(hostilePlayers) {
      let reachedSiloGoldThreshold = false;
      let siloThreat = false;
      for (const other of hostilePlayers) {
        const gold = this.playerGoldBigInt(other);
        if (gold === null) continue;
        if (gold >= HOSTILE_SILO_GOLD_THRESHOLD) reachedSiloGoldThreshold = true;
        if (gold >= HOSTILE_SAM_TRIGGER_GOLD_THRESHOLD) siloThreat = true;
      }
      return { reachedSiloGoldThreshold, siloThreat };
    }

    // ── Enemy-economy/silo nuclear threat forecast ──────────────────────────
    // Goal requirement: weigh the enemies' CURRENT AND PREDICTED economy plus
    // their Silo LEVELS when deciding economy vs SAM construction. The chest
    // (which freezes economic builds to fund the interceptor) binds ONLY when
    // the forecast says we cannot outpace the threat: if our SAM-readiness
    // ETA lands comfortably before the enemies' next-nuclear-capability ETA,
    // economy growth proceeds — compounding income makes every later defense
    // cheaper.
    hostileRichestGold(mySid) {
      let richest = 0;
      for (const other of this.game.players()) {
        if (!other?.isPlayer?.() || other.smallID() === mySid) continue;
        if (!other.isAlive?.()) continue;
        if (this.player.isFriendly?.(other) === true) continue;
        const gold = Number(other.gold?.() || 0);
        if (gold > richest) richest = gold;
      }
      return richest;
    }

    hostileSiloLevelSum() {
      return Number(this.hostileMissileSiloCapacitySummary()?.hostileSiloCount ?? 0);
    }

    hostileNuclearThreatSample() {
      const tick = Number(this.game?.ticks?.() ?? 0);
      if (!Array.isArray(state.hostileEconSamples)) state.hostileEconSamples = [];
      const samples = state.hostileEconSamples;
      let last = samples[samples.length - 1];
      if (last && tick < last.tick) {
        samples.length = 0;
        if (Array.isArray(state.ownEconSamples)) state.ownEconSamples.length = 0;
        last = null;
      }
