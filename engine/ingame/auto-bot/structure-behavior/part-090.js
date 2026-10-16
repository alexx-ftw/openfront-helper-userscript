            config: this.game?.config?.(),
          });
          if (!evaluation || evaluation.refused === true || evaluation.netTeamGold <= 0) {
            return false;
          }
        }
        if (!this.genericStructureUpgradeAllowed(result, type)) return false;
        // src: addExecution(new UpgradeStructureExecution(player, unit.id())).
        // Client: sendBuildOrUpgrade(bu) where bu.canUpgrade !== false. We already
        // probed the BuildableUnit in findBestStructureToUpgrade, so reuse it.
        const buildMenu = getBuildMenu();
        if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
          return false;
        }
        if (!sendAutoBotBuildOrUpgrade(buildMenu, result.bu, undefined, this.game, this.player)) {
          return false;
        }
        state.stats.builds++;
        setLastAction(
          tr("⬆️ Upgrade {type}", { type: result.structure.type() }),
          "build",
        );
        return true;
      }
      return false;
    }

    async maybeUpgradePlannedSam(plan, options = {}) {
      // A built hostile Silo is enough evidence to complete a proven coverage
      // or capacity upgrade before its first missile consumes that window.
      if (!this.plannedSamUpgradeEligible(plan)) return false;

      const availableGold = this.spendableConstructionGold();
      const cacheKey = this.plannedSamUpgradeCostCacheKey(plan);
      const cachedCost = this._plannedSamUpgradeCostCache?.get(cacheKey);
      if (cachedCost !== undefined && cachedCost > availableGold) return false;

      const bu = await this.plannedSamUpgradeBuildable(plan);
      if (bu === null) return false;
      const cost = this.plannedSamUpgradeCost(bu, cacheKey);
      if (cost > availableGold) return false;
      if (
        options.maximumNuclearPriority !== true &&
        !this.samUpgradeEconomyCanAbsorb(cost)
      ) return false;
      if (this.tileInsideActiveHostileMissileImpact(plan.sam?.tile?.())) {
        return false;
      }

      return this.emitPlannedSamUpgrade(bu, plan.sam);
    }

    async maybeUpgradeSiloForNuclearSlotPressure() {
      if (!state.settings.winFixes) return false;
      const config = this.game.config();
      if (this.nuclearSlotPressureUnitsDisabled(config)) return false;
      // This generic lane handles queued launches only. An outstanding
      // nukeWantSlots request belongs to maybeUpgradeSiloForNukeDemand, which
      // rechecks the target, usable route and economic/defensive reserves;
      // falling through here would bypass those target-specific gates.
      if (!this.nuclearSlotPressureQueueEligible()) return false;
      const silos = (this.player?.units?.(UNIT.MissileSilo) || []).filter(
        (silo) => silo.isUnderConstruction?.() !== true,
      );
      if (silos.length === 0) return false;
      const routeEligibleSilos = silos.filter((silo) =>
        this.nukePendingLaunchRouteAllowed(silo.tile?.()),
      );
      if (routeEligibleSilos.length === 0) return false;
      if (this.nuclearSlotPressureReadyShotTotal() > 0) return false;
      const upgradeCandidates = routeEligibleSilos.filter((silo) =>
        this.structureBelowUpgradeLimit(silo),
      );
      const result = upgradeCandidates.length > 0
        ? await this.findBestStructureToUpgrade(upgradeCandidates)
        : null;
      if (this.nuclearSlotPressureReadyShotTotal() > 0) return false;
      if (result === null) {
        // A null probe can be a timeout. Only a confirmed max-level set can
        // justify adding another launcher for the waiting queue.
        if (routeEligibleSilos.some((silo) => this.structureBelowUpgradeLimit(silo))) {
          return false;
        }
        if (!this.nuclearSlotPressureQueueEligible()) return false;
        // Every completed silo is maxed, so a new launcher is the only
        // remaining slot source. Placement reuses first-Silo machinery.
        // Synchronization: one pending launcher at a time. The filtered
        // list above cannot see a silo already under construction, and
        // stacking duplicate builds would drain the treasury without
        // adding ready slots any sooner.
        return this.maybeSpawnUnqueuedNuclearSlotPressureSilo();
      }
      if (
        !this.nuclearSlotPressureQueueEligible() ||
        !this.nukePendingLaunchRouteAllowed(result.structure?.tile?.())
      ) {
        return false;
      }
      if (!this.genericStructureUpgradeAllowed(result, UNIT.MissileSilo)) {
        return false;
      }
      return this.emitNuclearSlotPressureUpgrade(result);
    }

    maybeSpawnNuclearSlotPressureSilo() {
      if (this.missileSiloPhysicalCapReached()) return false;
      const siloCost = this.safeConstructionCost(UNIT.MissileSilo) ?? 0n;
      if (siloCost <= 0n || this.spendableConstructionGold() < siloCost) {
        return false;
      }
      return this.maybeSpawnStructure(UNIT.MissileSilo, {
        forceNewStructure: true,
        useActualCost: true,
        prioritizeStructureCoverage: true,
        nukePendingLaunchRoute: true,
      });
    }

    nuclearSlotPressureReadyShotTotal() {
      const silos = (this.player?.units?.(UNIT.MissileSilo) || [])
        .filter((silo) => silo.isUnderConstruction?.() !== true)
        .filter((silo) => this.nukePendingLaunchRouteAllowed(silo.tile?.()));
      return this.legendaryReadyShotTotal(silos);
    }

    // Surplus silo leveling (DIVERGENCE): the reactive lanes above only open
    // while a launch is queued or a salvo slot request is pending, so a built
    // silo otherwise sits at level 1 for whole matches (n=60 1.12.195
    // baseline: 6 silo builds, 0 silo upgrades across 16 finished rows).
    // Spend true post-reserve surplus — the same budget the nuke-demand
    // upgrade lane uses — on the next level. Candidate order is the live
    // unit order and findBestStructureToUpgrade's random roll/jitter is
    // deliberately bypassed: this lane draws no RNG. See PD28 in
    // docs/legendary-metric-ceilings.md.
    async maybeUpgradeSiloFromSurplus() {
      if (!state.settings.winFixes) return false;
      // Let the target-specific SAM demand lane own every open capacity
      // request; a route-irrelevant surplus upgrade must not mask its failure.
      if (state.nukeWantSlots?.need > 0) return false;
      const config = this.game.config();
      if (!this.siloSurplusLaneUnitsEnabled(config)) {
        return false;
      }
      const silos = (this.player?.units?.(UNIT.MissileSilo) || [])
        .filter((silo) => silo.isUnderConstruction?.() !== true)
        .filter((silo) => this.structureBelowUpgradeLimit(silo));
      if (silos.length === 0) return false;
      const minimumCost = this.safeStructureCost(UNIT.MissileSilo);
      const availableGold = this.availableGoldAfterReserve(UNIT.MissileSilo);
      if (!this.nukeSiloUpgradeBudgetAvailable(availableGold, minimumCost)) {
        return false;
      }
      const { upgradable, buByUnitId } =
        await this.probeUpgradableStructures(silos);
      // A target-specific SAM-capacity request can arrive while upgrade quotes
      // are pending; leave the post-probe decision to its route-aware lane.
      if (state.nukeWantSlots?.need > 0) return false;
      if (upgradable.length === 0) return false;
      const currentGold = this.availableGoldAfterReserve(UNIT.MissileSilo);
      const result = this.firstAffordableSiloUpgrade(
