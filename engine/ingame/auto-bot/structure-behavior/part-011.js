        borderPlayers.map((opponent) => [
          this.readPlayerSmallId(opponent),
          opponent,
        ]),
      );
      for (const attack of activeStrategicLandAttacks) {
        const attacker = attack.attacker?.();
        const sid = this.readPlayerSmallId(attacker);
        if (sid !== null && sid !== undefined) leadFrontPlayers.set(sid, attacker);
      }
      if (leadFrontPlayers.size === 0) return null;
      if (trace) {
        numbers.borderCandidates = borderPlayers
          .map((opponent) => ({
            sid: this.readPlayerSmallId(opponent),
            type: String(opponent.type?.() ?? "unknown"),
            tiles: Number(opponent.numTilesOwned?.() || 0),
            troops: Number(opponent.troops?.() || 0),
          }))
          .slice(0, 12);
      }
      const frontTiles = new Set(
        this.getLeadGuardBorderFrontTiles(new Set(leadFrontPlayers.keys())),
      );
      for (const attack of activeStrategicLandAttacks) {
        for (const tile of this.getAttackFrontTiles([attack])) frontTiles.add(tile);
      }
      return { leadFrontPlayers, frontTiles: [...frontTiles] };
    }

    buildLeadGuardDefensePostThreat(front, numbers, trace, reportGate) {
      const strongest = [...front.leadFrontPlayers.entries()].reduce(
        (best, [opponentSid, opponent]) => {
          const troops = Math.max(0, Number(opponent?.troops?.() || 0));
          return best === null || troops > best.troops
            ? { opponentSid, troops }
            : best;
        },
        null,
      );
      if (strongest === null) return reportGate("no_border_opponent");
      numbers.strongestTroops = strongest.troops;
      numbers.frontCount = front.frontTiles.length;
      if (front.frontTiles.length === 0) return reportGate("no_front");
      if (
        (this.player?.units?.(UNIT.DefensePost)?.length ?? 0) >=
        PREEMPTIVE_DEFENSE_POST_MAX_POSTS
      ) {
        return reportGate("post_cap");
      }
      const allowed = this.frontScaledPreemptiveDefensePostBudget(front.frontTiles);
      numbers.allowed = allowed;
      numbers.postsNearFront = this.countDefensePostsNearFront(
        front.frontTiles,
        allowed,
      );
      if (numbers.postsNearFront >= allowed) return reportGate("coverage_ok");
      if (trace) {
        this._leadGuardTraceState = {
          gate: "armed",
          tick: safeStructureGameTick(this.game),
          ...numbers,
        };
      }
      return {
        allowed,
        frontTiles: front.frontTiles,
        incomingTroops: 0,
        landAttacks: [],
        ratio:
          strongest.troops /
          Math.max(1, Number(this.player?.troops?.() || 0)),
        leadGuard: true,
      };
    }

    hasBuiltCityForPreemptiveDefense() {
      return (this.player?.units?.(UNIT.City) || []).some(
        (city) => city.isUnderConstruction?.() !== true,
      );
    }

    // True when the treasury can fund a quiet-border Defense Post AND still
    // cover the cheapest next economic structure (City/Port/Factory). Keeps
    // preemptive Posts from eating the economy ladder's rung.
    legendaryQuietPostGoldAboveEconomyRung() {
      const gold = legendaryBigInt(this.player?.gold?.() || 0n);
      const postCost = legendaryBigInt(this.getConstructionCost(UNIT.DefensePost));
      let economyCost = this.getConstructionCost(UNIT.City);
      for (const type of [UNIT.Port, UNIT.Factory]) {
        if (autoBotBuildAllowed(type)) {
          const typeCost = legendaryBigInt(this.getConstructionCost(type));
          if (typeCost < economyCost) economyCost = typeCost;
        }
      }
      return gold >= postCost + economyCost;
    }

    strongestQuietStrategicBorderOpponent() {
      const opponents = this.liveHostilePlayers();
      if (!Array.isArray(opponents)) return null;
      const borderingOwnerIds = this.borderingLandOwnerIds();
      if (
        borderingOwnerIds === null &&
        typeof this.player?.sharesBorderWith !== "function"
      ) {
        return null;
      }
      return this.strongestStrategicBorderOpponent(
        opponents,
        borderingOwnerIds,
      );
    }

    // The leader's exposed perimeter can be separated from Nation rivals by
    // a belt of tribes; protect every hostile-owned land edge so posts also
    // cover the tile route the eventual attack must cross.
    getLeadGuardBorderFrontTiles(hostileOwnerIds) {
      if (
        typeof this.player?.borderTiles !== "function" ||
        typeof this.game?.neighbors !== "function" ||
        typeof this.game?.hasOwner !== "function" ||
        typeof this.game?.ownerID !== "function"
      ) {
        return [];
      }
      const frontTiles = [];
      outer: for (const borderTile of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(borderTile)) {
          if (typeof this.game.isLand === "function" && !this.game.isLand(neighbor)) {
            continue;
          }
          if (
            this.game.hasOwner(neighbor) &&
            hostileOwnerIds.has(this.game.ownerID(neighbor))
          ) {
            frontTiles.push(borderTile);
            continue outer;
          }
        }
      }
      return frontTiles;
    }

    strongestStrategicBorderOpponent(opponents, borderingOwnerIds) {
      let strongest = null;
      for (const opponent of opponents) {
        if (!this.isStrategicBorderOpponent(opponent)) continue;
        const opponentSid = this.readPlayerSmallId(opponent);
        if (opponentSid === null || opponentSid === undefined) continue;
        const bordersUs =
          borderingOwnerIds !== null
            ? borderingOwnerIds.has(opponentSid)
            : this.safeSharesBorder(opponent);
        if (!bordersUs) continue;
        const troops = Math.max(0, Number(opponent?.troops?.() || 0));
        if (strongest === null || troops > strongest.troops) {
          strongest = { opponentSid, troops };
        }
      }
