      // NukeExecution destroys structures within the circular blast (inclusive edge).
      return structures
        .filter((unit) => this.game.euclideanDistSquared(tile, unit.tile()) <= radius * radius)
        .reduce((sum, unit) => sum + this.nukeStructureValue(unit), 0);
    }

    getSiloIdOrNull(entry) {
      { return String(entry.silo.id()); }
    }

    rememberFailedSamTarget(plan) {
      const unblockedSiloIds = plan.siloEntries
        .filter((entry) => !entry.interceptable)
        .map((entry) => this.getSiloIdOrNull(entry))
        .filter((id) => id !== null);
      const failedTarget = {
        targetTile: plan.targetTile,
        coveringSamIds: plan.coveringSamIds,
        totalBombs: plan.totalBombs,
        requiredSiloCapacity: plan.totalBombs,
        unblockedSiloIds,
      };
      const request = {
        need: plan.totalBombs,
        targetSamId: plan.targetSamId,
        at: this.game.ticks(),
        targetTile: plan.targetTile,
        unblockedSiloIds,
      };
      this._samDemandRequest = request;
      state.nukeWantSlots = request;
      return failedTarget;
    }

    getSamSalvo(plan) {
      const selected = [...plan.window]
        .sort((a, b) => a.index - b.index)
        .slice(0, plan.totalBombs);
      const bombsToFire = selected[selected.length - 1].index + 1;
      const selectedIndexes = new Set(selected.map((bomb) => bomb.index));
      const firstArrival = Math.min(...selected.map((bomb) => bomb.flightTicks));
      const stagger = Math.max(1, Math.floor(plan.maxSpread / plan.totalBombs));
      let selectedIndex = 0;
      let lastWait = 0;
      const waits = Array.from({ length: bombsToFire }, (_, index) => {
        // DIVERGENCE: local emission delays must preserve closest-silo slot order.
        if (selectedIndexes.has(index)) {
          const arrival = firstArrival + selectedIndex++ * stagger;
          lastWait = Math.max(lastWait, arrival - plan.launchSequence[index].flightTicks);
        }
        return lastWait;
      });
      return { bombsToFire, waits };
    }

    async fireSamSalvo(plan, nukeTarget, atomCost) {
      const salvo = this.getSamSalvo(plan);
      const flightTicks = salvo.waits.map((_, index) => plan.launchSequence?.[index]?.flightTicks);
      const plannedLastArrivalTick = this.samSalvoLastArrivalTick(salvo, flightTicks);
      const salvoPlan = this.nextSamSalvoPlan({
        ...plan,
        lastArrivalTick: plannedLastArrivalTick,
      });
      const claimIds = typeof autoBotBuildClaimNukeLaunches === "function"
        ? autoBotBuildClaimNukeLaunches(
          this.game,
          this.player,
          {
            nukeType: UNIT.AtomBomb,
            targetTile: plan.targetTile,
            cost: atomCost,
            count: salvo.bombsToFire,
            salvoId: salvoPlan.salvoId,
          },
        )
        : Array.from({ length: salvo.bombsToFire }, () => null);
      if (claimIds === null) return false;
      salvo.claimIds = claimIds;
      // Plan metadata carried by every delayed entry of this salvo so
      // processPendingNukeLaunches can re-validate the enemy SAM layout
      // mid-flight (see samSalvoStillViable). plannedCoveringLevel records the
      // hostile SAM level sum the bomb count was sized against at planning time.
      let result;
      let demandStarted = false;
      try {
        if (!await this.canStartSamSalvo(plan, nukeTarget, salvo, atomCost)) return false;
        this.ensureSamDemandRequest(plan, salvo);
        demandStarted = true;
        result = await this.launchSamSalvoBombs(
          plan, nukeTarget, salvo, flightTicks, salvoPlan,
        );
      } finally {
        for (const claimId of claimIds) {
          const queued = this._pendingNukeLaunches.some(
            (pending) => pending.salvo?.claimId === claimId,
          );
          if (!queued && typeof autoBotBuildReleaseNukeLaunchClaim === "function") {
            autoBotBuildReleaseNukeLaunchClaim(this.game, this.player, claimId);
          }
        }
        if (demandStarted) this.finishSamDemandRequest();
      }
      if (!result.complete) return result.firedOrQueued;
      // Hydrogen finisher (goal rule): the saturating atoms exist to strip the
      // covering SAMs; once the last bomb lands the target cluster is bare, so
      // schedule the 5MM follow-up for the next nuclear decision pass.
      const lastArrivalTick = this.samSalvoLastArrivalTick(salvo, flightTicks);
      state.postSalvoHydrogen = {
        salvoId: salvoPlan.salvoId,
        targetTile: plan.targetTile,
        dueTick: lastArrivalTick + 5,
        targetSmallID: nukeTarget.smallID?.() ?? null,
      };
      return true;
    }

    async canStartSamSalvo(plan, nukeTarget, salvo, atomCost) {
      if (plan.targetTile != null && this.blastHitsFriendlyLand(plan.targetTile, UNIT.AtomBomb)) {
        return false;
      }
      const salvoCost = BigInt(atomCost) * BigInt(salvo.bombsToFire);
      const excludedClaims = new Set(
        (salvo.claimIds ?? []).filter((claimId) => claimId !== null && claimId !== undefined),
      );
      if (await this.shouldDeferNukeForEconomy(nukeTarget, salvoCost, excludedClaims)) return false;
      return this.player.gold() >= salvoCost;
    }

    ensureSamDemandRequest(plan, salvo) {
      if (state.nukeWantSlots !== null && state.nukeWantSlots !== undefined) {
        this._samDemandRequest = state.nukeWantSlots;
        return;
      }
      const unblockedSiloIds = (plan.siloEntries || [])
        .filter((entry) => !entry.interceptable)
        .map((entry) => this.getSiloIdOrNull(entry))
        .filter((id) => id !== null);
      const request = {
        need: Number(plan.totalBombs ?? salvo.bombsToFire),
        targetSamId: plan.targetSamId,
        at: this.game.ticks(),
        targetTile: plan.targetTile,
        unblockedSiloIds,
        pendingLaunches: false,
      };
      this._samDemandRequest = request;
      state.nukeWantSlots = request;
    }

    async launchSamSalvoBombs(plan, nukeTarget, salvo, flightTicks, salvoPlan) {
      let queued = false;
      let firedOrQueued = false;
      for (let index = 0; index < salvo.bombsToFire; index++) {
        const metadata = {
          ...salvoPlan,
          remainingLaunches: salvo.bombsToFire - index,
          flightTicks: flightTicks[index],
          claimId: salvo.claimIds[index],
        };
        const wait = Math.max(salvo.waits[index], queued ? 1 : 0);
        const sent = await this.sendNuke(
          plan.targetTile, UNIT.AtomBomb, nukeTarget, wait, metadata,
        );
        this.recordSalvoFlight(flightTicks, index, metadata.flightTicks);
        if (!sent && this.blastHitsFriendlyLand(plan.targetTile, UNIT.AtomBomb)) {
          return { complete: false, firedOrQueued };
        }
        // A stale worker probe or exhausted intent budget is retryable.
        // Retain this bomb and the tail; the queue rechecks target and SAMs.
        if (!sent && !this.queueDelayedNukeLaunch(
          plan.targetTile, UNIT.AtomBomb, nukeTarget,
          Math.max(1, wait), metadata,
        )) return { complete: false, firedOrQueued };
        firedOrQueued = true;
        queued = queued || wait > 0 || !sent;
      }
      return { complete: true, firedOrQueued };
    }

    finishSamDemandRequest() {
      if (this.hasPendingNukeLaunches()) {
        state.nukeWantSlots.pendingLaunches = true;
      } else {
        state.nukeWantSlots = null;
        this._samDemandRequest = null;
      }
    }

    // Fire the scheduled Hydrogen finisher once the saturating salvo has
    // landed and the target's covering SAMs are actually gone (a salvaged
