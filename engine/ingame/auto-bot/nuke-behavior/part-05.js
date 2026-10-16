      }
      if (!isLegendaryDifficulty(difficulty)) return false;
      const valueFallback = await this.retryWithHigherValueTarget(
        target,
        selectedNuke,
        silos,
        difficulty,
        { candidates, excludedTarget: liveDemandTarget },
      );
      if (
        !valueFallback ||
        valueFallback.target.smallID() === liveDemandTarget?.smallID()
      ) return false;
      return this.fireNukeFromCandidates(
        valueFallback.candidates,
        valueFallback.target,
        selectedNuke,
        silos,
        difficulty,
      );
    }

    // A live survival threat cannot wait behind a long-term Silo-capacity demand.
    priorityNukeTarget(demandTarget) {
      const incomingTarget = this.attackBehavior?.findIncomingAttackPlayer?.();
      if (incomingTarget && this.isEligibleNukeTarget(incomingTarget)) {
        return { target: incomingTarget, incoming: true };
      }
      const counterforceTarget = this.findCounterforceNukeTarget();
      if (counterforceTarget) {
        return { target: counterforceTarget, incoming: false, counterforce: true };
      }
      return { target: demandTarget ?? this.findBestNukeTarget(), incoming: false };
    }

    isPinnedNukeTarget(priority) {
      return priority.incoming || priority.counterforce === true;
    }

    // An active, heavy land invasion is the one situation where the pinned
    // aggressor's territory is itself a valuable nuclear target, even after
    // structures and recent strike value have been exhausted.
    isInvasionSurvivalTarget(target) {
      if (state.settings.winFixes !== true) return false;
      if (!isLegendaryDifficulty(currentDifficulty())) return false;
      const incoming = this.attackBehavior?.findIncomingAttackPlayer?.();
      if (!incoming || incoming.smallID?.() !== target?.smallID?.()) return false;
      return this.isUnderHeavyAttack() === true;
    }

    findCounterforceNukeTarget() {
      const players = this.game?.players?.() ?? [];
      for (const [ownerId, threat] of this._hostileNukeThreats ?? []) {
        const target = players.find(
          (player) => String(player?.smallID?.()) === String(ownerId),
        );
        if (!target || !this.isEligibleNukeTarget(target)) continue;
        const sourceSiloIds = threat?.sourceSiloIds;
        if (
          (target.units?.(UNIT.MissileSilo) ?? []).some(
            (silo) =>
              silo?.isActive?.() !== false &&
              (!sourceSiloIds?.size || sourceSiloIds.has(String(silo?.id?.() ?? ""))),
          )
        ) {
          return target;
        }
      }
      return null;
    }

    // Shared idle-lane gate: unusable silo set or every tube cooling/queued
    // is an idle lane — record why and skip the ladder + candidate sweep,
    // because sendNuke's probe would reject the shot anyway.
    nukeLaneBlockedByCapacity(silos, tel) {
      if (!this.canConsiderNukes(silos)) {
        tel.siloMissing += 1;
        return true;
      }
      if (this.readySiloShotCapacity(silos) <= 0) {
        tel.tubesEmpty = (tel.tubesEmpty ?? 0) + 1;
        return true;
      }
      return false;
    }

    // Clear shots first, then the anti-SAM salvo planner — the firing tail
    // of maybeSendNuke.
    async fireNukeFromCandidates(
      candidates,
      target,
      selectedNuke,
      silos,
      difficulty,
    ) {
      let ordinaryAction = false;
      let servicedDemand = false;
      const { clear, routeBlockedTile } = this.partitionCandidatesBySamCoverage(
        candidates,
        selectedNuke.type,
        difficulty,
      );
      // DIVERGENCE (winFixes): service a ready SAM demand before a Legendary
      // clear shot can return early and bypass its salvo.
      if (
        isAtLeastHardDifficulty(difficulty) &&
        this.samDemandMatchesTarget(target)
      ) {
        servicedDemand = true;
        ordinaryAction = await this.maybeDestroyEnemySam(
          target, false, routeBlockedTile,
        ) || ordinaryAction;
        if (ordinaryAction) return true;
      }
      if (!isLegendaryDifficulty(difficulty)) {
        const best = await this.selectBuildableNukeCandidate(clear, selectedNuke.type);
        if (
          this.ordinaryNukeCandidateHasValue(best, difficulty) &&
          await this.nukeHasPositiveExpectedValue(best, target, selectedNuke, silos)
        ) {
          ordinaryAction = await this.sendNuke(best.tile, selectedNuke.type, target) ||
            ordinaryAction;
        }
      } else {
        if (await this.fireLegendaryClearFallthrough(clear, target, selectedNuke, silos)) {
          return true;
        }
      }
      // Silo capacity is not a salvo: covered shots must use the planner
      // below so every required atom is launched or queued with timing.
      if (isAtLeastHardDifficulty(difficulty) && !servicedDemand) {
        // Lever CLOSED (2026-10-09): the starvation release (spend held atoms
        // on SAM-overwhelm when clear=[] deterministically lost the baikal
        // no-harm gate in BOTH variants — v1 with failed-plan upgrades and v2
        // without — via the salvo pipeline state, not the salvos themselves:
        // zero sam-salvo events, 87 atoms, bot_dead at 11820; native call
        // restores the standing won@7971 receipt bit-for-bit). The sam regime
        // deadlock stays documented as a native-guard limitation. The
        // allowHeldAtoms parameter and its fixture cases remain for any
        // future lever that pairs the release with its own state scoping.
        ordinaryAction = await this.maybeDestroyEnemySam(
          target, false, routeBlockedTile,
        ) || ordinaryAction;
      }
      // Hydrogen finisher runs before the ladder's next ordinary decision so
      // the freshly-cleared cluster is harvested at maximum blast radius.
      // Raw equality never fires in production: currentDifficulty() maps the
      // Legendary UI tier to the engine's Impossible enum. Use the received
      // difficulty through the union gate like every sibling gate here.
      if (isLegendaryDifficulty(difficulty)) {
        ordinaryAction = await this.maybeFirePostSalvoHydrogen() || ordinaryAction;
      }
      return ordinaryAction;
    }

    // LEGENDARY DIVERGENCE (2026-10-04, pre-declared in
    // docs/legendary-metric-ceilings.md): walk the ranked clear list — an
    // EV rejection no longer masks a lower-scored but EV-positive
    // candidate (measured example: five L1 Cities score 125k with EV
    // fail while one L4 City scores 97k with EV pass — the old single
