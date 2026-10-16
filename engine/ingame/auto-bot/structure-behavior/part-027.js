      // This is the budget available to ordinary construction and defensive
      // planning. A MIRV reserve is applied only by the offensive silo paths.
      return availableGold;
    }

    shouldReserveHostileSiloSamBudget() {
      // Once any Silo is visible, the first SAM is the only construction goal.
      // Preserve the opening escape hatch: without a completed income site,
      // saving from zero can never fund the launcher. With any City, Factory,
      // or Port established, do not spend even a small partial SAM fund on an
      // unrelated structure while an external nuclear threat exists.
      // AFFORDABILITY ESCAPE (2026-08-24): the reserve exists to save PARTIAL
      // funds toward the next defense action. Once the treasury already
      // covers the launcher several times over, holding the slot only
      // freezes the economy — measured FFA mode-A: 18M gold hoarded, zero
      // builds for 2000+ ticks while the endgame giant grew (the reserve is
      // otherwise unconditional, and a failed SAM placement + no available
      // upgrade returns the hold every single tick).
      if (this.game && typeof this.game.config === "function") {
        const gold = legendaryBigInt(this.player?.gold?.() || 0n);
        const samCost = this.safeConstructionCost(UNIT.SAMLauncher);
        if (samCost !== null && gold > samCost * 3n) return false;
      }
      return ECONOMIC_STRUCTURE_TYPES.some((type) => this.ownedLevels(type) > 0);
    }

    firstSamConstructionReserve(type) {
      // Ports are exempt, as with the war chest below: on water maps they ARE
      // the economy that funds the interceptor, and gating Port construction
      // behind the 1.5M reserve during the first-SAM window starved the trade
      // economy exactly while a hostile silo existed (measured team-basket
      // win -> loss regression, 2026-09-11).
      if (type === UNIT.Port) return 0n;
      if (!ECONOMIC_STRUCTURE_TYPES.includes(type) && type !== UNIT.MissileSilo) return 0n;
      const reserve = this.singleSamHostileSiloReplacementReserve();
      if (reserve <= 0n || this.ownedSamUnits().length > 0) return 0n;
      return this.shouldReserveHostileSiloSamBudget() ? reserve : 0n;
    }

    debugStructureLaneCount(lane) {
      const tel = this.nukeBehavior?.decisionTelemetry;
      if (tel) tel[lane] = (tel[lane] ?? 0) + 1;
    }

    firstSiloConstructionReserve(
      type,
      includeSam = false,
      missileDefenseUrgent = null,
    ) {
      if (
        type !== UNIT.DefensePost &&
        !(includeSam && type === UNIT.SAMLauncher)
      ) {
        return 0n;
      }
      if (!state.settings.winFixes) return 0n;
      if (
        !isLegendaryDifficulty(currentDifficulty()) &&
        !this.hasBuiltHostileSiloThreat()
      ) {
        return 0n;
      }
      if (
        type === UNIT.SAMLauncher &&
        ((this.player?.units?.(UNIT.SAMLauncher) || []).length === 0 ||
          (missileDefenseUrgent ?? this.legendaryMissileDefenseUrgent()))
      ) {
        return 0n;
      }
      if (this.ownedLevels(UNIT.MissileSilo) > 0) return 0n;
      const silos = this.player.units(UNIT.MissileSilo) || [];
      if (silos.some((silo) => silo.isUnderConstruction?.())) return 0n;
      // No deferral exemption: while the naval opening funds Port/Warship,
      // Defense Posts are exactly the spend that starved the opening
      // (Baikal 2026-10-10: three DPs consumed the Port's gold window).
      const cost = this.safeConstructionCost(UNIT.MissileSilo);
      return cost === null ? 0n : cost;
    }

    availableGoldAfterReserve(type, { includeSam = false } = {}) {
      let availableGold = this.spendableConstructionGold();

      // Plateau/opening callers bypass the ordinary defense phase. Keep the
      // first interceptor funded at their shared budget boundary as well.
      const firstSamReserve = this.firstSamConstructionReserve(type);
      availableGold = availableGold > firstSamReserve ? availableGold - firstSamReserve : 0n;

      // While the first Silo is missing, Defense Posts and nonurgent follow-up
      // SAM spending preserve its cost; urgent SAM responses stay exempt.
      const firstSiloReserve = this.firstSiloConstructionReserve(
        type,
        includeSam,
      );
      availableGold = availableGold > firstSiloReserve ? availableGold - firstSiloReserve : 0n;

      // The first-Atom war chest claims economic gold ahead of ordinary
      // growth once a Silo is live (the nuke lane decides after structures
      // in the same tick, so an unreserved surplus would always be spent
      // first). Defensive builds keep the full budget, and Ports are exempt
      // too: on water maps they ARE the nuclear economy's fuel — trade
      // arrivals and captured vessels fund the bombardment, so starving
      // port growth to save 750k slower is strictly counterproductive.
      if (type === UNIT.Port) return availableGold;
      if (ECONOMIC_STRUCTURE_TYPES.includes(type)) {
        const warChest = this.legendaryAtomWarChest();
        if (warChest > 0n && availableGold > warChest) {
          availableGold -= warChest;
        } else if (warChest > 0n) {
          return 0n;
        }
      }

      if (type !== UNIT.MissileSilo) return availableGold;

      // The nuclear reserve cannot be used until a silo exists. Applying it to
      // the first silo creates a circular dependency: the planner saves for a
      // weapon it has no launcher for and treats the launcher as unaffordable.
      // Once any silo is built, preserve the reserve for subsequent offensive
      // silo construction and upgrades as before.
      if (this.ownedLevels(UNIT.MissileSilo) === 0) return availableGold;

      let reserve;
      {
        reserve = this.legendaryReserveGold();
      }
      return availableGold > reserve ? availableGold - reserve : 0n;
    }

    /**
     * Productive structures use their real next-build price under win-fixes.
     * The old MIRV save-up multiplier made a City increasingly unaffordable
     * while the bot was still trying to grow, even though the same gold was
     * enough to build it. Offensive structures retain the perceived-cost guard.
     */
    getConstructionCost(type) {
      if (
        state.settings.winFixes &&
        ECONOMIC_STRUCTURE_TYPES.includes(type)
      ) {
        return this.cost(type);
      }
      return this.getPerceivedCost(type);
    }

    economicStructurePortfolio() {
      const portfolio = new Map();
      for (const type of ECONOMIC_STRUCTURE_TYPES) {
        portfolio.set(type, this.player.units(type) || []);
      }
      return portfolio;
    }

    economicStructureLevelTotal(units) {
      let total = 0;
      for (const unit of units) {
        total += this.unitUnderConstruction(unit) ? 1 : unit.level();
      }
      return total;
    }

