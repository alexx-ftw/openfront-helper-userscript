
      const numTilesWithoutFallout =
        this.game.numLandTiles() - this.game.numTilesWithFallout();
      if (numTilesWithoutFallout <= 0) {
        return null;
      }

      const firstPlaceShare =
        firstPlace.numTilesOwned() / numTilesWithoutFallout;
      const myShare = this.player.numTilesOwned() / numTilesWithoutFallout;

      // Check if first place has threshold% more tile-percentage of the map than us
      if (firstPlaceShare - myShare > this.getCrownLeadThreshold(difficulty)) {
        return firstPlace;
      }

      return null;
    }

    // ── findStrongestTeamTarget — NationNukeBehavior.ts:363 ───────────────────
    findStrongestTeamTarget() {
      if (this.game.config().gameConfig().gameMode !== GameMode.Team) {
        return null;
      }

      if (this.game.players().length <= 1) {
        return null;
      }

      const teamTiles = new Map();
      const teamPlayers = new Map();

      for (const p of this.game.players()) {
        const team = p.team();
        if (team === null) continue;

        teamTiles.set(team, (teamTiles.get(team) ?? 0) + p.numTilesOwned());
        let players = teamPlayers.get(team);
        if (!players) {
          players = [];
          teamPlayers.set(team, players);
        }
        players.push(p);
      }

      const sortedTeams = Array.from(teamTiles.entries()).sort(
        (a, b) => b[1] - a[1],
      );

      if (sortedTeams.length === 0) {
        return null;
      }

      let strongestTeam = sortedTeams[0][0];
      // team is a team id (string), not a player — keep the `===` compare.
      if (strongestTeam === this.player.team()) {
        if (sortedTeams.length > 1) {
          strongestTeam = sortedTeams[1][0];
        } else {
          return null;
        }
      }

      const targetTeamPlayers = teamPlayers.get(strongestTeam);

      // Filter out friendly players
      const validTargets = targetTeamPlayers.filter(
        (p) => !playersArePermanentTeammates(this.player, p),
      );

      if (validTargets.length === 0) {
        return null;
      }

      if (this.random.chance(2)) {
        // Strongest player
        return validTargets.reduce((prev, current) =>
          this.game.config().maxTroops(prev) >
          this.game.config().maxTroops(current)
            ? prev
            : current,
        );
      } else {
        // Random player
        return this.random.randElement(validTargets);
      }
    }

    // ── getPerceivedNukeCost — NationNukeBehavior.ts:431 (now async; cost() is a
    //    buildables probe). Simulate saving up for a MIRV. ─────────────────────
    async getPerceivedNukeCost(type) {
      // If only 2 players left, use actual cost (no point saving for MIRV)
      if (this.game.players().length === 2) {
        return await this.cost(type);
      }

      // If MIRVs are disabled, return the actual cost
      if (this.game.config().isUnitDisabled(UNIT.MIRV)) {
        return await this.cost(type);
      }

      // Save up a limited amount in team games, synced with NationStructureBehavior
      // Saving up for a MIRV is not relevant
      if (
        this.game.config().gameConfig().gameMode === GameMode.Team &&
        this.player.gold() > (await this.cost(UNIT.HydrogenBomb))
      ) {
        return await this.cost(type);
      }

      // Return the actual cost if we already have enough gold to buy both a MIRV and a hydro
      if (
        this.player.gold() >
        (await this.cost(UNIT.MIRV)) + (await this.cost(UNIT.HydrogenBomb))
      ) {
        return await this.cost(type);
      }

      // On Hard, Impossible, and Legendary, ignore perceived cost when under heavy attack
      // The nation is probably going to get destroyed soon, so go all-in on nukes
      const difficulty = currentDifficulty();
      if (
        isAtLeastHardDifficulty(difficulty) &&
        this.isUnderHeavyAttack()
      ) {
        return await this.cost(type);
      }

      // Legendary divergence: the perceived-cost escalation models "save up
      // for a MIRV" and prices a sustained bombardment out of its own war
      // chest (750k real price escalates past 3.8M after four launches while
      // the treasury peaks near 2.6M — measured on Baikal). The adaptive
      // tier funds repeat strikes from the recurring chest, so affordability
      // tracks the real price and the MIRV discipline stays with the
      // faithful tiers.
      if (
        state.settings.winFixes === true &&
        isLegendaryDifficulty(difficulty)
      ) {
        return await this.cost(type);
      }

      // DIVERGENCE C1: src seeds atom/hydrogenBombPerceivedCost from cost(type) in
      // field initializers. We seed lazily here on first use (from the live cost),
      // then escalate per launch (in sendNuke). Until seeded, fall back to the live
      // cost — identical to src's initial value (cost(type) before any launch).
      if (type === UNIT.AtomBomb) {
        if (this.atomBombPerceivedCost === null) {
          this.atomBombPerceivedCost = await this.cost(UNIT.AtomBomb);
        }
        return this.atomBombPerceivedCost;
      } else {
        if (this.hydrogenBombPerceivedCost === null) {
          this.hydrogenBombPerceivedCost = await this.cost(UNIT.HydrogenBomb);
        }
        return this.hydrogenBombPerceivedCost;
      }
    }

    // ── isUnderHeavyAttack — NationNukeBehavior.ts:477 ────────────────────────
    isUnderHeavyAttack() {
      // Only live pressure justifies bypassing the normal nuke economy. The
      // client can briefly retain a cancelled wave in incomingAttacks(), and
      // different adapters expose `retreating` as either an accessor or a
      // plain boolean. Counting that stale force makes the bot go all-in on
      // nukes after the danger has already ended.
      const incomingAttacks = this.player.incomingAttacks();
      let totalIncomingTroops = 0;
      for (const attack of incomingAttacks) {
        const retreating =
          typeof attack?.retreating === "function"
            ? attack.retreating()
            : attack?.retreating;
        if (retreating === true) continue;
        totalIncomingTroops += attack.troops();
      }

      const myTroops = this.player.troops();

      return totalIncomingTroops >= myTroops;
    }
