      if (silos.length === 0) return 0n;
      // The baseline interceptor outranks the bombardment: holding the Atom
      // price while a hostile silo exists with no SAM of our own keeps the
      // treasury below the 1.5M launcher price through the exact window the
      // first strike lands (four nuked buildings on Baikal otherwise).
      if (
        this.ownSamCapacity() <= 0 &&
        this.hasBuiltHostileSiloThreat()
      ) {
        return 0n;
      }
      if (!this.legendaryNukeStructureTargetExists()) {
        return 0n;
      }
      const atomCost = this.safeConstructionCost(UNIT.AtomBomb) ?? 0n;
      // DIVERGENCE: ordinary growth must not consume a scheduled salvo's tail.
      const pendingAtoms = (this.nukeBehavior?._pendingNukeLaunches ?? [])
        .filter((launch) => launch.nukeType === UNIT.AtomBomb).length;
      return atomCost * BigInt(Math.max(1, pendingAtoms));
    }

    // A live hostile (never a permanent teammate) owning any structure the
    // nuke scorer values. Bounded by the player list; structure unit reads
    // are the same per-tick cached views the rest of the planner uses.
    legendaryNukeStructureTargetExists() {
      const mySid = this.player?.smallID?.();
      if (mySid == null) return false;
      for (const other of this.game.players() ?? []) {
        if (this.legendaryNukeStructureTargetCandidate(other, mySid)) {
          return true;
        }
      }
      return false;
    }

    legendaryNukeStructureTargetCandidate(other, mySid) {
      if (!other?.isPlayer?.()) return false;
      if (other.smallID?.() === mySid) return false;
      if (other.isAlive?.() === false) return false;
      if (playersArePermanentTeammates(this.player, other)) return false;
      const structureTypes = [
        UNIT.City,
        UNIT.DefensePost,
        UNIT.MissileSilo,
        UNIT.Port,
        UNIT.Factory,
        UNIT.SAMLauncher,
      ];
      return structureTypes.some(
        (type) => (other.units?.(type) || []).length > 0,
      );
    }

    legendaryMissileDefenseUrgent() {
      if (this.hasMissileDefenseSignal() === false) return false;
      const context = this.getMissileDefenseContext();
      if (!context || !Array.isArray(context.threats) || context.threats.length === 0) {
        return false;
      }
      const evaluation = this.getMissileDefenseEvaluation(context);
      if (evaluation.hasThreats && !evaluation.fullyDefended) {
        return true;
      }
      if (context.critical && !evaluation.fullyDefended) return true;
      return false;
    }

    legendaryHostilePlayers() {
      const mySid = this.player.smallID();
      const hostile = [];
      {
        for (const other of this.game.players()) {
          if (
            !other ||
            (typeof other.isPlayer === "function" && !other.isPlayer()) ||
            other.smallID() === mySid
          ) {
            continue;
          }
          const friendly =
            this.player.isFriendly(other) || this.player.isOnSameTeam(other);
          if (friendly) continue;
          hostile.push(other);
        }
      }
      return hostile;
    }

    liveHostilePlayers() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return null;
      }
      const snapshotTick = safeStructureGameTick(this.game);
      if (
        snapshotTick !== null &&
        this._hostilePlayersSnapshotTick === snapshotTick &&
        Array.isArray(this._hostilePlayersSnapshot)
      ) {
        return this._hostilePlayersSnapshot;
      }

      const players = this.structurePlayersSnapshot();
      if (!Array.isArray(players)) return null;
      const mySid = this.readPlayerSmallId(this.player);
      const hostile = players.filter((other) =>
        this.isLiveHostilePlayer(other, mySid),
      );
      if (snapshotTick !== null) {
        this._hostilePlayersSnapshotTick = snapshotTick;
        this._hostilePlayersSnapshot = hostile;
      }
      return hostile;
    }

    legendaryNuclearHostilePlayers() {
      const mySid = this.player.smallID();
      return this.game.players().filter((other) =>
        this.isLiveNuclearHostilePlayer(other, mySid),
      );
    }

    liveNuclearHostilePlayers() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return null;
      }
      const players = this.structurePlayersSnapshot();
      if (!Array.isArray(players)) return null;
      const mySid = this.readPlayerSmallId(this.player);
      return players.filter((other) =>
        this.isLiveNuclearHostilePlayer(other, mySid),
      );
    }

    structurePlayersSnapshot() {
      {
        return this.game.players();
      }
    }

    readPlayerSmallId(player) {
      {
        return player.smallID();
      }
    }

    isLiveHostilePlayer(other, mySid) {
      if (!other || other === this.player) return false;
      if (typeof other.isPlayer === "function" && !other.isPlayer()) return false;
      const otherSid = this.readPlayerSmallId(other);
      if (mySid !== null && otherSid === mySid) return false;
      {
        if (typeof other.isAlive === "function" && !other.isAlive()) return false;
        return !(
          this.player.isFriendly(other) || this.player.isOnSameTeam(other)
        );
      }
    }

    isLiveNuclearHostilePlayer(other, mySid) {
      if (!other || other === this.player) return false;
