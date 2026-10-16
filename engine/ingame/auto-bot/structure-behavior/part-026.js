      if (last && tick - last.tick < 100) return;

      // DIVERGENCE (winFixes): match each hostile's treasury to its own
      // launcher count so unrelated FFA players cannot form a fictitious
      // imminent nuclear threat.
      const players = this.hostileNuclearThreatPlayers();
      samples.push({
        tick,
        players,
      });
      if (samples.length > 3) samples.shift();
    }

    hostileNukePathEta(latest, incomePerTick, nukeCost) {
      if (incomePerTick <= 0) {
        return latest.gold >= nukeCost ? 0 : Number.POSITIVE_INFINITY;
      }
      return Math.max(0, (nukeCost - latest.gold) / incomePerTick);
    }

    hostileNuclearThreatEtaTicks() {
      this.hostileNuclearThreatSample();
      const samples = state.hostileEconSamples || [];
      if (samples.length < 2) return null;
      const latest = samples[samples.length - 1];
      const prior = samples[samples.length - 2];
      if (!Array.isArray(latest.players) || !Array.isArray(prior.players)) return null;
      const dTick = Math.max(1, latest.tick - prior.tick);
      // Nuclear paths: a nuke from an EXISTING silo (~750k), or a new silo
      // (~1M + 300 construction) then a nuke. Preserve the existing count
      // proxy and level factor, but apply them only to that same owner's gold.
      const previousById = new Map(prior.players.map((player) => [player.id, player]));
      let earliestEta = Number.POSITIVE_INFINITY;
      let hasComparablePlayer = false;
      for (const player of latest.players) {
        const previous = previousById.get(player.id);
        if (!previous) continue;
        hasComparablePlayer = true;
        const incomePerTick = Math.max(0, player.gold - previous.gold) / dTick;
        const siloCount = Math.max(0, Number(player.siloCount) || 0);
        const etaExisting = this.hostileNukePathEta(player, incomePerTick, 750_000);
        const etaNewSilo =
          this.hostileNukePathEta(player, incomePerTick, 1_750_000) + 300;
        const levelFactor = 1 / (1 + siloCount * 0.25);
        const eta = siloCount > 0
          ? etaExisting * levelFactor
          : etaNewSilo;
        earliestEta = Math.min(earliestEta, eta);
      }
      return hasComparablePlayer ? earliestEta : null;
    }

    ownSamReadinessEtaTicks() {
      const cost = this.safeConstructionCost(UNIT.SAMLauncher);
      if (cost === null) return null;
      const gold = Number(this.player?.gold?.() || 0n);
      if (gold >= Number(cost)) return 300;
      const income = this.estimatedOwnGoldPerTick();
      if (income <= 0) return Number.POSITIVE_INFINITY;
      return (Number(cost) - gold) / income + 300;
    }

    estimatedOwnGoldPerTick() {
      if (!state.ownEconSamples) state.ownEconSamples = [];
      const tick = Number(this.game?.ticks?.() ?? 0);
      const samples = state.ownEconSamples;
      const last = samples[samples.length - 1];
      if (!last || tick - last.tick >= 100) {
        samples.push({ tick, gold: Number(this.player?.gold?.() || 0n) });
        if (samples.length > 3) samples.shift();
      }
      if (samples.length < 2) return 0;
      const latest = samples[samples.length - 1];
      const prior = samples[samples.length - 2];
      const dTick = Math.max(1, latest.tick - prior.tick);
      return Math.max(0, latest.gold - prior.gold) / dTick;
    }

    // True when the forecast says we CANNOT comfortably outpace the nuclear
    // threat — the chest binds and SAM construction/upgrade wins the lane.
    // Margin 600 ticks: SAM completion lead that leaves room for one income
    // misestimate.
    nuclearThreatOutrunsOurSamReadiness() {
      const enemyEta = this.hostileNuclearThreatEtaTicks();
      if (enemyEta === null) return false;
      const ownEta = this.ownSamReadinessEtaTicks();
      if (ownEta === null) return false;
      return ownEta > enemyEta - 600;
    }

    shouldBuildHostileSiloSam() {
      if (!state.settings.winFixes) return false;
      const siloSummary = this.hostileMissileSiloCapacitySummary();
      const threat = this.hostileThreatSnapshot();
      if (siloSummary === null || threat === null) return false;

      const ownSam = this.playerUnitCapacitySummary(
        this.player,
        UNIT.SAMLauncher,
      );
      if (ownSam === null) return false;

      // Hostile Silo count is not a spatial coverage requirement — but silo
      // MASS is: a level-L SAM holds L concurrent interceptors inside a
      // 70-102 tile radius, so one site cannot cover a wide structure
      // footprint against many-direction fire no matter its level (the
      // measured 25MM pattern: one site upgraded to 5 while 18-44 structures
      // burned; engine nations answer the same boards with 4-6 cheap sites).
      // Scale the SITE count with the strongest enemy's built-silo level sum;
      // below the threshold the doctrine is unchanged (one site + upgrades).
      return (
        ownSam.count < this.samSiteCountTarget() &&
        (siloSummary.hostileSiloCount > 0 || threat.siloThreat === true)
      );
    }

    // SAM site-count target (see shouldBuildHostileSiloSam): binds ONLY on
    // big-start boards (5MM/25MM) AND when one hostile player's BUILT silo
    // levels reach 3+. The big-start gate is what keeps none/temp
    // byte-identical: their enemies DO reach level 3+ silo mass in long
    // games, and the measured first attempt without this gate flipped the
    // no-mod anchor from a full-green 20.5k win to a 6.4k death.
    samSiteCountTarget() {
      if (!state.settings.winFixes) return 1;
      if (!this.legendaryBigStartGame()) return 1;
      const levelSum = this.hostileSiloLevelSumTarget();
      if (levelSum < hostileSamSiteScaleLevelSum) return 1;
      return Math.min(4, Math.ceil(levelSum / 2));
    }

    shouldBuildSiloTriggeredSam() {
      if (!state.settings.winFixes) return false;
      const ownSam = this.playerUnitCapacitySummary(
        this.player,
        UNIT.SAMLauncher,
      );
      if (ownSam === null || ownSam.count >= this.samSiteCountTarget()) {
        return false;
      }
      return (
        this.hasPlacedSiloOnMap() ||
        this.shouldBuildHostileSiloSam()
      );
    }

    /**
     * Return the next economic action that is both strategically eligible and
     * affordable right now. This mirrors the normal construction order without
     * probing tiles, so the nuclear behavior can make the same resource decision
     * without duplicating placement work.
     */
    spendableConstructionGold(excludedNukeClaimIds = null) {
      let availableGold;
      {
        availableGold = BigInt(this.player.gold() || 0n);
      }
      const committed = typeof autoBotBuildReservedGold === "function"
        ? autoBotBuildReservedGold(this.game, this.player, excludedNukeClaimIds) : 0n;
      availableGold = availableGold > committed ? availableGold - committed : 0n;

