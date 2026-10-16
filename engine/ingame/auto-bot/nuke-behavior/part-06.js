    // pick fired nothing). Every existing gate is retained per candidate.
    async fireLegendaryClearFallthrough(clear, target, selectedNuke, silos) {
      for (const cand of clear) {
        if (cand.value <= -1) break;
        if (!(cand.value > 0 || this.hasScoreZeroReleaseReserve(selectedNuke.cost))) {
          continue;
        }
        if (this.blastHitsFriendlyLand(cand.tile, selectedNuke.type)) continue;
        if (
          await this.probeCanBuildNuke(cand.tile, selectedNuke.type) &&
          await this.nukeHasPositiveExpectedValue(
            cand,
            target,
            selectedNuke,
            silos,
          )
        ) {
          if (await this.sendNuke(
            cand.tile,
            selectedNuke.type,
            target,
            0,
            (buildable) => this.nukeHasPositiveExpectedValue(
              cand,
              target,
              { ...selectedNuke, cost: buildable.cost },
              silos,
            ),
          )) return true;
        }
      }
      return false;
    }

    // Score-zero releases (Legendary divergence) hold a gold buffer above
    // the shot cost, retuned 2026-10-04 from 500k to 100k on measured
    // buffers: the unguarded ffa-n4-04 win fired at a 112,528 buffer while
    // dominant, and the team-temp-05 fork loss fired at 15k. Value>0 shots
    // are untouched. (Docs: legendary-metric-ceilings.md, reserve retune.)
    hasScoreZeroReleaseReserve(nukeCost) {
      const gold = Number(this.player?.gold?.() ?? 0n);
      return gold >= Number(nukeCost ?? 0n) + 100_000;
    }

    // FFA endgame survival strike (2026-08-24): against the last surviving
    // giant both measured death modes are static — mode A freezes at the
    // troop cap with an abundant treasury and zero attacks, mode B grinds at
    // parity-minus with zero outgoing attacks — while engine atom math kills
    // (1-(N/(N+k))^n) of BOTH the victim's pool AND its in-flight waves.
    // Gate helper: every signature read happens here so non-signature games
    // (team profiles among them) exit at the FIRST mode comparison.
    freezeGiantStrikeTarget() {
      if (state.settings.winFixes !== true) return null;
      // Production bridge: currentDifficulty() maps the Legendary UI tier to
      // the engine's Impossible enum, so the raw spelling never arms this
      // lane (same dead-comparison class as the recent-penalty fix). Union
      // gate keeps the tier requirement while matching both spellings.
      if (!isLegendaryDifficulty(currentDifficulty())) return null;
      const ourTroops = this.freezeGiantOwnTroops();
      if (ourTroops === null) return null;
      const { giant, giantTroops } = this.largestHostileGiant();
      if (giant === null || giantTroops < ourTroops * 1.5) return null;
      return giant;
    }

    // Additive-only tail lane (see fireNukeFromCandidates): reached when
    // EVERY ordinary lane declined to fire. Structure-value economics do not
    // apply — a pool/wave deletion IS the payoff — but SAM-discipline still
    // does: clear trajectories first, saturated salvos second.
    async maybeFreezeGiantStrike(silos, difficulty) {
      const incoming = this.attackBehavior?.findIncomingAttackPlayer?.();
      const invasionTarget = this.isInvasionSurvivalTarget(incoming) ? incoming : null;
      const giant = invasionTarget ?? this.freezeGiantStrikeTarget();
      if (giant === null) return;
      if (!this.isEligibleNukeTarget(giant)) return;
      const demandTarget = this.samDemandStrikeTarget();
      if (
        invasionTarget === null &&
        demandTarget !== null &&
        demandTarget.smallID() !== giant.smallID()
      ) return;
      if (this.hasPendingNukeLaunches()) return;
      const selectedNuke = await this.selectAffordableNuke();
      if (!selectedNuke) return;
      // Survival release: the standing 3x war-chest reserve froze this tail
      // lane with 1.2M idle gold while a 2.38M invasion conquered the bot
      // (scenario-sam-salvo-b, tick 6049). Under an active invasion only the
      // shot cost plus the score-zero buffer is required.
      const survivalRelease = invasionTarget === giant;
      if (
        typeof selectedNuke.cost !== "bigint" ||
        this.player.gold() <
          (survivalRelease ? selectedNuke.cost + 100_000n : selectedNuke.cost * 3n)
      ) {
        return;
      }
      const candidates = await this.collectNukeCandidates(
        giant, selectedNuke.type, silos, difficulty,
      );
      const { clear, routeBlockedTile } = this.partitionCandidatesBySamCoverage(
        candidates,
        selectedNuke.type,
        difficulty,
      );
      const best = await this.selectBuildableNukeCandidate(clear, selectedNuke.type);
      if (best) {
        await this.sendNuke(best.tile, selectedNuke.type, giant);
      }
      await this.maybeDestroyEnemySam(giant, false, routeBlockedTile);
    }

    // Candidate collection with the Legendary value-directed retry folded
    // in: returns { list, retargeted }.
    async collectCandidatesWithRetry(
      target,
      selectedNuke,
      silos,
      difficulty,
      allowValueRetarget = true,
    ) {
      const list = await this.collectNukeCandidates(
        target, selectedNuke.type, silos, difficulty,
      );
      if (!isLegendaryDifficulty(difficulty) || !allowValueRetarget) {
        return { list, retargeted: null };
      }
      if (
        this.samDemandMatchesTarget(target)
      ) return { list, retargeted: null };
      const retried = await this.retryWithHigherValueTarget(
        target, selectedNuke, silos, difficulty, { candidates: list },
      );
      if (retried === null) return { list, retargeted: null };
      return {
        list: retried.candidates,
        retargeted: retried.target,
      };
    }

    // Legendary value-directed retry: the ordinary target ladder picks by
    // relation/crown, not wealth. Walk eligible structure-value targets in
    // rank order until one improves the candidate score; otherwise stand down.
    // Returns {target, candidates} or null.
    async retryWithHigherValueTarget(
      target,
      selectedNuke,
      silos,
      difficulty,
      { candidates, excludedTarget = null },
    ) {
      const currentCandidateValue = this.bestCandidateValue(candidates);
      // Wealth-directed retarget: engage whenever the ladder target holds
      // less than half the treasure of the value leader — not only when the
      // ladder found nothing at all. Conquest eats structure wealth fast, so
      // waiting for a total miss wastes the window in which a 5MM harvest
      // is still possible.
      const ladderValue = currentCandidateValue > 0
        ? this.playerStructureValue(target)
        : 0;
      const costScreening =
        currentCandidateValue <= 0 && typeof selectedNuke.cost === "bigint";
      const minimumRetargetValue = currentCandidateValue > 0
        ? Math.max(1_500_000, ladderValue * 2)
        : costScreening ? Number(selectedNuke.cost) : 0;
      const lowValueExceptions = new Set();
      if (costScreening) {
        const incoming = this.attackBehavior?.findIncomingAttackPlayer?.();
        if (incoming && this.isInvasionSurvivalTarget(incoming)) {
          lowValueExceptions.add(incoming.smallID());
        }
        const borderArmyTarget = this.findStrategicBorderArmyTarget();
        if (borderArmyTarget) lowValueExceptions.add(borderArmyTarget.smallID());
      }
      for (const { target: valueTarget, value: valueTargetValue } of
        this.findValueRankedNukeTargets(target)) {
        if (excludedTarget?.smallID() === valueTarget.smallID()) continue;
        if (valueTargetValue < minimumRetargetValue) {
          if (!costScreening) break;
          if (!lowValueExceptions.has(valueTarget.smallID())) continue;
        }
        if (await this.shouldDeferNukeForEconomy(valueTarget, selectedNuke.cost)) return null;
        if (!this.isEligibleNukeTarget(valueTarget)) continue;
        const retryCandidates = await this.collectNukeCandidates(
          valueTarget, selectedNuke.type, silos, difficulty,
        );
        if (!this.isEligibleNukeTarget(valueTarget)) continue;
        if (this.bestCandidateValue(retryCandidates) <= currentCandidateValue) continue;
        return { target: valueTarget, candidates: retryCandidates };
      }
      return null;
