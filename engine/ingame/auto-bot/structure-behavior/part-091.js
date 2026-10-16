        upgradable,
        buByUnitId,
        minimumCost,
        currentGold,
      );
      if (!result) return false;
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

    siloSurplusLaneUnitsEnabled(config) {
      if (config.isUnitDisabled(UNIT.MissileSilo)) return false;
      return !(
        config.isUnitDisabled(UNIT.AtomBomb) &&
        config.isUnitDisabled(UNIT.HydrogenBomb) &&
        config.isUnitDisabled(UNIT.MIRV)
      );
    }

    firstAffordableSiloUpgrade(
      upgradable,
      buByUnitId,
      minimumCost,
      currentGold,
    ) {
      return upgradable
        .map((structure) => ({
          structure,
          bu: buByUnitId.get(structure.id()),
        }))
        .find(
          (candidate) =>
            this.nukeSiloUpgradeBudgetAvailable(
              currentGold,
              this.buildableCostOrFallback(candidate.bu, minimumCost),
            ) && this.genericStructureUpgradeAllowed(candidate, UNIT.MissileSilo),
        );
    }

    /**
     * A speculative SAM level must be paid from true surplus, after the next
     * currently useful economic action. This makes "the economy is strong
     * enough" an opportunity-cost test instead of a fixed gold, City, or tick
     * threshold. Threat urgency decides which useful SAM receives the level;
     * it does not redefine 3M of economic principal as surplus.
     */
    samUpgradeEconomyCanAbsorb(cost, missileDefenseUrgent = false) {
      if (!state.settings.winFixes) return true;
      const upgradeCost = BigInt(cost ?? 0n);
      if (upgradeCost <= 0n) return true;
      const economic = this.economicConstructionPressureForSamUpgrade();
      const economicCost = economic?.cost ?? 0n;
      const firstSiloReserve = this.firstSiloConstructionReserve(
        UNIT.SAMLauncher,
        true,
        missileDefenseUrgent,
      );
      // Port-income earmark: two or more completed Ports run a compounding
      // trade stream that pays for the next interceptor level on its own
      // schedule. Demanding the full economic principal on top of the
      // upgrade price from that treasury starves missile defense through the
      // exact window hostile atoms exploit (four nuked buildings on Baikal),
      // so a port-funded economy may draw the upgrade against the economic
      // share it is actively earning.
      if (this.legendaryPortIncomeFundsSamUpgrades()) {
        return (
          this.spendableConstructionGold() >= upgradeCost + firstSiloReserve
        );
      }
      return (
        this.spendableConstructionGold() >=
        upgradeCost + economicCost + firstSiloReserve
      );
    }

    legendaryPortIncomeFundsSamUpgrades() {
      if (!isLegendaryDifficulty()) return false;
      const ports = (this.player?.units?.(UNIT.Port) || []).filter(
        (port) => port?.isUnderConstruction?.() !== true,
      );
      return ports.length >= LEGENDARY_MIN_OPEN_PORTS;
    }

    economicConstructionPressureForSamUpgrade() {
      const portfolio = this.economicStructurePortfolio();
      const hasCompleteUnitRecords = ECONOMIC_STRUCTURE_TYPES.every((type) =>
        portfolio.get(type).every(
          (unit) =>
            typeof unit?.isUnderConstruction === "function" &&
            typeof unit?.level === "function",
        ),
      );
      // Older clients and reduced adapters can omit the construction-state
      // methods needed by the portfolio snapshot. Preserve legacy behavior
      // when that evidence is absent.
      return hasCompleteUnitRecords ? this.economicConstructionPressure(portfolio) : null;
    }

    plannedSamUpgradeEligible(plan) {
      return (
        plan !== null &&
        plan !== undefined &&
        plan.targetLevel > plan.currentLevel &&
        this.plannedSamUpgradeHasThreat()
      );
    }

    plannedSamUpgradeHasThreat() {
      return (
        this.hasObservedHostileMissileLaunch() ||
        this.hasBuiltHostileSiloThreat() ||
        this.hasBuiltExternalSiloThreat() ||
        this.hasPlacedSiloOnMap()
      );
    }

    async plannedSamUpgradeBuildable(plan) {
      const buildables = await this.buildableForUnits(
        [plan.sam],
        UNIT.SAMLauncher,
        {
          concurrency: 1,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const buildable = buildables[0];
      // The worker reports the authoritative price even when affordability
      // makes canUpgrade false. Retain it before discarding the descriptor.
      if (buildable?.cost !== undefined && buildable?.cost !== null) {
        this.plannedSamUpgradeCost(buildable, this.plannedSamUpgradeCostCacheKey(plan));
      }
      return buildable?.canUpgrade === false ? null : buildable ?? null;
    }

    plannedSamUpgradeCost(buildable, cacheKey) {
      if (buildable.cost === undefined || buildable.cost === null) {
        return this.cost(UNIT.SAMLauncher);
      }
      const cost = BigInt(buildable.cost);
      this.rememberPlannedSamUpgradeCost(cacheKey, cost);
      return cost;
    }

    emitPlannedSamUpgrade(buildable, sam = null) {
      if (
        sam !== null &&
        this.tileInsideActiveHostileMissileImpact(sam.tile?.())
      ) {
        return false;
