    // interception aborts the finisher — it would fly into live coverage,
    // exactly the waste the salvo discipline forbids).
    async maybeFirePostSalvoHydrogen() {
      const pending = state.postSalvoHydrogen;
      if (!pending) return false;
      const target = this.postSalvoHydrogenTarget(pending);
      if (target === null) {
        state.postSalvoHydrogen = null;
        return false;
      }
      // DIVERGENCE: silo staggering or retries can outlive the planned deadline.
      const atomsInFlight = this.extendFinisherForLiveAtoms(pending);
      if (atomsInFlight) return false;
      if (this.game.ticks() < pending.dueTick) return false;
      // A delayed/retried atom must land before its finisher is evaluated.
      if (pending.salvoId !== undefined && this._pendingNukeLaunches.some(
        (launch) => launch.salvo?.salvoId === pending.salvoId,
      )) return false;
      const config = this.game.config();
      // LEGENDARY DIVERGENCE (2026-10-04, pre-declared in
      // docs/legendary-metric-ceilings.md): the pending finisher used to be
      // discarded before its probes, so a transient blocker — full silo
      // queues, a temporarily unaffordable treasury, regrown SAM coverage, or
      // a failed buildability dispatch — permanently lost a scheduled
      // follow-up. Retain it through transient failures; only permanent
      // conditions (disabled bombs, invalid target/destination) or a successful
      // dispatch clear it. Every firing gate is unchanged.
      if (config.isUnitDisabled(UNIT.HydrogenBomb)) {
        state.postSalvoHydrogen = null;
        return false;
      }
      const hydroCost = await this.getPerceivedNukeCost(UNIT.HydrogenBomb);
      if (this.postSalvoHydrogenTarget(pending) === null) {
        state.postSalvoHydrogen = null;
        return false;
      }
      if (this.player.gold() < hydroCost) return false;
      const silos = this.player.units(UNIT.MissileSilo)
        .filter((silo) => !silo.isUnderConstruction());
      if (silos.length === 0) return false;
      // Projected coverage: a SAM under construction completes before impact,
      // so it blocks the finisher like an armed one.
      if (this.findEnemySamsCoveringTile(pending.targetTile, true).length > 0) {
        return false;
      }
      // LEGENDARY DIVERGENCE (2026-10-08, pre-declared in
      // docs/legendary-metric-ceilings.md): the finisher was the one nuclear
      // dispatch path that never priced friendly-fire. Its blast circle is
      // the largest (Hydrogen outer), and offensive-reach silo placement
      // deliberately moves our silos toward hostile centers, so a blind
      // dispatch could erase our own forward structures. Apply the same
      // monetary geometry as the anti-SAM aim selector: fire only when the
      // remaining enemy structure value inside the blast covers the friendly
      // replacement loss (blastStructureValue vs friendlyFirePenalty).
      // Rejection holds the finisher instead of clearing it: the geometry
      // can change (own structures inside the circle are destroyed by the
      // enemy, enemy structures grow), and the integrated Baikal receipt
      // showed a permanently cleared finisher cascading into worse survival.
      // Degenerate magnitudes (config shims without nukeMagnitudes) price
      // every blast as empty, so the finisher safely holds instead of firing
      // unpriced.
      if (!this.postSalvoHydrogenHasValue(config, target, pending)) return false;
      // Recheck friendly land after the async nuke probe; a rejection keeps
      // this finisher pending until the blast area is safe.
      const sent = await this.sendNuke(
        pending.targetTile,
        UNIT.HydrogenBomb,
        target,
        0,
      );
      if (sent || this.postSalvoHydrogenTarget(pending) === null) {
        state.postSalvoHydrogen = null;
      }
      return sent;
    }

    postSalvoHydrogenTarget(pending) {
      if (pending.targetSmallID === null) return null;
      const target = this.game.players().find(
        (player) => player.smallID?.() === pending.targetSmallID,
      );
      if (!target || !this.isEligibleNukeTarget(target) ||
          !this.isValidNukeDestination(pending.targetTile)) return null;
      return target;
    }

    async maybeDestroyEnemySam(nukeTarget, allowHeldAtoms = false, routeCandidateTile = null) {
      if (this.game.config().isUnitDisabled(UNIT.AtomBomb)) return false;
      if (this.player.units(UNIT.AtomBomb).length > 0 && !allowHeldAtoms) return false;
      const enemySams = this.samSalvoTargetsFor(nukeTarget, routeCandidateTile);
      if (enemySams.length === 0) {
        state.nukeWantSlots = null;
        this._samDemandRequest = null;
        return false;
      }
      const silos = this.player.units(UNIT.MissileSilo)
        .filter((silo) => !silo.isUnderConstruction());
      if (silos.length === 0) return false;
      const atomCost = await this.cost(UNIT.AtomBomb);
      let failedTarget = null;
      const orderedSams = this.orderCounterforceSams(enemySams, nukeTarget);
      this.pinDemandSam(orderedSams);
      for (const targetSam of orderedSams) {
        const attempt = await this.tryEnemySamSalvo(
          targetSam,
          nukeTarget,
          silos,
          atomCost,
          allowHeldAtoms,
        );
        if (attempt === true) return true;
        if (attempt) failedTarget ??= this.rememberFailedSamTarget(attempt);
      }
      if (failedTarget) return this.maybeUpgradeHelpfulSilo(failedTarget);
      return false;
    }

    async tryEnemySamSalvo(targetSam, nukeTarget, silos, atomCost, allowHeldAtoms) {
      const plan = this.createSamOverwhelmPlan(targetSam, silos, nukeTarget);
      if (!plan) {
        state.nukeWantSlots = null;
        this._samDemandRequest = null;
        return null;
      }
      if (plan.capacityMissing) {
        // Preserve the capacity-missing lane's historical construction policy.
        return allowHeldAtoms ? null : plan;
      }
      return await this.fireSamSalvo(plan, nukeTarget, atomCost) ? true : null;
    }

    // Hostile SAMs covering the most valuable structure tile of a target that
    // owns no SAM itself (neighbouring/allied air defense). Empty when the
    // target has neither its own SAMs nor covering ones.
    coveringSamsForSamFreeTarget(nukeTarget) {
      const structures = unitsOfTypes(nukeTarget)
        .map((unit) => ({ unit, value: this.nukeStructureValue(unit) }))
        .sort((a, b) => b.value - a.value);
      for (const { unit } of structures) {
        const covering = this.findEnemySamsCoveringTile(unit.tile());
        if (covering.length > 0) return covering;
      }
      return [];
    }

    // Route-only interceptors can block a valuable nuke route without
    // covering the destination. Collect all of them together so overlapping
    // SAMs still become counterforce targets.
    routeOnlyInterceptingSams(nukeTarget, routeCandidateTile = null) {
      const silos = (this.player.units?.(UNIT.MissileSilo) ?? [])
        .filter((silo) => !silo.isUnderConstruction?.());
      if (silos.length === 0) return [];
      const found = [];
      const seen = new Set();
      if (routeCandidateTile != null) {
        this.collectRouteInterceptorsForTile(routeCandidateTile, found, seen);
        return found;
      }
      const structures = unitsOfTypes(nukeTarget)
        .map((unit) => ({ unit, value: this.nukeStructureValue(unit) }))
        .sort((a, b) => b.value - a.value);
      for (const { unit } of structures) {
        const tile = unit.tile?.();
        if (tile == null) continue;
        this.collectRouteInterceptorsForTile(tile, found, seen);
        if (found.length > 0) return found;
      }
      return found;
    }

    // Salvo targets include target/structure SAMs and every blocker on the
    // candidate route, so an existing target SAM cannot hide a route-only one.
    samSalvoTargetsFor(nukeTarget, routeCandidateTile = null) {
      const owned = nukeTarget.units(UNIT.SAMLauncher).filter((sam) => this.isEnemyNukeSam(sam));
      let covering = [];
      if (owned.length === 0) covering = this.coveringSamsForSamFreeTarget(nukeTarget);
      let route = [];
      if (routeCandidateTile != null) {
        route = this.routeOnlyInterceptingSams(nukeTarget, routeCandidateTile);
      } else if (owned.length === 0 && covering.length === 0) {
        route = this.routeOnlyInterceptingSams(nukeTarget);
      }
      return [...new Map(
        [...owned, ...covering, ...route].map((sam) => [String(sam.id()), sam]),
      ).values()];
    }
