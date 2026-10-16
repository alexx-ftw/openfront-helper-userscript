      if (typeof other.isPlayer === "function" && !other.isPlayer()) return false;
      const otherSid = this.readPlayerSmallId(other);
      if (mySid !== null && otherSid === mySid) return false;
      if (typeof other.isAlive === "function" && !other.isAlive()) return false;
      return !playersArePermanentTeammates(this.player, other);
    }

    playerGoldBigInt(player) {
      if (!player || typeof player.gold !== "function") return null;
      {
        return BigInt(player.gold());
      }
    }

    // A silo/SAM level is also the number of missiles it can have in its
    // cooldown queue. Keep the defensive capacity calculation aligned with
    // that engine mechanic: built active units contribute their level and a
    // unit under construction contributes one projected slot.
    playerUnitCapacitySummary(player, type) {
      if (!player || typeof player.units !== "function") return null;
      let units;
      {
        units = player.units(type);
      }
      if (!Array.isArray(units)) return null;

      let count = 0;
      let capacity = 0;
      let builtCapacity = 0;
      let builtCount = 0;
      for (const unit of units) {
        const contribution = this.unitCapacityContribution(unit);
        if (contribution === null) continue;
        count += contribution.count;
        capacity += contribution.capacity;
        builtCapacity += contribution.builtCapacity;
        builtCount += contribution.builtCount;
      }
      return { count, capacity, builtCapacity, builtCount };
    }

    unitCapacityContribution(unit) {
      if (!unit) return null;
      {
        const underConstruction =
          typeof unit.isUnderConstruction === "function" &&
          unit.isUnderConstruction();
        if (underConstruction) {
          return { count: 1, capacity: 1, builtCapacity: 0, builtCount: 0 };
        }
        if (typeof unit.isActive === "function" && !unit.isActive()) return null;
        const rawLevel = typeof unit.level === "function" ? unit.level() : 1;
        const level = Number(rawLevel ?? 1);
        const builtCapacity = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
        return {
          count: 1,
          capacity: builtCapacity,
          builtCapacity,
          builtCount: 1,
        };
      }
    }

    ownSamCapacity() {
      return this.playerUnitCapacitySummary(this.player, UNIT.SAMLauncher)
        ?.builtCapacity ?? 0;
    }

    ownProjectedSamCapacity() {
      return this.playerUnitCapacitySummary(this.player, UNIT.SAMLauncher)
        ?.capacity ?? 0;
    }

    // A hostile silo (built or under construction) starts the interceptor
    // race: a first SAM needs 1.5M and 300 construction ticks, so an economy
    // that keeps spending that treasury on Cities/Ports/Factories meets the
    // first hostile nuke uncovered (Baikal Team ofh-n-b1: first strike 5452,
    // SAM ready 6054 because gold never crossed 1.5M until then). While the
    // baseline is missing, freeze economic candidates so the chest fills;
    // the SAM emergency lane then spends it directly.
    legendarySamBaselineChestActive() {
      if (!isLegendaryDifficulty()) return false;
      const ownSam = this.playerUnitCapacitySummary(
        this.player,
        UNIT.SAMLauncher,
      );
      if (ownSam === null || ownSam.count > 0) return false;
      // Extended spawn immunity (Temporary PVP Immunity profile) is a
      // guaranteed peace window: attacks are impossible until it expires, so
      // the 1.5M interceptor must be funded THEN — after it ends, the first
      // hostile nuke can arrive faster than 300 construction ticks (measured
      // More-Than-Luck temp row: first nuke 11245, SAM never ready).
      if (this.legendaryPeaceWindowSamChestDue()) return true;
      if (!this.shouldBuildHostileSiloSam()) return false;
      // Forecast release (goal requirement: weigh enemy economy prediction
      // and Silo levels for economy-vs-SAM): while the sampled threat ETA
      // provably trails our SAM-readiness ETA by the safety margin, the
      // chest stays OFF and economy compounds — every later defense gets
      // cheaper. Null forecast (insufficient samples) keeps the chest's
      // conservative default.
      if (!this.nuclearThreatOutrunsOurSamReadiness()) return false;
      const gold = legendaryBigInt(this.player?.gold?.() || 0n);
      return gold < this.cost(UNIT.SAMLauncher);
    }

    // True while extended spawn immunity protects us but expires soon enough
    // that SAM construction must start inside the window to beat the first
    // possible strike. Ordinary 50-tick immunity is the no-modifier default
    // and does not justify hoarding before any hostile silo exists.
    legendaryPeaceWindowSamChestDue() {
      if (typeof this.game?.isSpawnImmunityActive !== "function") return false;
      if (this.game.isSpawnImmunityActive() !== true) return false;
      const duration = Number(
        this.game?.config?.()?.spawnImmunityDuration?.() ?? 0,
      );
      const ticks = Number(this.game?.ticks?.() ?? 0);
      if (duration <= 500) return false;
      // Hoard against a DEADLINE, not half-window: freezing economic builds
      // at duration/2 (tick 1200 of 2400) locks income at the 1-City level
      // and the 1.5M chest takes thousands of ticks to fill. Long windows
      // keep compounding until 750 ticks before expiry — the SAM needs 300
      // construction ticks, leaving ~450 ticks for a much larger economy to
      // accumulate the interceptor fund. Short windows keep the half-window
      // start.
      const hoardStart = duration >= 1800
        ? duration - 750
        : Math.floor(duration / 2);
      return this.ownedLevels(UNIT.City) > 0 && ticks >= hoardStart;
    }

    legendarySamChestBlocksType(type) {
      if (!this.legendarySamBaselineChestActive()) return false;
      if (ECONOMIC_STRUCTURE_TYPES.includes(type)) return true;
      // Our own first silo costs the same 1M that the interceptor needs;
      // measured on ofh-n-b1 it consumed the chest at tick 4919 and the SAM
      // only became ready 602 ticks after the first hostile strike.
      return type === UNIT.MissileSilo || type === UNIT.Warship;
    }

    hostileMissileSiloCapacitySummary() {
      const snapshotTick = this.hostileSiloSamCurrentTick();
      if (
        snapshotTick !== null &&
        this._hostileSiloCapacitySnapshotTick === snapshotTick &&
        this._hostileSiloCapacitySnapshot !== null
      ) {
        return this._hostileSiloCapacitySnapshot;
      }

      const hostile = this.liveNuclearHostilePlayers();
      if (hostile === null) return null;

      let hostileSiloCount = 0;
      let hostileSiloCapacity = 0;
      let builtHostileSiloCount = 0;
      for (const other of hostile) {
        const metrics = this.playerUnitCapacitySummary(
          other,
          UNIT.MissileSilo,
        );
