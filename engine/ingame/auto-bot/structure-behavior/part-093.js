     */
    samOverwhelmPlanStillMissing(request) {
      const nuke = this.nukeBehavior;
      if (
        !nuke ||
        typeof nuke.createSamOverwhelmPlan !== "function" ||
        request?.targetSamId == null
      ) {
        return null;
      }
      const targetSam = (this.game.units?.(UNIT.SAMLauncher) ?? []).find(
        (sam) => String(sam.id?.()) === String(request.targetSamId),
      );
      if (!targetSam) return null;
      const silos = typeof this.player.units === "function"
        ? (this.player.units(UNIT.MissileSilo) || [])
            .filter((silo) => !silo.isUnderConstruction?.())
        : [];
      const plan = nuke.createSamOverwhelmPlan(targetSam, silos);
      // A friendly-fire veto closes this investment request; treating it as
      // an unavailable planner would fund capacity for a salvo we cannot fire.
      if (plan === null) {
        return request.targetTile != null &&
          typeof nuke.blastHitsFriendlyLand === "function" &&
          nuke.blastHitsFriendlyLand(request.targetTile, UNIT.AtomBomb)
          ? false
          : null;
      }
      return Boolean(plan.capacityMissing);
    }

    routeEligibleSilosForDemand(request) {
      return this.nukeBehavior?.getRouteEligibleSilos(request) ?? null;
    }

    nukeDemandSilosForUpgrade(request, planStillMissing, routeEligibleSilos) {
      if (planStillMissing === false) {
        // The planner closes the demand with the live layout even when the
        // static level sum lags (partial levels + route-capable silos).
        // DIVERGENCE: reload/window flapping across reloads keeps the demand
        // alive here; only a closing plan releases it.
        state.nukeWantSlots = null;
        return null;
      }
      const scopedSilos = this.nukeDemandScopedSilos(
        request,
        routeEligibleSilos ?? this.routeEligibleSilosForDemand(request),
      );
      const currentCapacity = scopedSilos.reduce(
        (sum, silo) => sum + Math.max(1, Number(silo.level?.() ?? 1)),
        0,
      );
      if (
        planStillMissing === null &&
        currentCapacity >= request.requiredCapacity
      ) {
        state.nukeWantSlots = null;
        return null;
      }
      return scopedSilos;
    }

    nukeDemandSiloIntentAge(tick, prior) {
      return tick === null || prior.tick === null ? 0 : tick - prior.tick;
    }

    nukeDemandSiloUpgradeWaiting(pendingRequest) {
      const prior = this._nukeDemandSiloUpgradeReservation;
      if (prior?.request !== pendingRequest) return false;
      if (prior.inFlight) return true;
      const reservedSilo = (this.player.units(UNIT.MissileSilo) || []).find(
        (silo) => String(silo.id()) === String(prior.siloId),
      );
      const currentLevel = Number(reservedSilo?.level?.() ?? 1);
      const levelAdvanced = !reservedSilo || currentLevel > prior.level;
      const rawTick = Number(this.game?.ticks?.());
      const tick = Number.isFinite(rawTick) ? rawTick : null;
      const age = this.nukeDemandSiloIntentAge(tick, prior);
      return (
        !levelAdvanced &&
        age >= 0 &&
        age < NUKE_DEMAND_SILO_INTENT_GRACE_TICKS
      );
    }

    nukeDemandSiloUpgradeCandidates(request, scopedSilos, planStillMissing) {
      const canUpgradeForDemand = this.nukeBehavior?.hasUsefulSiloUpgradeCapacity(
        scopedSilos,
        { totalBombs: request.requiredCapacity },
        planStillMissing === true,
      );
      const candidates = scopedSilos.filter((silo) =>
        this.structureBelowUpgradeLimit(silo),
      );
      if (candidates.length === 0 || canUpgradeForDemand === false) {
        // Unsatisfiable demand: every scoped silo is at its level cap and the
        // nation silo budget is exhausted, so no upgrade or spawn can ever
        // close the request. Release it to reopen the surplus lane.
        if (
          candidates.length === 0 &&
          canUpgradeForDemand === false &&
          this.missileSiloPhysicalCapReached()
        ) {
          state.nukeWantSlots = null;
          return null;
        }
        return [];
      }
      return candidates;
    }

    /**
     * Service the nuke planner's target-specific silo-capacity request. This
     * sits below both H-bomb SAM priorities and above generic hostile-SAM
     * parity. It upgrades useful silos one level at a time, then may build a
     * route-clear silo when the remaining demand outlives their level caps.
     */
    async maybeUpgradeSiloForNukeDemand(routeEligibleSilos = null) {
      const pendingRequest = state.nukeWantSlots;
      const request = this.validNukeSiloUpgradeRequest();
      if (request === null) return false;
      const planStillMissing = this.samOverwhelmPlanStillMissing(request);
      const scopedSilos = this.nukeDemandSilosForUpgrade(
        request,
        planStillMissing,
        routeEligibleSilos,
      );
      if (scopedSilos === null) return false;
      if (this.nukeDemandSiloUpgradeWaiting(pendingRequest)) return false;
      const candidates = this.nukeDemandSiloUpgradeCandidates(
        request,
        scopedSilos,
        planStillMissing,
      );
      if (candidates === null) return false;
      if (candidates.length === 0) return this.maybeSpawnNukeDemandSilo(pendingRequest);
      const availableGold = this.availableGoldAfterReserve(UNIT.MissileSilo);
      const minimumCost = this.safeStructureCost(UNIT.MissileSilo);
      if (!this.nukeSiloUpgradeBudgetAvailable(availableGold, minimumCost)) {
        return false;
      }
      const reservation = { request: pendingRequest, inFlight: true };
      this._nukeDemandSiloUpgradeReservation = reservation;
      try {
        const buildables = await this.buildableForUnits(
          candidates,
          UNIT.MissileSilo,
          {
            concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
            timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
          },
        );
        return await this.finishNukeDemandSiloUpgrade({
          pendingRequest, request, candidates, buildables, minimumCost, reservation,
        });
      } finally {
        if (
          this._nukeDemandSiloUpgradeReservation === reservation &&
          reservation.inFlight
        ) {
