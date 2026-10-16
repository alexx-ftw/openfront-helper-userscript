        candidates.push({ sam, bu, cost, level });
      }
      return candidates;
    }

    compareSamParityUpgrades(left, right) {
      if (right.level !== left.level) return right.level - left.level;
      if (left.cost !== right.cost) return left.cost < right.cost ? -1 : 1;
      return String(left.sam.id?.() ?? "").localeCompare(
        String(right.sam.id?.() ?? ""),
      );
    }

    executeStructureUpgradeCandidate(selected, type) {
      if (!selected) return false;
      if (
        this.tileInsideActiveHostileMissileImpact(
          selected.silo?.tile?.() ?? selected.sam?.tile?.() ?? selected.structure?.tile?.(),
        )
      ) {
        return false;
      }
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      if (!sendAutoBotBuildOrUpgrade(buildMenu, selected.bu, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(tr("⬆️ Upgrade {type}", { type }), "build");
      return true;
    }

    async maybeUpgradeMissileDefenseSam(contextOverride = null) {
      if (!this.missileDefenseSamUpgradeEnabled()) return false;
      this._hostileMissileLaunchObserved = true;
      const upgradeableSamUnits = (
        this.player.units(UNIT.SAMLauncher) || []
      ).filter((sam) => this.isBuiltActiveSam(sam));
      if (upgradeableSamUnits.length === 0) return false;
      const buildables = await this.buildableForUnits(
        upgradeableSamUnits,
        UNIT.SAMLauncher,
        {
          concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const upgradeCandidates = this.missileDefenseSamUpgradeCandidates(
        upgradeableSamUnits,
        buildables,
        this.spendableConstructionGold(),
      );
      if (upgradeCandidates.length === 0) return false;
      const context = contextOverride || this.getMissileDefenseContext();
      if (!context || !Array.isArray(context.threats) || context.threats.length === 0) return false;
      const currentEvaluation = contextOverride
        ? this.legendaryDefenseEvaluation(context)
        : this.getMissileDefenseEvaluation(context);
      if (!currentEvaluation.hasThreats || currentEvaluation.fullyDefended) return false;
      const candidates = this.rankMissileDefenseSamUpgrades(
        upgradeCandidates,
        context,
        currentEvaluation,
      );
      return this.executeStructureUpgradeCandidate(candidates[0], UNIT.SAMLauncher);
    }

    missileDefenseSamUpgradeEnabled() {
      if (!autoBotBuildAllowed(UNIT.SAMLauncher)) return false;
      {
        if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return false;
      }
      const signal = this.missileDefenseSignalSnapshot();
      return signal !== null && signal.hasActiveHostileMissile === true;
    }

    missileDefenseSamUpgradeCandidates(sams, buildables, availableGold) {
      const candidates = [];
      const fallbackCost = this.safeStructureCost(UNIT.SAMLauncher);
      for (let index = 0; index < sams.length; index++) {
        const sam = sams[index];
        const bu = buildables[index];
        if (bu === null || bu.canUpgrade === false) continue;
        const cost = this.buildableCostOrFallback(bu, fallbackCost);
        if (cost > availableGold) continue;
        const nextLevel = Math.max(1, Number(sam.level() || 1) + 1);
        candidates.push({
          sam,
          bu,
          cost,
          nextLevel,
          overrides: new Map([[sam.id(), nextLevel]]),
        });
      }
      return candidates;
    }

    rankMissileDefenseSamUpgrades(upgradeCandidates, context, currentEvaluation) {
      const current = {
        evaluation: currentEvaluation,
        margin: currentEvaluation.fullyDefended
          ? currentEvaluation.completionMarginTicks
          : 0,
        capacity: this.legendaryMinimumSamInterceptionCapacity(context),
        unintercepted: currentEvaluation.uninterceptedCount,
      };
      const ranked = upgradeCandidates
        .map((candidate) =>
          this.scoreMissileDefenseSamUpgrade(candidate, context, current),
        )
        .filter((candidate) => candidate !== null);
      ranked.sort((left, right) => this.compareMissileDefenseSamUpgrades(left, right));
      return ranked;
    }

    scoreMissileDefenseSamUpgrade(candidate, context, current) {
      const nextEvaluation = this.legendaryDefenseEvaluation(context, {
        levelOverrides: candidate.overrides,
        completionTick: 0,
      });
      if (
        nextEvaluation.completionMarginTicks <
        LEGENDARY_SAM_IMPACT_MARGIN_TICKS
      ) return null;
      const nextCapacity = this.legendaryMinimumSamInterceptionCapacity(
        context,
        candidate.overrides,
      );
      if (
        !legendaryDefenseActionImproves(
          current.evaluation,
          nextEvaluation,
          current.capacity,
          nextCapacity,
        )
      ) return null;
      const marginGain = Math.max(
        0,
        nextEvaluation.completionMarginTicks - current.margin,
      );
      const capacityGain = Math.max(0, nextCapacity - current.capacity);
      const interceptedGain = Math.max(
        0,
        current.unintercepted - nextEvaluation.uninterceptedCount,
      );
      const reachesFullDefense = nextEvaluation.fullyDefended ? 100 : 0;
      const costFactor = Math.max(1, Number(candidate.cost) / 1_500_000);
      return {
        ...candidate,
        score:
          (reachesFullDefense +
            interceptedGain * 100 +
            marginGain * 10 +
            capacityGain * 2) /
          costFactor,
        marginGain,
        capacityGain,
        interceptedGain,
