      const rawTick = safeStructureGameTick(this.game);
      const snapshotTick = Number.isFinite(rawTick) ? rawTick : null;

      if (
        snapshotTick !== null &&
        this._troopCapPressureTick === snapshotTick &&
        typeof this._troopCapPressure === "boolean"
      ) {
        return this._troopCapPressure;
      }

      const pressure = this.computeTroopCapPressure();

      if (snapshotTick !== null) {
        this._troopCapPressureTick = snapshotTick;
        this._troopCapPressure = pressure;
      }
      return pressure;
    }

    computeTroopCapPressure(includeThinDensity = true) {
      if (!state.settings.winFixes) return false;
      const config = this.game?.config?.();
      if (!config || typeof config.maxTroops !== "function") return false;
      const maxTroops = this.safeMaxTroops(config, this.player);
      if (maxTroops <= 0) return false;
      if (typeof this.player?.troops !== "function") return false;
      const troops = Number(this.player.troops());
      if (!Number.isFinite(troops) || troops <= 0) return false;
      if (troops >= maxTroops * TROOP_CAP_PRESSURE_RATIO) return true;
      return includeThinDensity && this.legendaryThinDensityPressure(troops);
    }

    // Density floor: territory growing faster than the army is the paper
    // tiger that dies to one concentrated wave (Baikal FFA held 163k tiles
    // at ~18 troops per tile, then lost 130k of them to a 478k wave). When
    // troops per tile fall below the defensive floor, City spending must
    // resume even far from the troop cap, because each City adds a quarter
    // million to the ceiling production refills toward.
    legendaryThinDensityPressure(troops) {
      if (!isLegendaryDifficulty()) return false;
      const tiles = Math.max(
        1,
        Number(this.player?.numTilesOwned?.()) || 0,
      );
      if (tiles < LEGENDARY_DENSITY_FLOOR_MIN_TILES) return false;
      return troops / tiles < LEGENDARY_DENSITY_FLOOR_TROOPS_PER_TILE;
    }

    hasBorderingHostileMaxTroopAdvantage() {
      const rawTick = safeStructureGameTick(this.game);
      const snapshotTick = Number.isFinite(rawTick) ? rawTick : null;

      if (
        snapshotTick !== null &&
        this._borderingHostileMaxTroopAdvantageTick === snapshotTick &&
        typeof this._borderingHostileMaxTroopAdvantage === "boolean"
      ) {
        return this._borderingHostileMaxTroopAdvantage;
      }

      const hasAdvantage = this.computeBorderingHostileTroopAdvantage();

      if (snapshotTick !== null) {
        this._borderingHostileMaxTroopAdvantageTick = snapshotTick;
        this._borderingHostileMaxTroopAdvantage = hasAdvantage;
      }
      return hasAdvantage;
    }

    computeBorderingHostileTroopAdvantage() {
      let config;
      {
        config = this.game.config();
      }
      if (!config || typeof config.maxTroops !== "function") return false;
      const ownMaxTroops = this.safeMaxTroops(config, this.player);
      if (ownMaxTroops <= 0) return false;
      const hostilePlayers = this.liveHostilePlayers();
      if (!Array.isArray(hostilePlayers)) return false;
      const borderingOwnerIds = this.borderingLandOwnerIds();
      if (borderingOwnerIds !== null) {
        return hostilePlayers.some(
          (enemy) =>
            borderingOwnerIds.has(enemy.smallID()) &&
            this.safeMaxTroops(config, enemy) > ownMaxTroops,
        );
      }
      if (typeof this.player?.sharesBorderWith !== "function") return false;
      return hostilePlayers.some(
        (enemy) =>
          this.safeSharesBorder(enemy) &&
          this.safeMaxTroops(config, enemy) > ownMaxTroops,
      );
    }

    borderingLandOwnerIds() {
      if (typeof this.player?.borderTiles !== "function") return null;
      if (typeof this.game?.neighbors !== "function") return null;
      if (typeof this.game?.isLand !== "function") return null;
      if (typeof this.game?.ownerID !== "function") return null;

      const ownSid = this.player.smallID();
      const ownerIds = new Set();
      for (const borderTile of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(borderTile)) {
          if (!this.game.isLand(neighbor)) continue;
          const ownerSid = this.game.ownerID(neighbor);
          if (ownerSid == null || ownerSid === ownSid) continue;
          ownerIds.add(ownerSid);
        }
      }
      return ownerIds;
    }

    safeMaxTroops(config, player) {
      {
        const troops = Number(config.maxTroops(player));
        return Number.isFinite(troops) ? troops : 0;
      }
    }

    safeSharesBorder(enemy) {
      {
        return this.player.sharesBorderWith(enemy) === true;
      }
    }

    legendaryFriendlyPlayers() {
      const mySid = this.player.smallID();
      const friendly = [];
      {
        for (const other of this.game.players()) {
          if (
            !other ||
            (typeof other.isPlayer === "function" && !other.isPlayer()) ||
            other.smallID() === mySid
          ) {
            continue;
          }
          const isFriendly =
            this.player.isFriendly(other) || this.player.isOnSameTeam(other);
          if (isFriendly && other.isAlive() !== false) friendly.push(other);
        }
      }
      return friendly;
    }

    legendaryProductionMetrics(player) {
      const troops = Math.max(0, Number(player.troops() || 0));
      const gold = BigInt(player.gold() || 0n);
      let goldProduction = 0;
      const tiles = [];
      const samUnits = [];
      {
        for (const unit of player.units(UNIT.City, UNIT.Factory, UNIT.Port)) {
          const metrics = this.legendaryProductiveUnitMetrics(unit);
          if (metrics.tile !== null) tiles.push(metrics.tile);
          goldProduction += metrics.goldProduction;
        }
