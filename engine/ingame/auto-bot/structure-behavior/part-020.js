        config,
        citiesDisabled,
        cityCount,
        hasCoastalTiles,
        hasOceanPortTiles,
        missileSilosEnabled,
        nukesEnabled,
      });
      return this.runLegendaryConstructionGroups(
        cityCount,
        leadGuardShortfall
          ? candidates.filter((candidate) => candidate.type !== UNIT.MissileSilo)
          : candidates,
        economyGrowthPriority,
        !leadGuardShortfall,
      );
    }

    // Ranked-group execution: the economic group first when economy growth
    // has priority, and the first built/wait result ends the decision. With
    // the construction dump enabled (OFH_CONSTRUCTION_DUMP), the decision
    // appends one inert sample — see recordConstructionPlannerSample.
    async runLegendaryConstructionGroups(
      cityCount,
      candidates,
      economyGrowthPriority,
      allowSiloSurplusUpgrade = true,
    ) {
      // The headless structure-trace wrapper is async; await also accepts the
      // synchronous production array without changing its ranking or order.
      const actionGroups = await this.legendaryConstructionActionGroups(
        candidates,
        economyGrowthPriority,
      );
      const dumpSample = Array.isArray(state.stats?.constructionDump)
        ? { cityCount, actionGroups }
        : null;
      let plannerOutcome = "none";
      for (let groupIndex = 0; groupIndex < actionGroups.length; groupIndex++) {
        const result = await this.legendaryConstructionActionGroupResult(
          actionGroups[groupIndex],
          actionGroups,
          groupIndex,
        );
        if (result !== "skip") plannerOutcome = result;
        if (result === "built" || result === "wait") break;
      }
      if (dumpSample !== null) {
        this.recordConstructionPlannerSample(dumpSample, plannerOutcome);
      }
      if (plannerOutcome === "none" && allowSiloSurplusUpgrade) {
        return this.maybeUpgradeSiloFromSurplus();
      }
      return plannerOutcome === "built";
    }

    // Inert construction-planner dump (OFH_CONSTRUCTION_DUMP=1). When the
    // headless harness pre-creates state.stats.constructionDump, every
    // Legendary structure decision appends one bounded record — gold, owned
    // port levels, the top ranked candidates per action group, and the group
    // outcome — so income levers can be designed from what the ladder actually
    // saw instead of from theory. No decision path reads this data, and the
    // array is a ring buffer capped at 800 records.
    recordConstructionPlannerSample({ cityCount, actionGroups }, outcome) {
      const dump = state.stats.constructionDump;
      if (!Array.isArray(dump)) return;
      dump.push({
        tick: this.game.ticks(),
        gold: String(this.player.gold() ?? 0n),
        cityCount,
        ownedPorts: this.ownedLevels(UNIT.Port),
        leadGuard: this._leadGuardTraceState ?? null,
        groups: actionGroups.map((group) =>
          group.slice(0, 4).map((candidate) => ({
            type: candidate.type ?? candidate.action ?? "unknown",
            cost: String(candidate.cost ?? 0n),
            affordable: candidate.affordable !== false && candidate.action !== "wait",
          })),
        ),
        outcome,
      });
      if (dump.length > 800) dump.shift();
    }

    // Arm-on-freeze strike silo (FFA-only survival lane; re-lands the parked
    // 2026-08-25 round): the nuke-side survival strike is reach-capped by
    // silo availability — measured freezes hoarded abundant gold with no
    // operational launcher because the ordinary ladder defers offensive
    // silos behind economy/defense gates. During the exact freeze signature
    // the strike lane keys on, buy the FIRST silo outright once gold covers
    // 2 launchers + 1 bomb (the abundance proof). Team games exit at the
    // gameMode read before any ownership or cost probing.
    async maybeArmFreezeStrikeSilo() {
      if (!this.freezeStrikeArmWindow()) return false;
      if (!this.freezeStrikeOutmuscleWindow()) return false;
      if (!this.freezeStrikeArmAffordable()) return false;
      return this.maybeSpawnStructure(UNIT.MissileSilo, {
        ignoreEconomicReserve: true,
      });
    }

    // Cheap gates first: winFixes, mode, difficulty, unit availability, and
    // launcher absence. Team games exit at the gameMode read before any
    // ownership or cost probing.
    freezeStrikeArmWindow() {
      if (state.settings.winFixes !== true) return false;
      if (!this.game || typeof this.game.config !== "function") return false;
      const config = this.game.config();
      const gameMode = String(config?.gameConfig?.()?.gameMode ?? "");
      if (gameMode !== "Free For All" && gameMode !== "FFA") return false;
      if (!isLegendaryDifficulty()) return false;
      if (config.isUnitDisabled(UNIT.MissileSilo)) return false;
      return this.ownedLevels(UNIT.MissileSilo) === 0;
    }

    // Nuke-side survival signature (NukeBehavior.freezeGiantStrikeTarget):
    // endgame scale, troops pinned at the cap, and a hostile giant at 1.5x.
    freezeStrikeOutmuscleWindow() {
      const tiles = this.player.numTilesOwned();
      if (tiles < 50_000) return false;
      const ourTroops = this.player.troops();
      const ourMax = this.player.maxTroops();
      if (ourMax <= 0 || ourTroops < ourMax * 0.85) return false;
      let giantTroops = 0;
      for (const other of this.game.players()) {
        if (!other.isPlayer() || other.isAlive() === false) continue;
        if (this.player.isFriendly(other) === true) continue;
        giantTroops = Math.max(giantTroops, other.troops());
      }
      return giantTroops >= ourTroops * 1.5;
    }

    // The abundance proof: 2 launchers + 1 bomb. Below it the lane must not
    // divert the treasury the ordinary ladder is spending.
    freezeStrikeArmAffordable() {
      const siloCost = this.safeConstructionCost(UNIT.MissileSilo);
      const bombCost = this.safeConstructionCost(UNIT.AtomBomb);
      if (siloCost === null || bombCost === null) return false;
      return this.spendableConstructionGold() >= siloCost * 2n + bombCost;
    }

    async legendaryConstructionActionGroupResult(
      actions,
      actionGroups,
      groupIndex,
    ) {
      for (const candidate of actions) {
        if (candidate.action === "wait") {
          return this.legendaryWaitYieldsToSafetyAction(
            actionGroups,
            groupIndex,
          )
            ? "skip"
            : "wait";
        }
        // A cap-relief City upgrade uses its own authoritative actuation probe;
        // its failure falls through to the next ranked action (e.g. a new
        // City) instead of aborting the whole group.
        if (candidate.action === "upgrade") {
          const upgraded = candidate.type === UNIT.City
