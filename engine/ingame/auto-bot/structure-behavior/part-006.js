        await profileStructureAsync(profile, "structures-immediate-defense", () =>
          this.handleImmediateStructureDefense(legendaryDifficulty))
      ) {
        return true;
      }

      const {
        missileEmergency: legendaryMissileEmergency,
        defenseEmergency: legendaryDefenseEmergency,
      } = this.legendaryDefenseEmergencies(legendaryDifficulty);

      const defensePostDecision = await profileStructureAsync(
        profile,
        "structures-defense-post",
        () => this.handleDefensePostPriority(legendaryMissileEmergency),
      );
      if (defensePostDecision !== null) return defensePostDecision;

      if (
        await profileStructureAsync(profile, "structures-winfix-priorities", () =>
          this.handleWinFixStructurePriorities(legendaryDifficulty))
      ) {
        this.debugStructureLaneCount("laneWinfixTrue");
        return true;
      }

      this.debugStructureLaneCount("laneReachInitialSilo");
      if (await this.handleInitialSiloPriority(profile, legendaryDifficulty)) {
        return true;
      }

      if (this.shouldDeferOrdinaryStructureDecision()) {
        return false;
      }

      // Legendary missile defense is an emergency exception to the ordinary
      // save-up phase so an interceptor upgrade/build can still matter.
      if (!legendaryDefenseEmergency && this.isInPostSaveUpBlockedPhase()) {
        return false;
      }
      const built = await profileStructureAsync(
        profile,
        "structures-ordinary",
        () => this.doHandleStructures(profile),
      );
      if (built) {
        this.placementsCount++;
      }
      return built;
    }

    shouldDeferOrdinaryStructureDecision() {
      const tick = Number(this.game?.ticks?.());
      if (!Number.isFinite(tick)) return false;
      const previous = Number(this._lastOrdinaryStructureDecisionTick);
      if (
        Number.isFinite(previous) &&
        tick >= previous &&
        tick - previous < ORDINARY_STRUCTURE_DECISION_INTERVAL_TICKS
      ) {
        return true;
      }
      this._lastOrdinaryStructureDecisionTick = tick;
      return false;
    }

    async handleActiveMissileSamMaximumPriority() {
      if (!state.settings.winFixes) return null;
      if (!autoBotBuildAllowed(UNIT.SAMLauncher)) return null;
      if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return null;
      const signal = this.missileDefenseSignalSnapshot();
      if (signal?.hasActiveHostileMissile !== true) return null;

      const context = this.activeMissileDefenseContext();
      const evaluation = this.legendaryDefenseEvaluation(context);
      const uncoveredMirvDemands = this.uncoveredActiveMirvDemands(context);
      if (
        (!evaluation.hasThreats || evaluation.fullyDefended) &&
        uncoveredMirvDemands.length === 0
      ) return null;

      // Consolidate first, but only when an upgrade measurably improves the
      // actual trajectory schedule. A distant SAM must not consume gold merely
      // because a missile exists somewhere on the map.
      if (
        evaluation.hasThreats &&
        !evaluation.fullyDefended &&
        (await this.maybeUpgradeMissileDefenseSam(context))
      ) return true;
      if (
        this.activeMissilePendingSamImproves(
          context,
          evaluation,
          uncoveredMirvDemands,
        )
      ) {
        // A useful emergency SAM is already under construction, so its
        // interception deadline is secured. Start the first Silo alongside it
        // from true surplus; otherwise back-to-back hostile flights can keep
        // this max-priority lane occupied until the bot dies with no launcher.
        return await this.maybeStartFirstSiloAlongsidePendingSam();
      }

      // The missile has a fixed deadline. Reserve the whole construction slot
      // until a geometrically useful SAM can be afforded and placed; spending
      // it on a Port/Warship/economy action can make the interception impossible.
      if (await this.resolveActiveMissileSamFallback(context)) return true;
      // A pending interceptor has already claimed the urgent-defense action.
      // If it cannot cover this particular flight and no additional SAM action
      // is buildable, use funded surplus to open the first offensive silo
      // alongside it; otherwise repeated flights can starve the launcher for
      // the whole match.
      if (
        this.hasOwnSamUnderConstruction() &&
        (await this.maybeStartFirstSiloAlongsidePendingSam())
      ) {
        return true;
      }
      return false;
    }

    async maybeStartFirstSiloAlongsidePendingSam() {
      const config = this.game?.config?.();
      if (
        !config ||
        config.isUnitDisabled(UNIT.MissileSilo) ||
        ![UNIT.AtomBomb, UNIT.HydrogenBomb, UNIT.MIRV].some(
          (type) => !config.isUnitDisabled(type),
        ) ||
        this.ownedLevels(UNIT.MissileSilo) > 0
      ) {
        return false;
      }
      const cost = this.safeConstructionCost(UNIT.MissileSilo);
      if (
        cost === null ||
        this.availableGoldAfterReserve(UNIT.MissileSilo, { includeSam: true }) <
          cost
      ) {
        return false;
      }
      return this.maybeSpawnStructure(UNIT.MissileSilo, {
        ignoreEconomicReserve: true,
      });
    }

    async resolveActiveMissileSamFallback(context) {
      if (await this.maybeSpawnStructure(UNIT.SAMLauncher, {
        allowPreemptiveSam: true,
        useActualCost: true,
        forceNewStructure: true,
        prioritizeStructureCoverage: true,
        missileDefenseContext: context,
        activeMissileDefense: true,
        probeLimit: STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
        probeTimeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        parallelProbeCount: DEFENSIVE_SAM_PROBE_CONCURRENCY,
      })) {
        return true;
      }
