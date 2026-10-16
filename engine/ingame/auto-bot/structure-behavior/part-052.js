      const ceiling =
        siloCapacityCeiling === null || siloCapacityCeiling === undefined
          ? NaN
          : Number(siloCapacityCeiling);
      const boundedBySilos =
        Number.isFinite(ceiling) && ceiling >= 0
          ? Math.min(affordable, Math.floor(ceiling))
          : affordable;
      const forecastComplete =
        Number.isSafeInteger(boundedBySilos) &&
        boundedBySilos <= LEGENDARY_MAX_FORECAST_MISSILES;
      const safeAffordable = Number.isSafeInteger(boundedBySilos)
        ? boundedBySilos
        : LEGENDARY_MAX_FORECAST_MISSILES;
      const atomCount = Math.max(
        0,
        Math.min(LEGENDARY_MAX_FORECAST_MISSILES, safeAffordable),
      );
      return { canHydrogen, atomCount, forecastComplete };
    }

    // Conservative upper bound on the atoms an enemy can put into one salvo
    // before the first hydrogen finisher would land. A silo holds one queued
    // launch per level slot and each slot reloads on a fixed cooldown, so the
    // realistic opening chain is bounded by the total silo level (every slot
    // loaded once) plus one full reload over the salvo window. Ready-shot data
    // from the shared metadata cache is used when already present, but this
    // helper never reaches into the live game (no tile/distance/ticks reads) so
    // it stays cheap and side-effect-free even when the budget runs inside a
    // partially-stubbed test harness.
    legendaryEnemySiloSalvoCeiling(enemySilos, siloMetadataCache = null) {
      const silos = Array.isArray(enemySilos) ? enemySilos : [];
      if (silos.length === 0) return 0;
      const { totalLevels, cachedReadyShots, haveCachedReadyShots } =
        this.legendaryEnemySiloCapacityAccumulation(silos, siloMetadataCache);
      // One full reload cycle over the salvo window is the most an opponent can
      // add beyond the slots that are already loaded. Counting the loaded slots
      // plus their one-cooldown reload captures the chain-then-finisher pattern
      // without modeling gold we already bounded separately. The cooldown read
      // touches the live game config; when that is unavailable (an early-tick
      // view or a partially-stubbed harness), fall back to the steady-state
      // level ceiling rather than throwing — gold still bounds the atom count.
      const cooldownTicks = this.legendarySiloCooldownTicksOrFallback();
      if (cooldownTicks === null) {
        return Math.max(totalLevels, cachedReadyShots);
      }
      const windowTicks = Math.max(cooldownTicks, LEGENDARY_SALVO_WINDOW_TICKS);
      const reloads = Math.max(1, Math.floor(windowTicks / cooldownTicks));
      const reloadCeiling = totalLevels * reloads;
      // Prefer the live ready-shot count when the cache already materialized it
      // (it sees current reload progress); otherwise fall back to the level sum
      // as a conservative steady-state ceiling.
      return haveCachedReadyShots
        ? Math.max(cachedReadyShots, reloadCeiling)
        : Math.max(totalLevels, reloadCeiling);
    }

    // Accumulate total silo level and any cached ready-shot count across the
    // eligible enemy silos. Extracted from legendaryEnemySiloSalvoCeiling to
    // keep both functions under the complexity ceiling.
    legendaryEnemySiloCapacityAccumulation(silos, siloMetadataCache) {
      let totalLevels = 0;
      let cachedReadyShots = 0;
      let haveCachedReadyShots = false;
      for (const silo of silos) {
        if (!this.legendaryEligibleEnemyMissileSilo(silo)) continue;
        const level = this.normalizedStructureLevel(silo.level?.());
        if (Number.isFinite(level) && level > 0) totalLevels += Math.floor(level);
        const cached = siloMetadataCache?.get(silo);
        if (!cached) continue;
        const ready = this.legendaryReadyShotCountFromSlots(
          cached.slots ?? [],
          cached.readyShots,
        );
        if (!Number.isFinite(ready)) continue;
        cachedReadyShots += Math.max(0, Math.floor(ready));
        haveCachedReadyShots = true;
      }
      return { totalLevels, cachedReadyShots, haveCachedReadyShots };
    }

    // Read the silo cooldown only when the live game config is available; the
    // placement path must not throw on an early-tick view or a partially-stubbed
    // harness. Returns null when the cooldown cannot be resolved safely.
    legendarySiloCooldownTicksOrFallback() {
      const game = this.game;
      return game?.config ? Math.max(1, this.legendarySiloCooldownTicks()) : null;
    }


    legendarySalvoRoutes({
      launches,
      targetTile,
      canHydrogen,
      atomCount,
      samProfiles,
    }) {
      const atomArrivalTicks = [];
      const routes = [];
      const pathBySilo = new Map();
      const coverageCacheBySilo = new Map();
      let hydrogenArrivalTick = null;
      for (let index = 0; index < launches.length; index++) {
        const launch = launches[index];
        const isHydrogen = canHydrogen && index >= atomCount;
        if (isHydrogen) hydrogenArrivalTick = launch.impactTick;
        else atomArrivalTicks.push(launch.impactTick);
        routes.push(
          this.legendarySalvoRoute({
            launch,
            index,
            targetTile,
            isHydrogen,
            samProfiles,
            pathBySilo,
            coverageCacheBySilo,
          }),
        );
      }
      return { atomArrivalTicks, hydrogenArrivalTick, routes };
    }

    legendarySalvoRoute({
      launch,
      index,
      targetTile,
      isHydrogen,
      samProfiles,
      pathBySilo,
      coverageCacheBySilo,
    }) {
      const fromTile = launch.fromTile ?? launch.silo.tile();
      const siloId = launch.siloId ?? launch.silo.id?.() ?? index;
      let path = pathBySilo.get(launch.silo);
      if (!path) {
        path = this.legendaryNukeFlightPath(fromTile, targetTile);
        pathBySilo.set(launch.silo, path);
      }
      let coverageIndexCache = coverageCacheBySilo.get(launch.silo);
      if (!coverageIndexCache) {
        coverageIndexCache = new Map();
        coverageCacheBySilo.set(launch.silo, coverageIndexCache);
      }
      const weapon = isHydrogen ? UNIT.HydrogenBomb : UNIT.AtomBomb;
      const route = this.legendaryBuildMissileRoute(
        {
          fromTile,
          targetTile,
          impactTick: launch.impactTick,
          launchOffset: launch.launchTick,
          weapon,
          id: `${isHydrogen ? "hydrogen" : "atom"}:${String(
            siloId,
          )}:${String(index)}`,
          path,
        },
        samProfiles,
        coverageIndexCache,
      );
      route.silo = launch.silo;
