          this._nukeDemandSiloUpgradeReservation = null;
        }
      }
    }

    nukeDemandSiloSpawnWaiting(pendingRequest, silos, tick) {
      const prior = this._nukeDemandSiloSpawnReservation;
      if (prior?.request !== pendingRequest) return false;
      if (prior.inFlight) return true;
      const newSiloVisible =
        silos.length > prior.siloCount || this.hasStructureUnderConstruction(silos);
      const age = this.nukeDemandSiloIntentAge(tick, prior);
      return (
        !newSiloVisible &&
        age >= 0 &&
        age < NUKE_DEMAND_SILO_INTENT_GRACE_TICKS
      );
    }

    async maybeSpawnNukeDemandSilo(pendingRequest) {
      const silos = this.player.units(UNIT.MissileSilo) || [];
      const rawTick = Number(this.game?.ticks?.());
      const tick = Number.isFinite(rawTick) ? rawTick : null;
      if (this.nukeDemandSiloSpawnWaiting(pendingRequest, silos, tick)) return false;
      const reservation = {
        request: pendingRequest,
        tick,
        siloCount: silos.length,
        inFlight: true,
      };
      this._nukeDemandSiloSpawnReservation = reservation;
      let spawned = false;
      try {
        spawned = await this.maybeSpawnStructure(UNIT.MissileSilo, {
          forceNewStructure: true,
          useActualCost: true,
          nukeDemandRequest: pendingRequest,
        });
        return spawned;
      } finally {
        if (this._nukeDemandSiloSpawnReservation === reservation) {
          reservation.inFlight = false;
          if (spawned) {
            const completedTick = Number(this.game?.ticks?.());
            if (Number.isFinite(completedTick)) reservation.tick = completedTick;
          } else {
            this._nukeDemandSiloSpawnReservation = null;
          }
        }
      }
    }

    nukeDemandSiloSpawnAllowed(pendingRequest, tile = null) {
      const request = this.validNukeSiloUpgradeRequest();
      if (state.nukeWantSlots !== pendingRequest || request === null) return false;
      const planStillMissing = this.samOverwhelmPlanStillMissing(request);
      if (planStillMissing === false) {
        state.nukeWantSlots = null;
        return false;
      }
      const silos = this.player.units(UNIT.MissileSilo) || [];
      if (
        this.missileSiloPhysicalCapReached() ||
        this.hasStructureUnderConstruction(silos)
      ) {
        return false;
      }
      const routeEligible = this.routeEligibleSilosForDemand(request);
      const currentCapacity = this.nukeDemandScopedSilos(request, routeEligible ?? null)
        .reduce((sum, silo) => sum + Math.max(1, Number(silo.level?.() ?? 1)), 0);
      if (
        planStillMissing === null &&
        currentCapacity >= request.requiredCapacity
      ) {
        state.nukeWantSlots = null;
        return false;
      }
      const minimumCost = this.safeStructureCost(UNIT.MissileSilo);
      if (
        minimumCost === null ||
        minimumCost <= 0n ||
        !this.nukeSiloUpgradeBudgetAvailable(
          this.availableGoldAfterReserve(UNIT.MissileSilo),
          minimumCost,
        )
      ) {
        return false;
      }
      return tile === null || this.nukeDemandSiloRouteClear(tile, request);
    }

    nukeDemandSiloRouteClear(tile, request, coveringSamIds = null) {
      const nuke = this.nukeBehavior;
      if (
        !nuke ||
        typeof nuke.isTrajectoryInterceptableBySam !== "function" ||
        request?.targetTile === null ||
        request?.targetTile === undefined
      ) {
        return false;
      }
      if (coveringSamIds === null) {
        const coveringSams = nuke.findEnemySamsCoveringTile?.(request.targetTile);
        if (!Array.isArray(coveringSams)) return false;
        coveringSamIds = new Set(coveringSams.map((sam) => sam.id()));
      }
      if (
        !Array.from(coveringSamIds).some(
          (id) => String(id) === String(request.targetSamId),
        )
      ) {
        return false;
      }
      return !nuke.isTrajectoryInterceptableBySam(
        tile,
        request.targetTile,
        coveringSamIds,
      );
    }

    nukePendingLaunchRouteClear(tile, launch) {
      const nuke = this.nukeBehavior;
      if (
        !nuke ||
        typeof nuke.isTrajectoryInterceptableBySam !== "function" ||
        typeof nuke.isValidNukeTarget !== "function" ||
        typeof nuke.isValidNukeDestination !== "function" ||
        tile === null ||
        tile === undefined ||
        !nuke.isValidNukeTarget(launch?.targetPlayer) ||
        !nuke.isValidNukeDestination(launch?.tile)
      ) {
        return false;
      }
      const excludedSamIds = new Set(launch.salvo?.coveringSamIds ?? []);
      return !nuke.isTrajectoryInterceptableBySam(
        tile,
        launch.tile,
        excludedSamIds,
      );
    }

    nukePendingLaunchRouteAllowed(tile) {
      const pending = this.nukeBehavior?._pendingNukeLaunches;
      return Array.isArray(pending) && pending.some((launch) =>
        this.nukePendingLaunchRouteClear(tile, launch),
      );
    }

    validNukeSiloUpgradeRequest() {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.MissileSilo)) {
        return null;
      }
      if (this.legendaryMissileDefenseUrgent()) return null;
      const request = state.nukeWantSlots;
      if (request?.pendingLaunches === true) return null;
      const requiredCapacity = Number(request?.need);
      if (!Number.isFinite(requiredCapacity) || requiredCapacity <= 0) return null;
      if (this.nukeSiloRequestTargetInvalid(request)) {
        state.nukeWantSlots = null;
