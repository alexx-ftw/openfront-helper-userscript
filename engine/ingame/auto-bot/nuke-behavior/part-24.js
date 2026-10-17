
    samSalvoLastArrivalTick(salvo, flightTicks) {
      const lastArrivalTick = this.game.ticks() +
        Math.max(
          0,
          ...salvo.waits.map((wait, index) => {
            const flight = flightTicks[index] ?? 0;
            return wait + flight;
          }),
        );
      return lastArrivalTick;
    }

    extendFinisherForLiveAtoms(pending) {
      let atomsInFlight = false;
      for (const atom of this.player.units?.(UNIT.AtomBomb) ?? []) {
        if (atom.isActive?.() === false || atom.targetTile?.() !== pending.targetTile) continue;
        atomsInFlight = true;
        const motion = this.structureBehavior?.legendaryActiveMissileMotion?.(atom, atom.tile?.());
        if (Number.isFinite(motion?.impactTick) && motion.impactTick >= 0) {
          pending.dueTick = Math.max(pending.dueTick,
            Number(this.game.ticks()) + motion.impactTick + 5);
        }
      }
      return atomsInFlight;
    }

    postSalvoHydrogenHasValue(config, target, pending) {
      const magnitude = config.nukeMagnitudes?.(UNIT.HydrogenBomb) ?? {
        inner: 0,
        outer: 0,
      };
      // Enemy MissileSilos count through mirvCapableSiloPriority: finishing a
      // silo cluster that can already pay for a MIRV is worth trading own
      // replacement loss for, matching the tile scorer's counterforce logic.
      const enemyValue = unitsOfTypes(target)
        .filter((unit) =>
          this.game.euclideanDistSquared(pending.targetTile, unit.tile()) <
            magnitude.outer * magnitude.outer)
        .reduce((sum, unit) =>
          sum + this.nukeStructureValue(unit) * this.mirvCapableSiloPriority(unit), 0);
      const friendlyPenalty = this.friendlyFirePenalty(
        pending.targetTile,
        magnitude,
        true,
      );
      const netValue = enemyValue - friendlyPenalty;
      return netValue > 0 || Number.isNaN(netValue);
    }

    pinDemandSam(orderedSams) {
      // A live capacity demand pins the strike to the SAM it was priced
      // against; otherwise the lowest-level SAM can soak the budget while the
      // requested target keeps covering the value tile.
      if (state.settings.winFixes === true) {
        const demandSamId = state.nukeWantSlots?.targetSamId;
        if (demandSamId !== null && demandSamId !== undefined) {
          const pinnedIndex = orderedSams.findIndex(
            (sam) => String(sam.id()) === String(demandSamId),
          );
          if (pinnedIndex > 0) {
            const [pinned] = orderedSams.splice(pinnedIndex, 1);
            orderedSams.unshift(pinned);
          }
        }
      }
    }

    siloCanSpawnNuke(silo, projected) {
      if (silo.isActive && silo.isActive() === false) return false;
      if (silo.isUnderConstruction()) return false;
      if (projected) {
        if ((projected.get(String(silo.id())) ?? 0) <= 0) return false;
      } else if (typeof silo.ticksLeftInCooldown === "function" && silo.ticksLeftInCooldown() > 0) {
        return false;
      }
      return true;
    }

    samDemandRequestInvalid(request, targetSamId) {
      return request == null || request.pendingLaunches === true ||
        targetSamId === null || targetSamId === undefined;
    }

    samDemandMatchesTarget(target) {
      return this.samDemandStrikeTarget()?.smallID?.() === target?.smallID?.();
    }

    ensureHostileNukeThreatMap() {
      if (
        typeof this._hostileNukeThreats?.get !== "function" ||
        typeof this._hostileNukeThreats?.set !== "function" ||
        typeof this._hostileNukeThreats?.clear !== "function"
      ) {
        this._hostileNukeThreats = new Map();
      }
    }

    missileThreatensFriendlyTarget(missile, targetTile, selfId, context) {
      const targetOwner = this.game.owner?.(targetTile);
      const targetsFriendlyTile =
        targetOwner?.smallID?.() === selfId ||
        playersArePermanentTeammates(this.player, targetOwner);
      if (!targetsFriendlyTile) {
        if (!this.missileThreatensFriendlyStructures(missile, targetTile, context)) return false;
      }
      return true;
    }

    finishPendingNukePass(abortedSalvoIds, remaining, droppedAbortedEntries) {
      const previous = this._pendingNukeLaunches;
      const kept =
        abortedSalvoIds.size > 0
          ? remaining.filter(
              (pending) =>
                !pending.salvo || !abortedSalvoIds.has(pending.salvo.salvoId),
            )
          : remaining;
      this._pendingNukeLaunches = kept;
      const keptClaimIds = new Set(kept.map((pending) => pending.salvo?.claimId));
      if (typeof autoBotBuildReleaseNukeLaunchClaim === "function") {
        for (const pending of previous) {
          const claimId = pending.salvo?.claimId;
          if (claimId !== null && claimId !== undefined && !keptClaimIds.has(claimId)) {
            autoBotBuildReleaseNukeLaunchClaim(this.game, this.player, claimId);
          }
        }
      }
      for (const salvoId of abortedSalvoIds) this._salvoFiredCounts?.delete(salvoId);
      if (
        kept.length === 0 &&
        state.nukeWantSlots?.pendingLaunches === true
      ) {
        // The whole queue drained through aborts: either the demand still has
        // live SAM coverage to re-arm against, or it is obsolete and released.
        this.rearmAbortedSamDemand(droppedAbortedEntries);
      }
    }

    nextSamSalvoPlan(plan) {
      this._nextSalvoId = (this._nextSalvoId || 0) + 1;
      const salvoPlan = {
        salvoId: this._nextSalvoId,
        plannedCoveringLevel: Number(plan.coveringSamLevels ?? 0),
        totalBombs: Number(plan.totalBombs ?? 0),
        remainingLaunches: Number(plan.totalBombs ?? 0),
        lastArrivalTick: Number(plan.lastArrivalTick ?? NaN),
        targetTile: plan.targetTile,
        targetSamId: plan.targetSamId ?? null,
        coveringSamIds: [...(plan.coveringSamIds ?? [])],
      };
      return salvoPlan;
    }

    freezeGiantArmyReady(ourTroops) {
      const ourMax = Number(this.player.maxTroops?.() ?? 0);
      return ourMax > 0 &&
        (ourTroops >= ourMax * 0.85 || Number.isNaN(ourTroops));
    }

    samDemandPlayers() {
      return this.game.players?.() ?? [];
    }

    // probeCanBuildNuke — the deferred async canBuild gate (DIVERGENCE B1). Probes
    // buildables(tile, [nukeType]) and returns whether the nuke can be built there
    // (canBuild !== false). This is the SAME gate src's player.canBuild applies,
    // just async. (Affordability is checked separately in sendNuke.)
    async probeCanBuildNuke(tile, nukeType) {
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(tile, [nukeType]),
          WORKER_TIMEOUT_MS,
          null,
        );
      }
      const bu = Array.isArray(buildables)
        ? buildables.find((b) => b.type === nukeType)
        : null;
      return bu !== null && bu !== undefined && bu.canBuild !== false;
    }
  }
