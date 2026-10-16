    }

    playerStructureValue(player) {
      const structures = unitsOfTypes(player);
      return structures.reduce(
        (total, structure) => total + this.nukeStructureValue(structure),
        0,
      );
    }

    bestCandidateValue(candidates) {
      // The retarget comparison must read the same ranked score the sort
      // used (value + blast coverage), not the raw value of the winner.
      return candidates.length > 0
        ? Number(candidates[0]?.score ?? candidates[0]?.value ?? 0)
        : 0;
    }

    findHighestValueNukeTarget(exclude) {
      return this.findValueRankedNukeTargets(exclude)[0]?.target ?? null;
    }

    // Rank eligible hostile owners by absolute structure value, highest first.
    // Cache per tick and excluded target because ownership/value cannot change
    // between two decisions on the same game tick.
    findValueRankedNukeTargets(exclude) {
      const tick = this.game.ticks();
      const excludeKey = exclude ? String(exclude.smallID()) : "-";
      const cacheKey = `${tick}:${excludeKey}`;
      if (this._valueRankedTargetCacheKey === cacheKey) {
        return this._valueRankedTargetCache;
      }
      const ranked = [];
      for (const other of this.game.players()) {
        if (!this.isHighestValueNukeTargetCandidate(other, exclude)) continue;
        const value = this.playerStructureValue(other);
        if (value > 0) ranked.push({ target: other, value });
      }
      ranked.sort((a, b) => b.value - a.value);
      this._valueRankedTargetCacheKey = cacheKey;
      this._valueRankedTargetCache = ranked;
      return ranked;
    }

    isHighestValueNukeTargetCandidate(other, exclude) {
      return other.smallID() !== this.player.smallID() &&
        other.type?.() !== PlayerType.Bot &&
        (!exclude || other.smallID() !== exclude.smallID()) &&
        other.isAlive?.() !== false &&
        !playersArePermanentTeammates(this.player, other) &&
        this.attackBehavior.shouldAttack(other) !== false;
    }

    async nukeHasPositiveExpectedValue(candidate, target, selectedNuke, silos) {
      if (!isLegendaryDifficulty(currentDifficulty())) return true;
      // Survival bypass only: the pinned active invader's territory is itself
      // a valid payoff; unrelated targets still need positive structure value.
      // The plain retaliation bypass was measured firing 11 sub-value shots
      // (best candidate 5-31k vs a 750k Atom) for 0 destroyed value on the
      // closest matrix row — a direct violation of the expected-value
      // requirement, since deterrence bombs that hit nothing still cost
      // full price and invite counter-retaliation.
      if (this.isInvasionSurvivalTarget(target)) return true;
      if (
        this.findStrategicBorderArmyTarget()?.smallID?.() ===
        target?.smallID?.()
      ) return true;
      const structures = unitsOfTypes(target);
      const magnitude = this.game.config().nukeMagnitudes(selectedNuke.type);
      const vulnerableValue = structures
        .filter((unit) => isInsideNukeDestructionRadius(
          this.game, candidate.tile, unit.tile(), magnitude.outer,
        ))
        .reduce((sum, unit) => sum + this.nukeStructureValue(unit), 0);
      if (vulnerableValue <= 0) return false;
      const coveringSamLevels = Number(candidate.coveringSamLevels || 0);
      const readySiloCapacity = this.readySiloShotCapacity(silos);
      const requiredShots = Math.max(1, coveringSamLevels + 1);
      const launchCount = coveringSamLevels > 0 ? requiredShots : 1;
      const totalCost = BigInt(launchCount) * BigInt(selectedNuke.cost || 0n);
      return BigInt(Math.round(vulnerableValue)) >= totalCost &&
        (coveringSamLevels <= 0 || readySiloCapacity >= requiredShots);
    }

    nukeStructureValue(unit) {
      // Authoritative replacement values mirroring the engine's build costs
      // (Config.unitInfo): City/Port/Factory double per level from 125k,
      // MissileSilo is flat 1M, SAM steps 1.5M/3M, DefensePost steps 50k
      // capped at 250k. The earlier flat 25k/level City pricing made the
      // positive-EV guard veto every legitimate shot (measured More Than
      // Luck: 23 candidates, 4 positive-scored, best 10k vs a real City-3
      // value of 1M — valueGate false at 720 consecutive decisions).
      const level = Math.max(1, Number(unit?.level?.()) || 1);
      switch (unit?.type?.()) {
        case UNIT.City:
          return Math.min(1_000_000, Math.pow(2, level - 1) * 125_000);
        case UNIT.Port:
        case UNIT.Factory:
          return Math.min(1_000_000, Math.pow(2, level - 1) * 125_000);
        case UNIT.MissileSilo:
          return 1_000_000;
        case UNIT.SAMLauncher:
          return Math.min(3_000_000, level * 1_500_000);
        case UNIT.DefensePost:
          return Math.min(250_000, level * 50_000);
        default:
          return 0;
      }
    }

    partitionCandidatesBySamCoverage(candidates, nukeType, difficulty) {
      const clear = [];
      const covered = [];
      let routeBlockedTile = null;
      for (const cand of candidates) {
        if (!isLegendaryDifficulty(difficulty)) {
          clear.push(cand);
          continue;
        }
        const spawnTile = this.nukeSpawn(nukeType, cand.tile);
        const interceptable = spawnTile !== false &&
          this.isTrajectoryInterceptableBySam(spawnTile, cand.tile);
        const coveringSams = interceptable ? this.findEnemySamsCoveringTile(cand.tile) : [];
        // Destination saturation does not account for SAMs elsewhere along
        // the route. Match getRouteEligibleSilos before authorizing a shot.
        if (interceptable && (coveringSams.length === 0 ||
          this.isTrajectoryInterceptableBySam(
            spawnTile, cand.tile, new Set(coveringSams.map((sam) => sam.id())),
          ))) {
          routeBlockedTile ??= cand.tile;
          continue;
        }
        const coveringLevel = coveringSams.reduce(
          (sum, sam) => sum + Math.max(0, Number(sam.level?.()) || 0),
          0,
        );
        const entry = { ...cand, coveringSamLevels: coveringLevel };
        if (coveringLevel > 0) covered.push(entry);
        else clear.push(entry);
      }
      return { clear, covered, routeBlockedTile };
    }

    /**
     * Offensive nukes yield to the shared economy/defense reserve. A heavy
     * assault or direct retaliation keeps the emergency path responsive;
     * ordinary target selection follows the surplus policy.
     */
    shouldDeferNukeForEconomy(nukeTarget, nukeCost, excludedNukeClaimIds = null) {
      if (this.hasActiveMaritimeInvasion()) return true;
      // A Hydro Legendary nation with a live SAM has already paid for the
      // defensive prerequisite. Once an Atom is affordable, withholding it
      // behind the next 1.5M SAM reserve leaves the Silo permanently idle and
      // makes the nuclear economy unreachable; the friendly-fire scorer still
      // protects our own structures below. Re-measured 2026-10-10 with the
      // decision telemetry below: the defer gate IS binding (144 affordable
      // defers, 0 launches on basket-05) but releasing it for every Legendary
      // nation drained the conventional defense — aggregate basket survival
      // fell 54495 -> 49534 ticks and basket-04/05 died 3241/1720 ticks
      // earlier despite 16.6M enemy structure gold. REVERTED to the Hydro-only
      // carve-out; the drain-not-defend tradeoff needs its own lever.
      if (
        this.isHydroNation === true &&
        isLegendaryDifficulty(currentDifficulty()) &&
        this.player.units(UNIT.SAMLauncher).length > 0 &&
        this.player.gold() >= BigInt(nukeCost || 0n)
      ) {
        return false;
      }
      const policy = this.structureBehavior?.shouldDeferOffensiveNuke;
      if (typeof policy !== "function") return false;
      {
        if (this.isUnderHeavyAttack()) return false;
      }
      if (this.isRetaliationNukeTarget(nukeTarget)) return false;
      {
        return policy.call(this.structureBehavior, nukeCost, excludedNukeClaimIds) === true;
      }
    }

    getCrownLeadThreshold(difficulty) {
      switch (difficulty) {
        case Difficulty.Easy: return 0.4;
        case Difficulty.Medium: return 0.3;
        case Difficulty.Hard: return 0.2;
        case Difficulty.Impossible: return 0.1;
        case Difficulty.Legendary: return 0.05;
        default: return 0.1;
      }
    }
