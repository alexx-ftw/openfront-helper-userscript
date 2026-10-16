
    addAllyRescuePressure(attack, pressureByAttacker) {
      const attacker = attack.attacker?.();
      if (!attacker || attacker.isAlive?.() === false) return;
      if (playersArePermanentTeammates(this.player, attacker)) return;
      if (attacker.smallID?.() === this.player.smallID?.()) return;
      if (!this.isEligibleNukeTarget(attacker)) return;
      const troops = Math.max(0, Number(attack.troops?.()) || 0);
      if (troops <= 0) return;
      const current = pressureByAttacker.get(attacker.smallID()) ?? {
        attacker,
        troops: 0,
      };
      current.troops += troops;
      pressureByAttacker.set(attacker.smallID(), current);
    }

    hostileMissileTarget(missile, selfId) {
      const owner = missile?.owner?.();
      const ownerId = owner?.smallID?.();
      const targetTile = missile?.targetTile?.();
      if (
        ownerId === null ||
        ownerId === undefined ||
        ownerId === selfId ||
        playersArePermanentTeammates(this.player, owner) ||
        targetTile === null ||
        targetTile === undefined
      ) {
        return null;
      }
      return {
        owner,
        ownerId,
        launchTile: this.hostileMissileLaunchTile(missile),
        targetTile,
      };
    }

    hostileMissileLaunchTile(missile) {
      return missile?.trajectory?.()?.[0]?.tile;
    }

    missileThreatensFriendlyStructures(missile, targetTile, context) {
      context.friendlyStructures ??= this.collectFriendlyNukeStructureUnits();
      const type = missile?.type?.();
      const radius = Number(
        this.game.config?.()?.nukeMagnitudes?.(type)?.outer,
      );
      if (!Number.isFinite(radius) || radius <= 0) return false;
      const withinBlast = euclDistFN(targetTile, radius, false);
      if (
        !context.friendlyStructures.some((unit) =>
          withinBlast(this.game, unit?.tile?.()),
        )
      ) {
        return false;
      }
      return true;
    }

    resolveStrategicBorderArmyTarget() {
      const strongest =
        this.structureBehavior?.strongestQuietStrategicBorderOpponent?.();
      if (!this.isCriticalStrategicBorderForce(strongest)) return null;
      const target = this.game.players().find(
        (other) => other.smallID?.() === strongest.opponentSid,
      ) ?? null;
      return this.isEligibleNukeTarget(target) ? target : null;
    }

    isCriticalStrategicBorderForce(strongest) {
      const ownTroops = Number(this.player?.troops?.() ?? 0);
      // The garrison view can lag an emitted intent; active outgoing armies are already debited.
      const ownDefendingTroops = Math.max(
        0,
        ownTroops - Math.max(0, Number(
          this.attackBehavior?.getPendingOutboundAttackTroops?.(true) ?? 0,
        ) || 0),
      );
      const hostileTroops = Number(strongest?.troops);
      return strongest !== null &&
        Number.isFinite(ownTroops) &&
        ownTroops > 0 &&
        Number.isFinite(hostileTroops) &&
        hostileTroops > 0 &&
        hostileTroops >= ownDefendingTroops;
    }

    isEnemyNukeLand(owner) {
      return owner && owner.isPlayer && owner.isPlayer() &&
        !this.player.isFriendly(owner, true);
    }

    nukeLaunchRouteViable(tile, nukeType, targetPlayer, salvo) {
      const difficulty = currentDifficulty();
      if (salvo && isLegendaryDifficulty(difficulty))
        return this.samSalvoLaunchStillViable(tile, targetPlayer, salvo);
      if (!isAtLeastHardDifficulty(difficulty)) return true;
      const spawnTile = this.nukeSpawn(nukeType, tile);
      const exemptSamIds = salvo ? new Set(salvo.coveringSamIds ?? []) : undefined;
      return spawnTile !== false &&
        !this.isTrajectoryInterceptableBySam(spawnTile, tile, exemptSamIds);
    }

    emitNukeWithSalvoFlight(buildable, tile, salvo) {
      const liveFlight = salvo && typeof this.player.units === "function"
        ? this.getAvailableSiloEntries(this.player.units(UNIT.MissileSilo), tile, new Set())[0]?.flightTicks
        : undefined;
      if (!this.emitNukeBuildable(buildable, tile, salvo)) return false;
      if (salvo?.claimId !== null && salvo?.claimId !== undefined &&
          typeof autoBotBuildReleaseNukeLaunchClaim === "function") {
        autoBotBuildReleaseNukeLaunchClaim(this.game, this.player, salvo.claimId);
      }
      if (Number.isFinite(liveFlight)) salvo.flightTicks = liveFlight;
      if (salvo) {
        // Every launched atom of a salvo keeps counting toward its
        // penetration budget (see getAbortedSalvoIds), however it was sent.
        const fired = (this._salvoFiredCounts ??= new Map());
        fired.set(salvo.salvoId, (fired.get(salvo.salvoId) ?? 0) + 1);
      }
      return true;
    }

    deferPendingNukeLaunch(pending, now, remaining, blockedSalvoIds) {
      if (pending.dueTick > now || (pending.salvo && blockedSalvoIds.has(pending.salvo.salvoId))) {
        if (pending.dueTick <= now) pending.dueTick = now + 1;
        remaining.push(pending);
        if (pending.salvo) blockedSalvoIds.add(pending.salvo.salvoId);
        return true;
      }
      return false;
    }

    recordPendingNukeFailure(
      outcome,
      pending,
      now,
      { droppedAbortedEntries, remaining, abortedSalvoIds },
      blockedSalvoIds,
    ) {
      if (
        outcome === "drop" && pending.salvo &&
        this._salvoLaunchAbort === pending.salvo.salvoId
      ) {
        abortedSalvoIds.add(pending.salvo.salvoId);
        droppedAbortedEntries.push(pending);
        this._salvoLaunchAbort = null;
      } else if (outcome === "retry") {
        pending.dueTick = now + 1;
        remaining.push(pending);
        if (pending.salvo) blockedSalvoIds.add(pending.salvo.salvoId);
      }
    }

    extendPendingSalvoFinisher(sent, pending) {
      const finisher = state.postSalvoHydrogen;
      if (sent && pending.salvo && finisher?.salvoId === pending.salvo.salvoId &&
          Number.isFinite(pending.salvo.flightTicks)) {
        finisher.dueTick = Math.max(finisher.dueTick,
          Number(this.game.ticks()) + pending.salvo.flightTicks + 5);
      }
    }

    abortedSamCoverage(entry) {
      const tile = entry ? (entry.tile ?? entry.salvo?.targetTile) : null;
      const covering = tile === null || tile === undefined ||
        typeof this.game?.nearbyUnits !== "function"
        ? []
        : this.findEnemySamsCoveringTile(tile, true)
            .filter((sam) => this.isValidNukeTarget(sam.owner?.()))
            .sort((a, b) => a.level() - b.level());
      return covering;
    }

    recordSalvoFlight(flightTicks, index, flight) {
      flightTicks[index] = flight;
    }
