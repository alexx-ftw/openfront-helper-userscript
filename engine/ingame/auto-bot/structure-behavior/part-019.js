        this.structureConfigDisablesType(config, UNIT.MissileSilo)
      ) {
        return false;
      }
      const silos = this.player?.units?.(UNIT.MissileSilo) || [];
      if (silos.length === 0) {
        // Give a timely interceptor a chance before the speculative first
        // launcher; the active-threat path opens the Silo only after that probe.
        if (this.legendaryMissileDefenseUrgent()) return false;
        return this.maybeOpenLegendaryFirstSilo(hasOceanPortTiles);
      }
      return this.maybeOpenLegendaryBaselineSam(config);
    }

    maybeOpenLegendaryFirstSilo(hasOceanPortTiles = true) {
      // The first launcher is speculative offense; when a hostile silo has
      // appeared and no interceptor exists, its 1M price is exactly the
      // chest the baseline SAM needs (measured ofh-n-b1: silo bought at
      // 4919 delayed the SAM 602 ticks past the first strike).
      if (this.legendarySamBaselineChestActive()) return false;
      if (this.legendaryBigStartSiloDeferred(hasOceanPortTiles)) return false;
      // A 1M speculative silo during a long guaranteed-peace window is pure
      // consumption: nothing needs striking before immunity expires, and the
      // same gold is two-thirds of the interceptor that must be ready at
      // expiry. Short default immunity is unaffected.
      const peaceDuration = Number(
        this.game?.config?.()?.spawnImmunityDuration?.() ?? 0,
      );
      if (
        peaceDuration >= 1800 &&
        this.game?.isSpawnImmunityActive?.() === true
      ) {
        return false;
      }
      const siloCost = this.safeConstructionCost(UNIT.MissileSilo) ?? 0n;
      if (this.spendableConstructionGold() < siloCost) return false;
      return this.maybeSpawnStructure(UNIT.MissileSilo, {
        useActualCost: true,
        ignoreEconomicReserve: true,
        prioritizeStructureCoverage: true,
      });
    }

    maybeOpenLegendaryBaselineSam(config) {
      const sams = this.player?.units?.(UNIT.SAMLauncher) || [];
      if (
        sams.length === 0 &&
        config?.isUnitDisabled?.(UNIT.SAMLauncher) !== true &&
        // A hostile silo is the trigger, not the first observed launch:
        // waiting for a missile to fly means the 300-tick SAM construction
        // starts only after buildings have already been lost (measured on
        // Baikal — four structures nuked before the baseline completed).
        // The extended-immunity peace window is an equally valid trigger:
        // the strike becomes possible the moment it expires.
        (this.hasObservedHostileMissileLaunch() ||
          this.hasBuiltHostileSiloThreat() ||
          this.legendaryPeaceWindowSamChestDue())
      ) {
        return this.maybeSpawnStructure(UNIT.SAMLauncher, {
          allowPreemptiveSam: true,
          useActualCost: true,
          prioritizeStructureCoverage: true,
        });
      }
      return false;
    }

    async doHandleLegendaryStructures({
      config,
      citiesDisabled,
      cityCount,
      difficulty,
      hasCoastalTiles,
      hasOceanPortTiles,
      missileSilosEnabled,
      nukesEnabled,
      economyGrowthPriority,
    }) {
      this.debugStructureLaneCount("laneLegendaryChain");
      const missileDefenseInitiallyUrgent =
        this.legendaryMissileDefenseUrgent();
      // Lead-survival cap: while the guarded border sits below its Defense
      // Post expectation, discretionary offensive silo spending waits; the
      // economy and in-flight nuclear commitments keep their existing lanes.
      const leadGuardShortfall =
        this.leadGuardDefensePostThreat(difficulty) !== null;
      if (
        !leadGuardShortfall &&
        !missileDefenseInitiallyUrgent &&
        await this.maybeOpenLegendaryArsenal({
          config,
          cityCount,
          hasOceanPortTiles,
          missileSilosEnabled,
          nukesEnabled,
        })
      ) {
        return true;
      }

      const needsBaselineSam = this.ownProjectedSamCapacity() <= 0;
      let baselineSamBlocked = false;
      if (needsBaselineSam) {
        if (await this.maybeSpawnHostileSiloSam()) return true;
        baselineSamBlocked = this.hostileSiloSamActionBlocked();
      }
      // The launcher covering the most exposed trajectory and any urgent
      // replacement take priority over offensive or economic construction.
      if (await this.maybeUpgradeLegendarySam()) return true;
      const missileDefenseUrgent = this.legendaryMissileDefenseUrgent();
      if (missileDefenseUrgent && !baselineSamBlocked) {
        if (
          await this.maybeSpawnStructure(UNIT.SAMLauncher, {
            useActualCost: true,
            prioritizeStructureCoverage: true,
            activeMissileDefense: true,
          })
        ) {
          return true;
        }
      }
      // A first launcher is offensive capacity as well as deterrence; place
      // it only after every actionable, timely SAM construction has been tried.
      if (
        !leadGuardShortfall &&
        nukesEnabled &&
        missileSilosEnabled &&
        typeof this.player?.units === "function" &&
        this.ownedLevels(UNIT.MissileSilo) === 0 &&
        !(this.player?.units?.(UNIT.MissileSilo) || []).some((silo) =>
          silo.isUnderConstruction?.(),
        ) &&
        (await this.maybeOpenLegendaryFirstSilo(hasOceanPortTiles))
      ) {
        this.debugStructureLaneCount("laneSiloBuilt");
        return true;
      }
      if (missileDefenseUrgent) return false;
      // Arm-on-freeze strike silo: FFA-only survival lane (see method doc).
      // Defense keeps priority above; the ordinary candidates ladder below
      // defers offensive silos behind the economy gates that mode-A freezes
      // stall on, so the survival strike otherwise never gets a launcher.
      if (await this.maybeArmFreezeStrikeSilo()) return true;

      // Nuclear slot pressure: a queued nuclear launch with zero ready silo
      // shots is the one case where an offensive silo upgrade outranks the
      // ordinary ladder — every level is a reload slot that drains the queue,
      // so silo upgrades and the nuke lane stay synchronized instead of the
      // structures planner spending the same surplus on economy while the
      // nuclear lane waits on cooldowns.
      if (await this.maybeUpgradeSiloForNuclearSlotPressure()) return true;

      // Cap relief needs the authoritative City upgrade price before the
      // candidate set is built. The probe is tick-cached and its per-level
      // cost cache keeps repeated decisions off the worker.
      if (this.computeTroopCapPressure(false)) {
        await this.refreshLegendaryCityUpgradeCandidate();
      }

      const candidates = await this.legendaryConstructionCandidates({
