    legendarySamCooldownTicks() {
      const config = this.game.config();
      if (
        config === this._legendarySamCooldownConfig &&
        Number.isFinite(this._legendarySamCooldownCache)
      ) {
        return this._legendarySamCooldownCache;
      }
      const cooldown = Number(config.SAMCooldown());
      const normalizedCooldown =
        Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 90;
      this._legendarySamCooldownConfig = config;
      this._legendarySamCooldownCache = normalizedCooldown;
      return normalizedCooldown;
    }

    legendarySiloCooldownTicks() {
      const config = this.game.config();
      if (
        config === this._legendarySiloCooldownConfig &&
        Number.isFinite(this._legendarySiloCooldownCache)
      ) {
        return this._legendarySiloCooldownCache;
      }
      const cooldown = Number(config.SiloCooldown());
      const normalizedCooldown =
        Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 90;
      this._legendarySiloCooldownConfig = config;
      this._legendarySiloCooldownCache = normalizedCooldown;
      return normalizedCooldown;
    }

    legendarySamRange(level) {
      const config = this.game.config();
      const normalizedLevel = Math.max(1, Number(level) || 1);
      if (config !== this._legendarySamRangeConfig) {
        this._legendarySamRangeConfig = config;
        this._legendarySamRangeCache = new Map();
      }
      if (this._legendarySamRangeCache.has(normalizedLevel)) {
        return this._legendarySamRangeCache.get(normalizedLevel);
      }
      const range = Number(config.samRange(normalizedLevel));
      this._legendarySamRangeCache.set(normalizedLevel, range);
      return range;
    }

    // Returns the relative tick at which each enemy silo slot can launch.
    // The engine reloads only the queue front once per execution tick, so
    // already-expired entries are spaced by one tick instead of all becoming
    // available at the same instant.
    legendarySiloSlotAvailability(silo) {
      if (!silo || silo.isUnderConstruction?.()) return [];
      const level = this.normalizedStructureLevel(silo.level?.());
      const queue = this.structureMissileQueue(silo, level);
      const now = Number(this.game.ticks?.() ?? 0);
      const cooldown = this.legendarySiloCooldownTicks();
      const slots = Array(Math.max(0, level - queue.length)).fill(0);
      let previousReloadTick = -1;
      for (const firedAt of queue) {
        const nominalTick = Number.isFinite(firedAt)
          ? Math.max(0, cooldown - (now - firedAt))
          : Infinity;
        const reloadTick = Number.isFinite(nominalTick)
          ? Math.max(nominalTick, previousReloadTick + 1)
          : Infinity;
        slots.push(reloadTick);
        if (Number.isFinite(reloadTick)) previousReloadTick = reloadTick;
      }
      return slots.sort((left, right) => left - right);
    }

    normalizedStructureLevel(rawLevel, minimum = 1) {
      const level = Number(rawLevel ?? minimum);
      return Number.isFinite(level)
        ? Math.max(minimum, Math.floor(level))
        : minimum;
    }

    structureMissileQueue(unit, limit) {
      {
        const queue = unit.missileTimerQueue?.();
        return Array.isArray(queue) ? queue.slice(0, limit) : [];
      }
    }

    // Mirrors PlayerImpl.nukeSpawn's repeated closest-eligible-silo selection
    // over a future launch sequence. It consumes current ready slots first,
    // waits for the real SiloCooldown when every slot is queued, and allows
    // independent ready slots to launch on the same simulation tick. Reusing a
    // consumed slot still waits for the full cooldown.
    legendaryLaunchEntryFlightTicks(entry, targetTile) {
      if (entry.flightTicks === null) {
        entry.flightTicks = this.legendaryNukeFlightTime(
          entry.tile,
          targetTile,
        );
      }
      return entry.flightTicks;
    }

    legendarySiloReadyShotCount(silo, siloMetadataCache = null) {
      const metadata = siloMetadataCache?.get(silo);
      const slots = metadata?.slots ?? this.legendarySiloSlotAvailability(silo);
      return this.legendaryReadyShotCountFromSlots(slots, metadata?.readyShots);
    }

    legendaryReadyShotTotal(
      silos,
      siloMetadataCache = null,
      readyShotsOverride = null,
    ) {
      if (readyShotsOverride !== null && readyShotsOverride !== undefined) {
        return readyShotsOverride;
      }
      let total = 0;
      for (const silo of silos || []) {
        total += this.legendarySiloReadyShotCount(silo, siloMetadataCache);
      }
      return total;
    }

    legendaryReadyShotCountFromSlots(slots, cachedReadyShots) {
      const normalizedReadyShots = Number(cachedReadyShots);
      if (Number.isFinite(normalizedReadyShots)) {
        return Math.min(
          slots.length,
          Math.max(0, Math.floor(normalizedReadyShots)),
        );
      }
      let readyShots = 0;
      for (const tick of slots) {
        if (tick <= 0) readyShots++;
      }
      return readyShots;
    }

    legendaryRememberSiloMetadata({
      siloMetadataCache,
      silo,
      cached,
      tile,
      id,
      slots,
      readyShots,
    }) {
      if (!siloMetadataCache) return;
      if (!cached) {
        siloMetadataCache.set(silo, {
          tile,
          id,
          slots: slots.slice(),
          readyShots,
        });
        return;
      }
      if (!Number.isFinite(Number(cached.readyShots))) {
        cached.readyShots = readyShots;
      }
    }
