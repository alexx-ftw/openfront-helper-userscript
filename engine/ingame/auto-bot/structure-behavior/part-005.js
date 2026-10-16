      this._friendlySamUnitsPlayerSid = null;
      this._friendlySamUnitsCache = null;
      this._ownedSamUnitsTick = null;
      this._ownedSamUnitsCache = null;
      // SAM spending stays locked until this nation has observed an actual
      // hostile missile in flight. Once opened, the gate remains open for the
      // rest of the match even after that first missile resolves.
      this._hostileMissileLaunchObserved = false;
      // Full SAM-versus-structure coverage checks are expensive on mature
      // boards. Cache them by their exact geometry, not merely by game tick.
      this._hydrogenStructureCoveragePlanKey = null;
      this._hydrogenStructureCoveragePlanCache = null;
      // Missile placement forecasts are shared by several Legendary and
      // win-fix construction gates. Keep one snapshot per game tick so a
      // single decision cannot rebuild the same trajectory model repeatedly.
      this._missileDefenseContextTick = null;
      this._missileDefenseContextKey = null;
      this._missileDefenseContextCache = null;
      this._missileDefenseStateRepresentationCache = null;
      this._missileDefenseStateKeyCache = null;
      this._missileDefenseEvaluationTick = null;
      this._missileDefenseEvaluationContext = null;
      this._missileDefenseEvaluationCache = null;
      // An authoritative BuildableUnit gives the exact next-upgrade price for
      // a particular SAM level. Reuse that fact only to avoid re-probing while
      // we remain below the known price; once affordable we always ask the
      // worker again before acting.
      this._plannedSamUpgradeCostCache = new Map();
    }

    // The auto-donate module owns the live transport/ownership scan because it
    // also has to protect manual donation paths. Reuse that shared result here
    // so construction, nuke spending, and donations respond to the same
    // invasion snapshot instead of maintaining subtly different detectors.
    incomingMaritimeInvasionSignal() {
      {
        let host = null;
        if (typeof globalThis !== "undefined") host = globalThis;
        if (typeof window !== "undefined") host = window;
        if (
          host &&
          typeof host.__OFH_getIncomingMaritimeTransport === "function"
        ) {
          return host.__OFH_getIncomingMaritimeTransport(this.game, this.player);
        }
        // Compatibility with older page-context bundles that only expose the
        // original detector; current auto-donate.js always provides the
        // transport-only signal above.
        if (
          host &&
          typeof host.__OFH_getIncomingMaritimeInvasion === "function"
        ) {
          return host.__OFH_getIncomingMaritimeInvasion(this.game, this.player);
        }
      }
      return null;
    }

    hasActiveMaritimeInvasion() {
      return this.incomingMaritimeInvasionSignal()?.active === true;
    }

    // WIN-FIX: while an enemy transport is committed to our territory, spend
    // the construction decision on the naval defense chain only: Port first,
    // then Warship in nationExecution. A Port already under construction is
    // treated as the active investment; no second structure is started.
    async prioritizeMaritimeInvasionDefense() {
      const signal = this.incomingMaritimeInvasionSignal();
      if (!signal || signal.active !== true) return false;

      let config;
      {
        config = this.game.config();
      }
      if (!this.maritimeDefenseConstructionEnabled(config)) return false;
      if (!autoBotBuildAllowed(UNIT.Port)) return false;

      let ports;
      {
        ports = this.player.units(UNIT.Port) || [];
      }

      const portStatus = maritimePortConstructionStatus(ports);
      const warships = this.player.units(UNIT.Warship) || [];
      if (warships.length > 0) return false;

      // Keep the economic slot reserved until the Port is ready. Once a
      // Warship exists (including one under construction), ordinary structures
      // must resume even while the transport signal remains active.
      if (portStatus.underConstruction) return true;
      if (portStatus.completed) return true;

      // A Port cannot be produced on a landlocked/closed-water map. Preserve
      // the normal policy in that impossible case rather than freezing every
      // other construction forever.
      if (!this.hasOceanPortTiles()) return false;

      const availableGold = this.spendableConstructionGold();
      const portCost = this.getConstructionCost(UNIT.Port);
      if (availableGold < portCost) return true;

      // If an affordable Port still cannot be emitted (no legal tile, a failed
      // probe, or a missing build surface), do not claim success and starve all
      // other construction indefinitely.
      return this.maybeSpawnStructure(UNIT.Port, { forceNewStructure: true });
    }

    maritimeDefenseConstructionEnabled(config) {
      if (state.settings.features?.warship !== true) return false;
      if (state.settings.warshipAutoSpawn === false) return false;
      if (typeof config.isUnitDisabled !== "function") return true;
      return (
        !config.isUnitDisabled(UNIT.Port) &&
        !config.isUnitDisabled(UNIT.Warship)
      );
    }

    // ── core-semantics owned count (used wherever src uses unitsOwned) ──────────
    // DIVERGENCE: src core `unitsOwned(type)` (PlayerImpl.ts:322) sums LEVELS —
    // each built unit contributes its level, each under-construction unit +1. The
    // gameApi wrapper's unitsOwned is a plain built-count (no level sum) and
    // unitsConstructed is a boolean, so neither reproduces core semantics. We
    // reproduce the core level-sum here and use it for cityCount, the first-
    // structure `=== 0` checks, shouldBuildStructure's owned, getPerceivedCost's
    // owned, and the cost-formula numUnits. (The exact core
    // min(unitsOwned, unitsConstructed) with its cumulative numUnitsConstructed
    // counter is not client-reproducible — that counter persists across deletions;
    // the level-sum is the faithful client approximation, and for a single un-
    // upgraded unit both give the same number.)
    ownedLevels(type) {
      let total = 0;
      for (const u of this.player.units(type)) {
        if (u.isUnderConstruction()) {
          total += 1;
        } else {
          total += u.level();
        }
      }
      return total;
    }

    // handleStructures — NationStructureBehavior.ts:143 (now async).
    async handleStructures(profile = null) {
      this._economicPlacementDecisionBudget = STRUCTURE_PLACEMENT_CANDIDATE_LIMIT;
      const legendaryDifficulty = isLegendaryDifficulty();
      const activeMissileSamDecision = await profileStructureAsync(
        profile,
        "structures-active-missile-sam",
        () => this.handleActiveMissileSamMaximumPriority(),
      );
      if (activeMissileSamDecision !== null) return activeMissileSamDecision;

      const hostileSiloSamDecision = await profileStructureAsync(
        profile,
        "structures-hostile-silo-sam",
        () => this.handleHostileSiloSamMaximumPriority(),
      );
      if (hostileSiloSamDecision !== null) return hostileSiloSamDecision;

      if (
