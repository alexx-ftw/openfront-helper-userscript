        return null;
      }
      {
        if (this.game.config().isUnitDisabled(UNIT.MissileSilo)) return null;
      }
      return { ...request, requiredCapacity };
    }

    nukeDemandScopedSilos(request, routeEligibleSilos = null) {
      const builtSilos = (this.player.units(UNIT.MissileSilo) || []).filter(
        (silo) => this.isBuiltStructure(silo) && (routeEligibleSilos === null ||
          routeEligibleSilos.some((eligible) => eligible.id() === silo.id())),
      );
      const preferredIds = new Set(
        Array.isArray(request.unblockedSiloIds)
          ? request.unblockedSiloIds.map(String)
          : [],
      );
      if (routeEligibleSilos !== null) return builtSilos;
      if (preferredIds.size === 0) return builtSilos;
      const preferred = builtSilos.filter((silo) =>
        preferredIds.has(String(silo.id())),
      );
      return preferred.length > 0 ? preferred : builtSilos;
    }

    isBuiltStructure(structure) {
      {
        return !structure.isUnderConstruction();
      }
    }

    structureBelowUpgradeLimit(structure) {
      const level = Number(structure.level?.() ?? 1);
      return Number.isFinite(level) && level < HYDROGEN_SAM_MAX_UPGRADE_LEVEL;
    }

    safeStructureCost(type) {
      {
        return this.cost(type);
      }
    }

    nukeSiloUpgradeBudgetAvailable(availableGold, minimumCost) {
      if (availableGold < minimumCost) return false;
      const economic = this.economicConstructionPressure();
      const reserve =
        (economic?.cost ?? 0n) + this.defensiveConstructionReserve();
      return availableGold >= minimumCost + reserve;
    }

    rankNukeDemandSiloUpgrades(input) {
      const ownSams = this.player.units(UNIT.SAMLauncher) || [];
      const ranked = [];
      for (let index = 0; index < input.candidates.length; index++) {
        const silo = input.candidates[index];
        const bu = input.buildables[index];
        if (!bu || bu.canUpgrade === false) continue;
        const cost = this.buildableCostOrFallback(bu, input.minimumCost);
        if (!this.nukeSiloUpgradeBudgetAvailable(input.availableGold, cost)) continue;
        ranked.push({
          silo,
          bu,
          cost,
          level: Number(silo.level?.() ?? 1),
          protection: this.siloSamProtectionScore(silo, ownSams),
        });
      }
      const preferredIds = new Set((input.preferredSiloIds ?? []).map(String));
      ranked.sort((left, right) =>
        Number(preferredIds.has(String(right.silo.id()))) -
        Number(preferredIds.has(String(left.silo.id()))) ||
        this.compareNukeDemandSiloUpgrades(left, right));
      return ranked;
    }

    buildableCostOrFallback(buildable, fallback) {
      {
        return buildable.cost === undefined || buildable.cost === null
          ? fallback
          : BigInt(buildable.cost);
      }
    }

    siloSamProtectionScore(silo, sams) {
      let protection = 0;
      for (const sam of sams) {
        {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) continue;
          const range = this.legendarySamRange(sam.level());
          const distance = this.game.euclideanDistSquared(silo.tile(), sam.tile());
          if (distance <= range * range) protection += Number(sam.level());
        }
      }
      return protection;
    }

    compareNukeDemandSiloUpgrades(left, right) {
      if (right.protection !== left.protection) {
        return right.protection - left.protection;
      }
      if (left.cost !== right.cost) return left.cost < right.cost ? -1 : 1;
      return left.level - right.level;
    }

    async maybeUpgradeSamForSiloParity() {
      if (!this.samParityUpgradeEnabled()) return false;
      const targetCapacity = this.samLevelParityTarget();
      if (targetCapacity <= 0 || this.ownSamCapacity() >= targetCapacity) {
        return false;
      }
      const samUnits = (this.player.units(UNIT.SAMLauncher) || []).filter(
        (sam) => this.isBuiltActiveSam(sam),
      );
      const buildables = await this.buildableForUnits(
        samUnits,
        UNIT.SAMLauncher,
        {
          concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const candidates = this.samParityUpgradeCandidates(
        samUnits,
        buildables,
        this.spendableConstructionGold(),
      );
      const economicallySafeCandidates = candidates.filter((candidate) =>
        this.samUpgradeEconomyCanAbsorb(candidate.cost, true),
      );
      economicallySafeCandidates.sort((left, right) =>
        this.compareSamParityUpgrades(left, right));
      return this.executeStructureUpgradeCandidate(
        economicallySafeCandidates[0],
        UNIT.SAMLauncher,
      );
    }

    samParityUpgradeEnabled() {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.SAMLauncher)) {
        return false;
      }
      if (!this.hasObservedHostileMissileLaunch()) return false;
      {
        return !this.game.config().isUnitDisabled(UNIT.SAMLauncher);
      }
    }

    samParityUpgradeCandidates(samUnits, buildables, availableGold) {
      const candidates = [];
      for (let index = 0; index < samUnits.length; index++) {
        const sam = samUnits[index];
        const bu = buildables[index];
        if (bu === null || bu.canUpgrade === false) continue;
        let cost = this.cost(UNIT.SAMLauncher);
        {
          if (bu.cost !== undefined && bu.cost !== null) cost = BigInt(bu.cost);
        }
        if (cost > availableGold) continue;
        const level = Math.max(1, Number(sam.level() || 1));
