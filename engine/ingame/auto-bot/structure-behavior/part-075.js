      if (tick !== null) {
        this._legendaryCityUpgradeProbeTick = tick;
        this._legendaryCityUpgradeProbe = info;
      }
    }

    builtCityUpgradeTargets() {
      const cities = this.player?.units?.(UNIT.City);
      if (!Array.isArray(cities)) return [];
      return cities.filter(
        (city) =>
          city?.isUnderConstruction?.() !== true &&
          city?.isActive?.() !== false &&
          typeof city?.id === "function" &&
          typeof city?.level === "function",
      );
    }

    async probeLegendaryCityUpgradeCandidate() {
      const cities = this.builtCityUpgradeTargets().slice(
        0,
        STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
      );
      if (cities.length === 0) return null;
      const priced = [];
      const pending = [];
      for (const city of cities) {
        const cachedCost = this._legendaryCityUpgradeCostCache.get(
          this.cityUpgradeCostCacheKey(city),
        );
        if (cachedCost === undefined) pending.push(city);
        else priced.push({ city, cost: cachedCost });
      }
      if (pending.length > 0) {
        await this.pricePendingCityUpgrades(pending, priced);
      }
      let best = null;
      for (const { city, cost } of priced) {
        if (cost <= 0n) continue;
        if (best === null || cost < best.cost) {
          best = { structureId: city.id(), cost };
        }
      }
      return best;
    }

    async pricePendingCityUpgrades(pending, priced) {
      const buildables = await this.buildableForUnits(pending, UNIT.City, {
        concurrency: STRUCTURE_PROBE_CONCURRENCY,
        timeoutMs: STRUCTURE_PROBE_TIMEOUT_MS,
      });
      for (let index = 0; index < pending.length; index++) {
        const cost = this.legendaryCityUpgradeBuildableCost(buildables[index]);
        this.rememberLegendaryCityUpgradeCost(
          this.cityUpgradeCostCacheKey(pending[index]),
          cost,
        );
        priced.push({ city: pending[index], cost });
      }
    }

    // Zero means "no authoritative price" and the candidate is skipped rather
    // than guessed at.
    legendaryCityUpgradeBuildableCost(buildable) {
      if (buildable?.canUpgrade === false) return 0n;
      if (buildable?.cost === undefined || buildable?.cost === null) return 0n;
      return BigInt(buildable.cost);
    }

    cityUpgradeCostCacheKey(city) {
      const level = Math.max(1, Math.floor(Number(city?.level?.() ?? 1)));
      return `${String(city?.id?.())}:${level}:${safeStructureGameTick(this.game)}`;
    }

    rememberLegendaryCityUpgradeCost(cacheKey, cost) {
      // Unavailable/failed probes are transient, not a price for this level.
      if (cost <= 0n) {
        this._legendaryCityUpgradeCostCache.delete(cacheKey);
        return;
      }
      if (this._legendaryCityUpgradeCostCache.size >= CITY_UPGRADE_COST_CACHE_LIMIT) {
        this._legendaryCityUpgradeCostCache.clear();
      }
      this._legendaryCityUpgradeCostCache.set(cacheKey, cost);
    }

    // Actuation for the Legendary cap-relief City upgrade candidate. Re-probes
    // the exact city so the emitted upgrade pays the authoritative live price;
    // a level change, destruction, or lost affordability just falls through to
    // the next ranked action.
    async maybeUpgradeLegendaryCityCapacity(candidate) {
      if (!this.computeTroopCapPressure(false)) return false;
      const city = this.builtCityUpgradeTargets().find(
        (target) => target.id() === candidate?.upgradeStructureId,
      );
      if (!city) return false;
      const buildables = await this.buildableForUnits([city], UNIT.City, {
        concurrency: 1,
        timeoutMs: STRUCTURE_PROBE_TIMEOUT_MS,
      });
      const buildable = buildables[0];
      if (!buildable || buildable.canUpgrade === false) return false;
      const currentCity = this.builtCityUpgradeTargets().find(
        (target) => String(target.id()) === String(candidate?.upgradeStructureId),
      );
      if (!currentCity || !this.computeTroopCapPressure(false)) return false;
      this.rememberLiveCityUpgradeCost(currentCity, buildable);
      const cost = this.buildableCostOrFallback(
        buildable,
        legendaryBigInt(candidate.cost),
      );
      if (cost > this.availableGoldAfterReserve(UNIT.City)) return false;
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      if (!sendAutoBotBuildOrUpgrade(buildMenu, buildable, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(tr("⬆️ Upgrade {type}", { type: UNIT.City }), "build");
      return true;
    }

    rememberLiveCityUpgradeCost(city, buildable) {
      if (buildable.cost === undefined || buildable.cost === null) return;
      this.rememberLegendaryCityUpgradeCost(
        this.cityUpgradeCostCacheKey(city),
        BigInt(buildable.cost),
      );
    }

    async probeLegendaryThroughputUpgradeCandidates(strategicState) {
      const tick = safeStructureGameTick(this.game);
      if (
        tick !== null &&
        this._legendaryThroughputUpgradeProbeTick === tick &&
        Array.isArray(this._legendaryThroughputUpgradeProbe)
      ) {
        return this._legendaryThroughputUpgradeProbe;
      }
      const inputs = strategicState?.economyInputs;
      const config = this.game?.config?.();
      const candidates = [];
      for (const type of [UNIT.Factory, UNIT.Port]) {
        const networkTargets = type === UNIT.Factory
          ? inputs?.factoryUpgradeTargets ?? []
          : (inputs?.portUpgradeTargetIds ?? []).map((structureId) => ({ structureId }));
        if (networkTargets.length === 0) continue;
        const units = this.player.units(type) ?? [];
        const targets = networkTargets
          .map((entry) => ({
            entry,
            unit: units.find(
              (unit) => String(unit?.id?.()) === String(entry.structureId),
            ),
          }))
          .filter(({ unit }) => unit && unit.isUnderConstruction?.() !== true);
        if (targets.length === 0) continue;
        const buildables = await this.buildableForUnits(
