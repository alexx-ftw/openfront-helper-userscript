
    hasActiveMaritimeInvasion() {
      {
        return this.structureBehavior?.hasActiveMaritimeInvasion?.() === true;
      }
    }

    isRetaliationNukeTarget(nukeTarget) {
      {
        const findIncoming = this.attackBehavior?.findIncomingAttackPlayer;
        if (typeof findIncoming !== "function" || !nukeTarget) return false;
        const incoming = findIncoming.call(this.attackBehavior);
        if (typeof incoming?.smallID !== "function") return false;
        if (typeof nukeTarget.smallID !== "function") return false;
        return incoming.smallID() === nukeTarget.smallID();
      }
    }

    findTwoPlayerNukeTarget(difficulty) {
      if (!isAtLeastHardDifficulty(difficulty)) return null;
      const players = this.game.players();
      if (players.length !== 2) return null;
      return players.find((other) => other.smallID() !== this.player.smallID()) ?? null;
    }

    findDominantCrownNukeTarget(difficulty) {
      if (!isAtLeastHardDifficulty(difficulty)) return null;
      if (this.game.config().gameConfig().gameMode !== GameMode.FFA) return null;
      const availableTiles = this.game.numLandTiles() - this.game.numTilesWithFallout();
      if (availableTiles <= 0) return null;
      const crown = this.game.players().slice()
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())[0];
      if (!crown || crown.smallID() === this.player.smallID()) return null;
      if (playersArePermanentTeammates(this.player, crown)) return null;
      return crown.numTilesOwned() / availableTiles > 0.5 ? crown : null;
    }

    findAllyNukeTarget() {
      // Player.allies() contains only explicit, breakable alliances and omits
      // permanent teammates. Nuclear coordination treats only permanent teams
      // as allied ownership.
      for (const ally of this.game.players()) {
        if (ally.smallID() === this.player.smallID()) continue;
        if (ally.isAlive?.() === false) continue;
        if (!playersArePermanentTeammates(this.player, ally)) continue;
        const target = ally.targets().find((candidate) =>
          candidate.smallID() !== this.player.smallID() &&
          !playersArePermanentTeammates(this.player, candidate));
        if (target) return target;
      }
      return null;
    }

    findHostileNukeTarget(eligibleOnly = false) {
      for (const relation of this.player.allRelationsSorted()) {
        if (relation.relation !== Relation.Hostile) continue;
        const other = relation.player;
        if (eligibleOnly && !this.isEligibleNukeTarget(other)) continue;
        if (playersArePermanentTeammates(this.player, other)) continue;
        // A hostile is still a legitimate nuclear target when we have grown
        // larger.  The old 2x-capacity veto made a winning nation unable to
        // auto-nuke any weaker enemy in a multi-player game, even with ready
        // silos and a positive target score.  Resource, trajectory and target
        // scoring gates below still decide whether firing is worthwhile.
        return other;
      }
      return null;
    }

    // ── findBestNukeTarget — NationNukeBehavior.ts:166 ────────────────────────
    findBestNukeTarget() {
      const target = this.findBestNukeTargetCandidate();
      return target?.type?.() === PlayerType.Bot ? null : target;
    }

    findBestNukeTargetCandidate() {
      const difficulty = currentDifficulty();
      this.observeHostileNukeThreats();
      const twoPlayerTarget = this.findTwoPlayerNukeTarget(difficulty);
      if (twoPlayerTarget) return twoPlayerTarget;

      // Retaliate against incoming attacks (Most important!)
      const incomingAttackPlayer = this.attackBehavior.findIncomingAttackPlayer();
      if (incomingAttackPlayer) {
        return incomingAttackPlayer;
      }

      // DIVERGENCE (Legendary, pre-declared in legendary-metric-ceilings.md):
      // a hostile Nation/Human on our shared border with at least our army can
      // commit a decisive invasion before it appears in incomingAttacks().
      // Reuse StructureBehavior's cached strategic-border scan so nukes and
      // preemptive Defense Posts react to the same threat snapshot.
      if (isLegendaryDifficulty(difficulty)) {
        const counterforceTarget = this.findStrategicBorderArmyTarget();
        if (counterforceTarget !== null) return counterforceTarget;
      }

      // Team-support lane (winFixes): a permanent teammate under hostile
      // invasion loses the tiles/troops that keep the team alive — every
      // measured team loss ended with finalAllies empty while we thrived
      // solo. Prefer the aggressor putting the largest incoming pressure on
      // our teammates, below our own defense lanes, above crown/density.
      if (isLegendaryDifficulty(difficulty)) {
        const rescueTarget = this.findAllyRescueNukeTarget();
        if (rescueTarget !== null) return rescueTarget;
      }

      // On Impossible/Legendary, the richest nation hunts very high structure density targets
      // Restricting to the richest nation prevents every impossible nation
      // from piling onto the same compact player.
      if (isAtLeastHardDifficulty(difficulty) && this.isRichestNation() && this.random.chance(2)) {
        const denseTarget = this.findHighDensityTarget();
        if (denseTarget !== null) return denseTarget;
      }
      return this.findNukeRelationTarget(difficulty);
    }

    // Hostile attacker with the largest aggregate invasion pressure on our
    // permanent teammates (attack objects are mirrored the same way as
    // findIncomingAttackPlayer). Null when nobody is invading the team.
    findAllyRescueNukeTarget() {
      if (state.settings.winFixes !== true) return null;
      const pressureByAttacker = new Map();
      for (const ally of this.game.players?.() ?? []) {
        this.collectAllyRescuePressure(ally, pressureByAttacker);
      }
      let largest = null;
      for (const pressure of pressureByAttacker.values()) {
        if (largest === null || pressure.troops > largest.troops) {
          largest = pressure;
        }
      }
      return largest?.attacker ?? null;
    }

    observeHostileNukeThreats() {
      this.ensureHostileNukeThreatMap();
      if (
        state.settings.winFixes !== true ||
        !isLegendaryDifficulty(currentDifficulty())
      ) {
        this._hostileNukeThreats.clear();
        return;
      }
      const now = Number(this.game?.ticks?.());
      if (!Number.isFinite(now)) return;
      for (const [ownerId, threat] of this._hostileNukeThreats) {
        if (now - threat.observedAt > COUNTERFORCE_THREAT_TTL_TICKS) {
          this._hostileNukeThreats.delete(ownerId);
        }
      }
      if (typeof this.game?.units !== "function") return;
      const selfId = this.player.smallID();
      const context = { friendlyStructures: null };
      for (const missile of this.game.units(UNIT.AtomBomb, UNIT.HydrogenBomb) || []) {
        this.observeHostileNukeThreat(missile, selfId, now, context);
      }
    }

    observeHostileNukeThreat(missile, selfId, now, context) {
      const threat = this.hostileMissileTarget(missile, selfId);
      if (
        threat === null ||
        !this.missileThreatensFriendlyTarget(missile, threat.targetTile, selfId, context)
      ) return;
      const { owner, ownerId, launchTile } = threat;
      const sourceSilo =
        launchTile === null || launchTile === undefined
          ? null
          : (owner?.units?.(UNIT.MissileSilo) ?? []).find(
              (silo) =>
                silo?.tile?.() === launchTile && silo?.isActive?.() !== false,
            );
      const previous = this._hostileNukeThreats.get(ownerId);
      const sourceSiloIds = new Set(previous?.sourceSiloIds ?? []);
      const sourceSiloId = sourceSilo?.id?.();
      if (sourceSiloId !== null && sourceSiloId !== undefined) {
        sourceSiloIds.add(String(sourceSiloId));
      }
      this._hostileNukeThreats.set(ownerId, { observedAt: now, sourceSiloIds });
    }
