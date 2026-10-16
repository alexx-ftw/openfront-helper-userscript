        // Target loss/alliance changes cancel future entries immediately too.
        if (!this.isEligibleNukeTarget(pending.targetPlayer) ||
            !this.isValidNukeDestination(pending.tile)) continue;
        if (pending.salvo && abortedSalvoIds.has(pending.salvo.salvoId)) {
          droppedAbortedEntries.push(pending);
          continue;
        }
        if (this.deferPendingNukeLaunch(pending, now, remaining, blockedSalvoIds)) continue;
        const outcome = await this.firePendingNukeLaunch(
          pending, sendsThisTick, awaitingSalvoIds.has(pending.salvo?.salvoId),
        );
        if (outcome === "fired") {
          launched = true;
          sendsThisTick += 1;
        } else {
          this.recordPendingNukeFailure(
            outcome,
            pending,
            now,
            { droppedAbortedEntries, remaining, abortedSalvoIds },
            blockedSalvoIds,
          );
        }
      }
      this.finishPendingNukePass(abortedSalvoIds, remaining, droppedAbortedEntries);
      return launched;
    }

    /**
     * Fires one due delayed launch, subject to the per-tick send budget.
     * Returns "fired", "retry" (re-queued for the next tick), or "drop".
     * Staggered arrivals need several bombs due on the SAME tick (the salvo's
     * filler indexes all wait zero); firing them at once would monopolize the
     * shared intent window and clip the tail launches — stretching the
     * arrival window past the SAM reload and breaking penetration. Spreading
     * the sends across ticks preserves relative arrival order via the
     * next-tick retry, and the salvo's built-in margin absorbs the shift.
     */
    async firePendingNukeLaunch(pending, sendsThisTick,
      awaitingReceipts = this.salvoAwaitingNativeReceipts(pending.salvo)) {
      const preflight = this.pendingNukeLaunchPreflight(
        pending,
        sendsThisTick,
        awaitingReceipts,
      );
      if (preflight !== null) return preflight;
      // DIVERGENCE: unacknowledged prefix shots are not yet visible to SAM accounting.
      const sent = await this.sendNuke(
        pending.tile,
        pending.nukeType,
        pending.targetPlayer,
        0,
        pending.salvo,
      );
      this.extendPendingSalvoFinisher(sent, pending);
      return sent ? "fired" : this.retryPendingNukeLaunch(pending);
    }

    pendingNukeLaunchPreflight(pending, sendsThisTick, awaitingReceipts) {
      if (!this.isEligibleNukeTarget(pending.targetPlayer) ||
          !this.isValidNukeDestination(pending.tile)) return "drop";
      if (pending.salvo && !this.pendingNukeSalvoLaunchesSafe([pending])) {
        this._salvoLaunchAbort = pending.salvo.salvoId;
        return "drop";
      }
      if (!pending.salvo && this.blastHitsFriendlyLand(pending.tile, pending.nukeType)) return "drop";
      return sendsThisTick >= PENDING_NUKE_LAUNCHES_PER_TICK || awaitingReceipts
        ? "retry"
        : null;
    }

    async retryPendingNukeLaunch(pending) {
      if (pending.salvo && !this.pendingNukeSalvoLaunchesSafe([pending])) {
        this._salvoLaunchAbort = pending.salvo.salvoId;
        return "drop";
      }
      if (!pending.salvo && this.blastHitsFriendlyLand(pending.tile, pending.nukeType)) return "drop";
      if (pending.salvo && this._salvoLaunchAbort === pending.salvo.salvoId) {
        // The per-launch revalidation rejected this exact salvo (see
        // samSalvoLaunchStillViable); the pass captures the entry for re-arm.
        return "drop";
      }
      if (this._hostileNukeThreats?.size > 0) {
        if (
          await this.shouldHoldCounterforceNuke(
            pending.tile,
            pending.nukeType,
            pending.targetPlayer,
            await this.getPerceivedNukeCost(pending.nukeType),
          )
        ) {
          return "drop";
        }
      }
      return this.isEligibleNukeTarget(pending.targetPlayer) &&
        this.isValidNukeDestination(pending.tile) ? "retry" : "drop";
    }

    /**
     * Salvos (by id) that must be aborted before this pass fires or defers
     * anything. Safety applies to the entire queue; SAM capacity is checked
     * when a salvo has a launch due.
     */
    getAbortedSalvoIds(now, awaitingSalvoIds = null) {
      const queuedSalvoIds = new Set();
      for (const pending of this._pendingNukeLaunches) {
        if (pending.salvo) queuedSalvoIds.add(pending.salvo.salvoId);
      }
      if (queuedSalvoIds.size === 0) return queuedSalvoIds;
      const abortedSalvoIds = new Set();
      for (const salvoId of queuedSalvoIds) {
        const entries = this._pendingNukeLaunches.filter(
          (pending) => pending.salvo && pending.salvo.salvoId === salvoId,
        );
        if (!this.pendingNukeSalvoLaunchesSafe(entries)) {
          abortedSalvoIds.add(salvoId);
          continue;
        }
        if (!entries.some((pending) => pending.dueTick <= now)) continue;
        if (awaitingSalvoIds ? awaitingSalvoIds.has(salvoId) : this.salvoAwaitingNativeReceipts(entries[0].salvo)) continue;
        // Atoms already fired for this salvo still count toward its
        // penetration budget: a staggered tail must not be re-judged against
        // the full covering capacity as if nothing had launched.
        const fired = this._salvoFiredCounts?.get(salvoId) ?? 0;
        const arrivals = entries.map((entry) => {
          const flight = entry.salvo.flightTicks;
          return Number.isFinite(flight) && flight >= 0
            ? Math.max(now, entry.dueTick) + flight
            : NaN;
        });
        if (!this.samSalvoStillViable(
          entries[0], entries.length + fired, Math.max(...arrivals),
        )) {
          abortedSalvoIds.add(salvoId);
        }
      }
      return abortedSalvoIds;
    }

    pendingNukeSalvoLaunchesSafe(entries) {
      if (entries.some((pending) =>
        this.blastHitsFriendlyLand(pending.tile, pending.nukeType))) return false;
      if (!isAtLeastHardDifficulty(currentDifficulty())) return true;
      return entries.every((pending) => {
        const spawnTile = this.nukeSpawn(pending.nukeType, pending.tile);
        if (spawnTile === false) return true;
        const exemptSamIds = new Set(pending.salvo.coveringSamIds ?? []);
        return !this.isTrajectoryInterceptableBySam(
          spawnTile,
          pending.tile,
          exemptSamIds,
        );
      });
    }

    /**
     * Mid-flight re-validation for a SAM-overwhelm salvo (see fireSamSalvo).
     * The salvo was sized against the enemy SAM layout at planning time; before
     * each due bomb fires, re-check that it can still achieve its purpose:
     *   (a) penetration — the enemy SAM levels NOW covering the plan tile must
     *       still be beatable by the bombs the salvo has left (sum of levels +
     *       1), otherwise every further atom is intercepted gold (the enemy may
     *       have built/upgraded a covering SAM after planning);
     *   (b) overkill — if the original target SAM is already destroyed AND no
     *       enemy SAM covers the tile anymore, the remaining bombs would land
     *       on ~zero-value rubble.
     * `remainingInSalvo` is the salvo's pending entry count (due + future).
     * Reuses findEnemySamsCoveringTile, which is already restricted to hostile
     * (non-own, non-permanent-teammate) SAMs.
     */
    samSalvoStillViable(pending, remainingInSalvo, lastArrivalTick = NaN) {
      // Stubs/older call sites may lack the nearby-unit index; without it the
