      // Upstream 34a8fe723: per-tile value gate before scoring (Impossible
      // demands strictly positive structure value) and coverage-boosted
      // ranking; the async fire walk still breaks on pure value <= -1.
      return [...new Set(tiles)]
        .map((tile) => {
          const coverage = this.isScorableNukeTile(tile, context);
          if (coverage === -1) return null;
          const scoredValue = this.nukeTileScore(
            tile, silos, structures, type, survival,
          );
          const value =
            survival && coverage > 0
              ? Math.max(1, scoredValue)
              : scoredValue;
          if (difficulty === Difficulty.Impossible ? value <= 0 : value < 0) return null;
          return {
            tile,
            value,
            score: value + coverage * FULL_BLAST_COVERAGE_VALUE,
            counterforce: this.isCounterforceSiloTarget(tile, type, target),
          };
        })
        .filter((candidate) => candidate !== null)
        .sort(
          (a, b) =>
            Number(b.counterforce) - Number(a.counterforce) ||
            b.score - a.score,
        );
    }

    async selectBuildableNukeCandidate(candidates, type) {
      for (const cand of candidates) {
        if (cand.value <= -1) break;
        // Upstream checks the winner post-sort; here it gates the async probe
        // walk (same first-ranked-survivor semantics).
        if (this.blastHitsFriendlyLand(cand.tile, type)) continue;
        if (await this.probeCanBuildNuke(cand.tile, type)) return cand;
      }
      return null;
    }

    // A live SAM-capacity demand pins both nuke lanes to the SAM owner's
    // target, so the salvo planner can re-service it instead of striking the
    // target that scores highest today.
    samDemandStrikeTarget() {
      if (state.settings.winFixes !== true) {
        this._samDemandRequest = null;
        return null;
      }
      // DIVERGENCE (winFixes): keep a capacity-ready SAM target across the
      // structure and nuke phases, which otherwise clear the shared request.
      const closedRequest = state.nukeWantSlots == null && this._samDemandRequest !== null;
      const request = state.nukeWantSlots ?? this._samDemandRequest;
      const targetSamId = request?.targetSamId;
      if (this.samDemandRequestInvalid(request, targetSamId)) return null;
      for (const player of this.samDemandPlayers()) {
        const { owner } = this.samDemandOwner(player, targetSamId);
        if (!owner) continue;
        if (!this.isValidNukeDestination(request.targetTile)) return null;
        if (closedRequest) {
          state.nukeWantSlots = request;
          if (this.structureBehavior?.samOverwhelmPlanStillMissing?.(request) !== false) {
            state.nukeWantSlots = null;
            return null;
          }
        }
        this._samDemandRequest = request;
        return owner;
      }
      if (request === this._samDemandRequest) this._samDemandRequest = null;
      return null;
    }

    // ── maybeSendNuke — NationNukeBehavior.ts:58 (now async) ──────────────────
    async maybeSendNuke() {
      if (this.hasPendingNukeLaunches()) {
        this.observeHostileNukeThreats();
        return;
      }
      // Why-is-the-lane-idle counters (durable harness telemetry): the
      // 2026-10-10 baskets showed atoms=0 in 9/10 rows and the 2026-09-29
      // defer-release revert proved the economy gate is not the binding one,
      // so record which exit actually blocks each ordinary decision.
      const tel = (this.decisionTelemetry ??= {
        runs: 0, siloMissing: 0, tubesEmpty: 0, noTarget: 0,
        unaffordable: 0, economyDeferred: 0, noCandidates: 0, reached: 0,
      });
      tel.runs += 1;
      const silos = this.player.units(UNIT.MissileSilo);
      if (this.nukeLaneBlockedByCapacity(silos, tel)) return;
      this.observeHostileNukeThreats();
      const demandTarget = this.samDemandStrikeTarget();
      const priority = this.priorityNukeTarget(demandTarget);
      const target = priority.target;
      const pinnedTarget = this.isPinnedNukeTarget(priority);
      if (!this.isEligibleNukeTarget(target)) {
        tel.noTarget += 1;
        return;
      }
      const selectedNuke = await this.selectAffordableNuke();
      if (!selectedNuke) {
        tel.unaffordable += 1;
        return;
      }
      if (this.shouldDeferNukeForEconomy(target, selectedNuke.cost)) {
        tel.economyDeferred += 1;
        return;
      }
      const difficulty = currentDifficulty();
      const candidates = await this.collectCandidatesWithRetry(
        target, selectedNuke, silos, difficulty, !pinnedTarget,
      );
      if ((candidates.list?.length ?? 0) === 0) {
        tel.noCandidates += 1;
      } else {
        tel.reached += 1;
      }
      const ordinaryAction = await this.fireNukeFromCandidates(
        candidates.list,
        pinnedTarget ? target : demandTarget ?? candidates.retargeted ?? target,
        selectedNuke,
        silos,
        difficulty,
      );
      if (ordinaryAction) return;
      if (
        await this.retryIncomingNukeFallback(
          {
            incoming: priority.incoming,
            target,
            selectedNuke,
            silos,
            difficulty,
            candidates: candidates.list,
          },
        )
      ) return;
      // FFA endgame survival lane — additive-only: reached only when every
      // ordinary lane declined to fire. See maybeFreezeGiantStrike.
      await this.maybeFreezeGiantStrike(silos, difficulty);
    }

    async retryIncomingNukeFallback({
      incoming,
      target,
      selectedNuke,
      silos,
      difficulty,
      candidates,
    }) {
      if (!incoming) return false;
      const liveDemandTarget = this.samDemandStrikeTarget();
      if (
        liveDemandTarget &&
        this.isEligibleNukeTarget(liveDemandTarget) &&
        liveDemandTarget.smallID() !== target.smallID()
      ) {
        const demandCandidates = (
          await this.collectCandidatesWithRetry(
            liveDemandTarget,
            selectedNuke,
            silos,
            difficulty,
            false,
          )
        ).list;
        if (
          await this.fireNukeFromCandidates(
            demandCandidates,
            liveDemandTarget,
            selectedNuke,
            silos,
            difficulty,
          )
        ) return true;
