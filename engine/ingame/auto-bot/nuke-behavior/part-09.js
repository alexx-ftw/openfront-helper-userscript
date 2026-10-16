
    isCounterforceSiloTarget(tile, nukeType, targetPlayer) {
      const ownerId = targetPlayer?.smallID?.();
      if (!this._hostileNukeThreats?.has(ownerId)) return false;
      const silos = targetPlayer.units?.(UNIT.MissileSilo) ?? [];
      const sourceSiloIds = this._hostileNukeThreats.get(ownerId)?.sourceSiloIds;
      const liveLaunchSilos = sourceSiloIds?.size
        ? silos.filter(
            (silo) =>
              sourceSiloIds.has(String(silo?.id?.() ?? "")) &&
              silo?.isActive?.() !== false,
          )
        : [];
      const counterforceSilos = sourceSiloIds?.size ? liveLaunchSilos : silos;
      const radius = Number(this.game.config().nukeMagnitudes(nukeType).outer);
      if (!Number.isFinite(radius) || typeof this.game.euclideanDistSquared !== "function") {
        return false;
      }
      const withinBlast = euclDistFN(tile, radius, false);
      return counterforceSilos.some(
        (silo) =>
          silo?.isActive?.() !== false &&
          withinBlast(this.game, silo.tile()),
      );
    }

    hasLiveCounterforceNukeSource() {
      const players = this.game?.players?.() ?? [];
      for (const [ownerId, threat] of this._hostileNukeThreats ?? []) {
        const sourceSiloIds = threat?.sourceSiloIds;
        if (!sourceSiloIds?.size) return true;
        const owner = players.find(
          (player) => String(player?.smallID?.()) === String(ownerId),
        );
        if (
          (owner?.units?.(UNIT.MissileSilo) ?? []).some(
            (silo) =>
              sourceSiloIds.has(String(silo?.id?.() ?? "")) &&
              silo?.isActive?.() !== false,
          )
        ) {
          return true;
        }
      }
      return false;
    }

    // DIVERGENCE (winFixes, Legendary): preserve one live Atom cost after an
    // observed hostile nuke until its owner's silo can be counterstruck.
    async shouldHoldCounterforceNuke(tile, nukeType, targetPlayer, launchCost) {
      if (
        state.settings.winFixes !== true ||
        !isLegendaryDifficulty(currentDifficulty()) ||
        typeof this._hostileNukeThreats?.has !== "function" ||
        this._hostileNukeThreats.size === 0 ||
        this.isUnderHeavyAttack() ||
        this.isRetaliationNukeTarget(targetPlayer)
      ) {
        return false;
      }
      if (!this.hasLiveCounterforceNukeSource()) return false;
      if (this.isCounterforceSiloTarget(tile, nukeType, targetPlayer)) return false;
      const atomCost = await this.getPerceivedNukeCost(UNIT.AtomBomb);
      if (typeof atomCost !== "bigint" || atomCost <= 0n) return false;
      const cost = typeof launchCost === "bigint" ? launchCost : BigInt(launchCost);
      return this.player.gold() < cost + atomCost;
    }

    findStrategicBorderArmyTarget() {
      const tick = Number(this.game?.ticks?.());
      if (
        Number.isFinite(tick) &&
        this._strategicBorderArmyTargetTick === tick
      ) {
        return this._strategicBorderArmyTarget;
      }

      const target = this.resolveStrategicBorderArmyTarget();

      if (Number.isFinite(tick)) {
        this._strategicBorderArmyTargetTick = tick;
        this._strategicBorderArmyTarget = target;
      }
      return target;
    }

    findLegendaryStructureTarget() {
      let best = null;
      let bestScore = 0;
      for (const other of this.game.players()) {
        if (other.smallID() === this.player.smallID()) continue;
        if (other.isAlive?.() === false) continue;
        if (playersArePermanentTeammates(this.player, other)) continue;
        if (this.attackBehavior.shouldAttack(other) === false) continue;
        const structures = unitsOfTypes(other);
        const replacementValue = structures.reduce(
          (total, structure) => total + this.nukeStructureValue(structure),
          0,
        );
        const density = replacementValue / Math.max(1, other.numTilesOwned?.() || 1);
        if (replacementValue > 0 && density > bestScore) {
          best = other;
          bestScore = density;
        }
      }
      return best;
    }

    // ── isRichestNation — NationNukeBehavior.ts:262 ───────────────────────────
    isRichestNation() {
      const myGold = this.player.gold();
      for (const other of this.game.players()) {
        if (other.smallID() === this.player.smallID()) continue;
        if (other.type() !== PlayerType.Nation) continue;
        if (other.gold() > myGold) return false;
      }
      return true;
    }

    // ── findHighDensityTarget — NationNukeBehavior.ts:272 ─────────────────────
    findHighDensityTarget() {
      let bestTarget = null;
      let bestDensity = HIGH_DENSITY_NUKE_THRESHOLD;
      for (const other of this.game.players()) {
        if (other.smallID() === this.player.smallID()) continue;
        if (other.type() === PlayerType.Bot) continue;
        if (playersArePermanentTeammates(this.player, other)) continue;
        const tilesOwned = other.numTilesOwned();
        if (tilesOwned === 0) continue;
        const structures = unitsOfTypes(other);
        let levelSum = 0;
        for (const s of structures) levelSum += s.level();
        // Skip players with too few structures regardless of density
        if (levelSum < MIN_LEVEL_SUM_FOR_HIGH_DENSITY_NUKE) continue;
        const density = levelSum / tilesOwned;
        if (density > bestDensity) {
          bestDensity = density;
          bestTarget = other;
        }
      }
      return bestTarget;
    }

    // ── findFFACrownTarget — NationNukeBehavior.ts:295 ────────────────────────
    findFFACrownTarget() {
      const difficulty = currentDifficulty();
      const gameMode = this.game.config().gameConfig().gameMode;
      if (gameMode !== GameMode.FFA) {
        return null;
      }

      if (this.game.players().length <= 1) {
        return null;
      }

      const sortedByTiles = this.game
        .players()
        .slice()
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
      const firstPlace = sortedByTiles[0];

      // If we're the crown on Impossible/Legendary difficulty, target 2nd place
      if (
        isAtLeastHardDifficulty(difficulty) &&
        firstPlace.smallID() === this.player.smallID() &&
        sortedByTiles.length >= 2
      ) {
        const secondPlace = sortedByTiles[1];
        if (!playersArePermanentTeammates(this.player, secondPlace)) {
          return secondPlace;
        }
      }

      // Don't target ourselves or allies
      if (
        firstPlace.smallID() === this.player.smallID() ||
        playersArePermanentTeammates(this.player, firstPlace)
      ) {
        return null;
      }
