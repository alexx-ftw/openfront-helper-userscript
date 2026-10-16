      // salvo cannot be re-validated, so keep the faithful fire-anyway path.
      if (typeof this.game?.nearbyUnits !== "function") return true;
      const salvo = pending.salvo;
      const coveringSams = this.findEnemySamsCoveringTile(salvo.targetTile, true);
      const coveringLevel = coveringSams.reduce(
        (sum, sam) => sum + sam.level(),
        0,
      );
      const capacity = coveringSams.reduce(
        (sum, sam) => sum + this.samSalvoCapacityAtArrival(sam, lastArrivalTick), 0,
      );
      const liveSpend = capacity + 1 > remainingInSalvo
        ? this.samSalvoLiveCapacitySpend(salvo.targetTile, coveringSams, lastArrivalTick)
        : 0;
      if (capacity - liveSpend + 1 > remainingInSalvo) return false;
      const targetSamId = salvo.targetSamId;
      if (
        (targetSamId !== null && targetSamId !== undefined) &&
        coveringLevel === 0
      ) {
        const targetSams =
          typeof pending.targetPlayer?.units === "function"
            ? pending.targetPlayer.units(UNIT.SAMLauncher)
            : [];
        const targetSamExists =
          coveringSams.some((sam) => String(sam.id()) === String(targetSamId)) ||
          targetSams.some((unit) => String(unit.id()) === String(targetSamId));
        if (!targetSamExists) return false;
      }
      return true;
    }

    /**
     * Pre-launch gate for one salvo entry on Legendary (see sendNuke): the
     * awaited build probe can outlive the viability pass in
     * processPendingNukeLaunches, so the exact bomb about to be emitted is
     * re-checked against the live layout: the full salvo viability decision
     * (penetration/overkill, see samSalvoStillViable) runs against the chain
     * still queued, because a SAM built during the probe was invisible to the
     * batch pass. When the salvo was never queued (direct sendNuke
     * counterfactual), only the trajectory is re-checked. The planned covering
     * set stays exempt; anything else able to intercept aborts the salvo (the
     * pending entry is dropped and the capacity demand re-armed). A false
     * spawn tile is transient reload/slot projection, not a SAM change — the
     * awaited probe authorized this exact launch.
     */
    samSalvoLaunchStillViable(tile, targetPlayer, salvo) {
      const spawnTile = this.nukeSpawn(UNIT.AtomBomb, tile);
      if (spawnTile === false) return true;
      const entries = (this._pendingNukeLaunches ?? []).filter(
        (pending) => pending.salvo && pending.salvo.salvoId === salvo.salvoId,
      );
      const now = Number(this.game.ticks());
      const fired = this._salvoFiredCounts?.get(salvo.salvoId) ?? 0;
      // Plan-driven salvos always carry remainingLaunches; a direct sendNuke
      // salvo without it stays on the documented trajectory-only path.
      let remaining = entries.length + fired;
      if (entries.length === 0) {
        remaining = salvo.remainingLaunches == null
          ? 0
          : fired + Math.max(0, Number(salvo.remainingLaunches));
      }
      if (remaining > 0) {
        const arrivals = entries.map((entry) => {
          const flight = entry.salvo.flightTicks;
          return Number.isFinite(flight) && flight >= 0
            ? Math.max(now, entry.dueTick) + flight
            : NaN;
        });
        const lastArrivalTick = arrivals.length > 0
          ? Math.max(...arrivals)
          : Number(salvo.lastArrivalTick);
        if (!this.samSalvoStillViable(
          entries[0] ?? { targetPlayer, salvo },
          remaining,
          lastArrivalTick,
        )) {
          this._salvoLaunchAbort = salvo.salvoId;
          return false;
        }
      }
      const exempt = new Set([...(salvo.coveringSamIds ?? [])]);
      if (this.isTrajectoryInterceptableBySam(
        spawnTile, tile, exempt, { includeUnderConstruction: true },
      )) {
        this._salvoLaunchAbort = salvo.salvoId;
        return false;
      }
      return true;
    }

    /**
     * After a mid-flight abort drained the queue: re-arm the capacity demand
     * against the live SAM layout so the structure lane can rebuild/upgrade
     * before the next strike, or release a request with no coverage left.
     */
    rearmAbortedSamDemand(droppedEntries) {
      if (state.settings.winFixes !== true) {
        state.nukeWantSlots = null;
        this._samDemandRequest = null;
        return false;
      }
      const entry = (Array.isArray(droppedEntries) ? droppedEntries : [])
        .find((item) => item.salvo);
      const covering = this.abortedSamCoverage(entry);
      if (covering.length === 0) {
        state.nukeWantSlots = null;
        this._samDemandRequest = null;
        return false;
      }
      const silos = typeof this.player?.units === "function"
        ? (this.player.units(UNIT.MissileSilo) || [])
            .filter((silo) => !silo.isUnderConstruction())
        : [];
      const targetSam = covering[0];
      if (
        typeof targetSam?.level !== "function" ||
        typeof targetSam?.tile !== "function" ||
        silos.length === 0
      ) {
        state.nukeWantSlots = null;
        this._samDemandRequest = null;
        return false;
      }
      const plan = this.createSamOverwhelmPlan(targetSam, silos);
      if (!plan) {
        state.nukeWantSlots = null;
        this._samDemandRequest = null;
        return false;
      }
      this.rememberFailedSamTarget(plan);
      return true;
    }

    samSalvoLiveCapacitySpend(targetTile, coveringSams, lastArrivalTick) {
      const planner = this.structureBehavior;
      const horizon = lastArrivalTick - Number(this.game.ticks());
      const cooldown = Number(this.game.config?.().SAMCooldown?.());
      if (!planner || typeof this.game.units !== "function" ||
          !Number.isFinite(horizon) || horizon < 0 ||
          !Number.isFinite(cooldown) || cooldown <= 0) return 0;
      const sams = this.game.units(UNIT.SAMLauncher).filter((sam) =>
        sam.isActive() &&
        this.isHostileSamIntercept({ unit: sam, distSquared: 0 }));
      const profiles = planner.buildLegendaryFriendlySamProfiles(sams, null, null);
      const routes = this.samSalvoUnclaimedLiveRoutes(targetTile, horizon, profiles);
      if (routes.length === 0) return 0;
      // Unknown completion matters only if the unfinished SAM can intercept
      // these missiles. Remote construction cannot change their assignments.
      const unfinishedIds = new Set(sams.filter((sam) => sam.isUnderConstruction())
        .map((sam) => sam.id()));
      if (routes.some((route) => route.samOptions.some((option) =>
        unfinishedIds.has(profiles[option.samIndex]?.id)))) return 0;
      const schedule = legendaryMissileDefenseSchedule({
        routes, samProfiles: profiles, samCooldownTicks: cooldown, marginTicks: 0,
      });
      // Only credit a complete, engine-order-compatible forecast. An unknown
      // path or ambiguous assignment must not turn a cancelled shot into a bet.
      if (!schedule.fullyDefended) return 0;
      const coveringIds = new Set(coveringSams.map((sam) => sam.id()));
      return schedule.missiles.filter((missile) =>
        coveringIds.has(profiles[missile.samIndex]?.id) &&
        missile.samFireTick + cooldown > horizon).length;
    }

    samSalvoUnclaimedLiveRoutes(targetTile, horizon, profiles) {
      const claimed = new Set(this.game.units(UNIT.SAMMissile)
        .filter((missile) => missile.isActive())
        .map((missile) => missile.targetUnit()?.id()));
      const routes = [];
      for (const missile of this.player.units?.(UNIT.AtomBomb) ?? []) {
        if (!missile.isActive() || missile.targetTile() !== targetTile ||
            claimed.has(missile.id())) continue;
        const motion = this.structureBehavior.legendaryActiveMissileMotion(missile, missile.tile());
        if (!motion || motion.impactTick > horizon) continue;
        routes.push(this.structureBehavior.legendaryBuildMissileRoute({
          ...motion, targetTile, weapon: UNIT.AtomBomb, id: `salvo-live:${missile.id()}`,
        }, profiles));
      }
      return routes;
    }

    samSalvoCapacityAtArrival(sam, lastArrivalTick) {
      const cooldown = Number(this.game.config?.().SAMCooldown?.());
      const queue = sam.missileTimerQueue?.();
      if (!Number.isFinite(lastArrivalTick) || !Number.isFinite(cooldown) || !Array.isArray(queue)) {
        return sam.level();
      }
      // Count a cooling slot as available if it can reload before the latest
