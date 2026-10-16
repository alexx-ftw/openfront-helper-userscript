
    defensiveConstructionReserve() {
      return (
        (this.defensiveConstructionPressure()?.cost ?? 0n) +
        (this.preemptiveDefensePostPressure()?.cost ?? 0n)
      );
    }

    ownedSamUnits() {
      const tick = safeStructureGameTick(this.game);
      if (Number.isFinite(tick) && this._ownedSamUnitsTick === tick) {
        return this._ownedSamUnitsCache;
      }
      const sams = this.player.units(UNIT.SAMLauncher) || [];
      if (Number.isFinite(tick)) {
        this._ownedSamUnitsTick = tick;
        this._ownedSamUnitsCache = sams;
      }
      return sams;
    }

    singleSamHostileSiloReplacementReserve() {
      if (!state.settings.winFixes || !this.hasBuiltHostileSiloThreat()) return 0n;
      const sams = this.ownedSamUnits();
      if (sams.length > 1) return 0n;
      return this.safeConstructionCost(UNIT.SAMLauncher) ?? 0n;
    }

    offensiveNukeDefenseReserve() {
      return (
        this.defensiveConstructionReserve() +
        this.singleSamHostileSiloReplacementReserve()
      );
    }

    hasDefensiveSamPressure() {
      if (this.hydrogenCoverageNeedsSam()) return true;
      {
        if (this.shouldBuildHostileSiloSam() || this.samLevelParityGap() > 0) {
          return true;
        }
      }
      return this.activeMissileNeedsFirstSam();
    }

    hydrogenCoverageNeedsSam() {
      {
        const coverage = this.hydrogenStructureCoveragePlan();
        return Boolean(
          coverage &&
            (coverage.needsNewSam || coverage.targetLevel > coverage.currentLevel),
        );
      }
    }

    activeMissileNeedsFirstSam() {
      {
        const signal = this.missileDefenseSignalSnapshot();
        const sams = this.ownedSamUnits();
        return signal?.hasActiveHostileMissile === true && sams.length === 0;
      }
    }

    /**
     * Keep an offensive nuke from consuming the exact surplus needed by the
     * next productive build and the next SAM action. NukeBehavior supplies the
     * actual perceived nuke cost and owns the emergency/retaliation exceptions.
     */
    shouldDeferOffensiveNuke(nukeCost = 0n, excludedNukeClaimIds = null) {
      if (!state.settings.winFixes) return false;
      if (this.hasActiveMaritimeInvasion()) return true;

      let cost;
      {
        cost = BigInt(nukeCost || 0n);
      }
      if (cost <= 0n) return false;

      // While the Atom war chest is active, the economic share of this gold
      // was already withheld from construction budgets — counting it again
      // here would defer the very launch the chest is funding. The defensive
      // reserve still applies unchanged.
      const economic = this.legendaryAtomWarChest() > 0n
        ? 0n
        : (this.economicConstructionPressure()?.cost ?? 0n);
      const reserve = economic + this.offensiveNukeDefenseReserve();
      return this.spendableConstructionGold(excludedNukeClaimIds) < cost + reserve;
    }

    shouldDeferOffensiveWarship(warshipCost = 0n) {
      if (!state.settings.winFixes) return false;
      const cost = BigInt(warshipCost || 0n);
      if (cost <= 0n) return false;
      const economic = this.economicConstructionPressure();
      const reserve =
        (economic?.cost ?? 0n) + this.offensiveNukeDefenseReserve();
      return this.spendableConstructionGold() < cost + reserve;
    }

    // Long guaranteed-peace windows are the one place the whole warship lane
    // must respect the interceptor chest: every warship path (initial,
    // raiding fleet, emergency) funnels through shouldDeferWarshipForFirstSam,
    // but the chest previously only bound planner candidates — ~1.25M
    // warships drained the 1.5M SAM fund repeatedly. Scoped to long windows
    // because on ordinary rows the forecast-driven chest fires early and
    // often, and deferring the whole warship lane there regressed the no-mod
    // Labyrinth anchor (win → death@14157).
    longPeaceWindowSamChestActive() {
      const duration = Number(
        this.game?.config?.()?.spawnImmunityDuration?.() ?? 0,
      );
      return duration >= 1800 &&
        this.game?.isSpawnImmunityActive?.() === true &&
        this.legendarySamBaselineChestActive();
    }

    shouldDeferWarshipForFirstSam(warshipCost = 0n) {
      if (state.settings.winFixes !== true) return false;
      const sams = this.ownedSamUnits();
      // Once the first launcher exists, including while it is being built, the
      // maritime emergency may respond normally. Until then, a completed
      // hostile Silo's hard reserve cannot be bypassed by the emergency
      // Warship path. A launcher still under construction remains only an
      // anticipatory signal and cannot freeze unrelated emergency spending.
      if (sams.length > 0) return false;
      if (this.longPeaceWindowSamChestActive() || this.hasBuiltHostileSiloThreat()) {
        const samCost = this.safeConstructionCost(UNIT.SAMLauncher);
        if (samCost === null) return true;
        const cost = BigInt(warshipCost || 0n);
        return this.spendableConstructionGold() < samCost + cost;
      }
      return false;
    }

    // WIN-FIX: a hostile border with a larger troop ceiling makes economic
    // growth the safer response; the caller passes the cached snapshot so the
    // high-starting-gold and normal build gates share one border scan.
    shouldPrioritizeEconomicGrowth(borderTroopAdvantage = null) {
      if (!state.settings.winFixes) return false;
      if (
        (borderTroopAdvantage === null &&
          this.hasBorderingHostileMaxTroopAdvantage()) ||
        borderTroopAdvantage === true
      ) {
        return true;
      }
      if (this.hasHostileReachedSiloGoldThreshold() === false) return true;
      return this.economicConstructionPressure() !== null;
    }

    // The capacity comparison deliberately uses maxTroops, not current troops:
    // current armies fluctuate every tick while the construction response is
    // meant to close a structural force-generation gap.
    // WIN-FIX: troops at (or near) the maxTroops ceiling mean production has
    // stalled — the engine's troop growth scales with the remaining headroom,
    // so every further troop-second near the cap is lost. Only City builds and
    // City upgrades raise the ceiling (each city level adds cityTroopIncrease
    // troops), so this signal makes idle treasury flow into cap growth first.
    // One boolean snapshot per game tick, like the border-advantage snapshot.
    troopCapPressure() {
