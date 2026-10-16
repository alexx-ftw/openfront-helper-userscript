      }
      return maximum;
    }

    hostileBuiltSiloLevelSum(enemy) {
      {
        if (enemy.isAlive && enemy.isAlive() === false) return 0;
        let sum = 0;
        for (const silo of enemy.units(UNIT.MissileSilo) || []) {
          if (silo.isUnderConstruction && silo.isUnderConstruction()) continue;
          if (silo.isActive && silo.isActive() === false) continue;
          const level = Number(silo.level?.() ?? 1);
          if (Number.isFinite(level)) sum += Math.max(1, Math.floor(level));
        }
        return sum;
      }
    }

    hostileSiloLevelSumAtLeast(
      threshold = HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD,
    ) {
      return this.hostileSiloLevelSumTarget() >= threshold;
    }

    shouldPrioritizeHydrogenSamProtection(
      externalSiloLevelSum = this.externalSiloLevelSumTarget(),
    ) {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.SAMLauncher)) {
        return false;
      }
      {
        if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return false;
        if (this.game.config().isUnitDisabled(UNIT.HydrogenBomb)) return false;
      }
      return externalSiloLevelSum >= HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD;
    }

    /**
     * A completed hostile Silo can launch an H-bomb at level one, so establish
     * level two on our first built SAM immediately. Higher enemy Silo capacity
     * may still raise the target afterwards. This remains a cheap capacity rule
     * and avoids scanning every structure during each construction tick.
     */
    hydrogenSamProtectionPlan() {
      const externalSiloLevelSum = this.externalSiloLevelSumTarget();
      if (!this.shouldPrioritizeHydrogenSamProtection(externalSiloLevelSum)) {
        return null;
      }

      // Level five is the faithful ready line, but an intermediate level
      // two already lifts SAM range onto most atom trajectories and costs a
      // fraction of the climb. With the port trade stream earmarked for
      // interceptor levels, the adaptive tier steps to two first and keeps
      // climbing from income instead of starving the bombardment.
      const readyFloor =
        isLegendaryDifficulty() && this.legendaryPortIncomeFundsSamUpgrades()
          ? LEGENDARY_PORT_FUNDED_SAM_READY_LEVEL
          : HYDROGEN_SAM_MINIMUM_READY_LEVEL;
      const targetLevel = Math.min(
        HYDROGEN_SAM_MAX_UPGRADE_LEVEL,
        Math.max(
          readyFloor,
          externalSiloLevelSum >= 2
            ? HYDROGEN_SAM_MAX_UPGRADE_LEVEL
            : externalSiloLevelSum,
        ),
      );
      const sams = (this.player.units(UNIT.SAMLauncher) || []).filter((sam) => {
        {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) return false;
          return !sam.isActive || sam.isActive() !== false;
        }
      });
      if (targetLevel < HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD || sams.length === 0) {
        return null;
      }

      const criticalEntries = this.samCriticalStructureEntries();
      const targetRangeSquared = this.samRangeSquared(this.game.config(), targetLevel);
      const candidates = [];
      for (const sam of sams) {
        const currentLevel = Math.max(1, Math.floor(Number(sam.level?.() ?? 1)));
        if (
          Number.isFinite(currentLevel) &&
          currentLevel < HYDROGEN_SAM_MAX_UPGRADE_LEVEL
        ) {
          candidates.push({
            sam,
            currentLevel,
            protectionScore: this.samCriticalCoverageScoreForEntries(
              sam.tile(),
              targetRangeSquared,
              criticalEntries,
            ),
          });
        }
      }
      if (candidates.length === 0) return null;

      // A defensive upgrade is only as valuable as the buildings that remain
      // inside its eventual level-five envelope.  When more than one launcher
      // exists, prefer the one centred on the most expensive connected clump;
      // choosing the numerically highest level could otherwise keep improving
      // an isolated coastal SAM while the economic core stays at level one.
      candidates.sort((left, right) => {
        const protectionDifference = right.protectionScore - left.protectionScore;
        if (protectionDifference !== 0) return protectionDifference;
        return right.currentLevel - left.currentLevel;
      });
      const selected = candidates[0];
      return {
        sam: selected.sam,
        currentLevel: selected.currentLevel,
        targetLevel,
      };
    }

    hydrogenStructureCoveragePlan() {
      const input = this.hydrogenStructureCoverageInputs();
      if (input === null) return null;
      if (this._hydrogenStructureCoveragePlanKey === input.key) {
        return this._hydrogenStructureCoveragePlanCache;
      }
      const plan = this.computeHydrogenStructureCoveragePlan(input);
      this._hydrogenStructureCoveragePlanKey = input.key;
      this._hydrogenStructureCoveragePlanCache = plan;
      return plan;
    }

    // Goal requirement (2026-08-23): allied nearby SAMs count toward our
    // coverage. A teammate's launcher intercepts hostile missiles over our
    // structures exactly like our own (the engine's SAM targeting is
    // position-based, not owner-based for defense of the impact zone), so
    // demanding our own site where an ally already covers the footprint is
    // wasted gold on the income-bound SAM lane. Levels are credited at a
    // conservative half weight — we do not control the ally's upgrade path.
    alliedCoverageSamCandidate(other, mySid) {
      if (!other?.isPlayer?.() || other.smallID() === mySid) return false;
      if (!other.isAlive?.()) return false;
      return this.player.isFriendly?.(other) === true;
    }

    alliedCoverageSamEntries() {
      if (!isLegendaryDifficulty()) return [];
      const mySid = this.player.smallID();
      const entries = [];
      for (const other of this.game.players()) {
        if (!this.alliedCoverageSamCandidate(other, mySid)) continue;
        for (const sam of other.units(UNIT.SAMLauncher) || []) {
          this.pushAlliedCoverageSam(entries, sam);
        }
      }
      return entries;
    }

    pushAlliedCoverageSam(entries, sam) {
      if (!this.isBuiltActiveSam(sam)) return;
      const tile = sam.tile();
      const level = Math.max(1, Math.floor(Number(sam.level?.() ?? 1)));
      if (tile === null || tile === undefined || !Number.isFinite(level)) {
