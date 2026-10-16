        const completedTick = this.hostileSiloSamCurrentTick();
        const retryBaseTick = completedTick ?? attemptTick;
        this._hostileSiloSamRetryNotBeforeTick =
          retryBaseTick + HOSTILE_SILO_SAM_RETRY_TICKS;
      }
      return built;
    }

    hostileSiloSamPlacementOptions() {
      return {
        allowPreemptiveSam: true,
        useActualCost: true,
        forceNewStructure: true,
        prioritizeStructureCoverage: true,
        probeLimit: STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
        probeTimeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        // Used only when an older client lacks the primitives required for the
        // one-request local-legality path below.
        parallelProbeCount: DEFENSIVE_SAM_PROBE_CONCURRENCY,
      };
    }

    hostileSiloSamRetryActive(tick = this.hostileSiloSamCurrentTick()) {
      return (
        tick !== null &&
        this._hostileSiloSamRetryNotBeforeTick !== null &&
        tick < this._hostileSiloSamRetryNotBeforeTick
      );
    }

    hasOwnSamUnderConstruction() {
      {
        return (this.player.units(UNIT.SAMLauncher) || []).some(
          (sam) =>
            sam &&
            typeof sam.isUnderConstruction === "function" &&
            sam.isUnderConstruction(),
        );
      }
    }

    hostileSiloSamActionBlocked() {
      return (
        this.hostileSiloSamRetryActive() || this.hasOwnSamUnderConstruction()
      );
    }

    hostileSiloSamCurrentTick() {
      {
        if (typeof this.game?.ticks !== "function") return null;
        const tick = this.game.ticks();
        return tick === null || tick === undefined ? null : tick;
      }
    }

    hostileSiloSamAttemptedThisTick() {
      const tick = this.hostileSiloSamCurrentTick();
      return tick !== null && this._hostileSiloSamAttemptTick === tick;
    }

    // Engine-nation structure pacing (NationStructureBehavior.ts:97-114):
    // placements #3+ are spaced 250/150/100 ticks so a rich-board burst does
    // not cluster structures inside one nuke blast radius or balloon
    // maxTroops ahead of the troop count. Applied to the big-start economic
    // burst only; defensive emergency paths stay unpaced.
    bigStartStructurePacingBlocks() {
      if (!this.legendaryBigStartGame()) return false;
      const record = state.bigStartStructurePacing;
      const tick =
        typeof this.game?.ticks === "function" ? this.game.ticks() : null;
      if (tick === null || record === undefined) return false;
      const schedule = [0, 0, 250, 150, 100];
      const gap = schedule[Math.min(record.count, schedule.length - 1)];
      return tick - record.lastTick < gap;
    }

    recordBigStartStructurePlacement() {
      const tick =
        typeof this.game?.ticks === "function" ? this.game.ticks() : 0;
      const record = (state.bigStartStructurePacing ??= {
        count: 0,
        lastTick: -1000,
      });
      record.count += 1;
      record.lastTick = tick;
    }

    // Detects the big-starting-gold modifier profile (startingGold >= 3M:
    // 5MM/25MM) from the opening treasury. The snapshot is taken at the
    // structures-chain ENTRY (see doHandleStructures) because the
    // chain runs from the first decision (~tick 6, treasury still unspent —
    // branch-internal calls can arrive only after the SAM's 1.5M already
    // dropped a 5M start below a 4M threshold, which silently disabled the
    // lever). 3M unspent before tick 1500 cannot occur in an ordinary game
    // (the first SAM chest hoard targets 1.5M and completes long after).
    // Decided once; no config surface is read (config stubs have crashed the
    // sim before).
    legendaryBigStartGame() {
      {
        if (state.bigStartGold?.decided) return state.bigStartGold.value;
        const tick =
          typeof this.game?.ticks === "function" ? this.game.ticks() : null;
        if (tick === null || tick === undefined) return false;
        if (tick > 1500) {
          state.bigStartGold = { decided: true, value: false };
          return false;
        }
        const gold =
          typeof this.player?.gold === "function" ? this.player.gold() : null;
        if (gold === null) return false;
        if (
          typeof gold === "bigint"
            ? gold >= 3_000_000n
            : Number(gold) >= 3_000_000
        ) {
          state.bigStartGold = {
            decided: true,
            value: true,
            openingGold: typeof gold === "bigint" ? gold : BigInt(gold),
          };
          return true;
        }
        return false; // keep sampling until the window closes
      }
    }

    // Big-start opening (5MM/25MM): the speculative 1M silo competes with
    // the port burst converting the starting treasury into compounding
    // trade income; measured first hostile strikes (1774-1989) never land
    // before the burst finishes, and the 3000-tick backstop keeps the silo
    // lane alive when port placement stalls. Waterless maps skip the burst
    // entirely (no port candidates) and keep the ordinary silo path.
    legendaryBigStartSiloDeferred(hasOceanPortTiles) {
      if (!hasOceanPortTiles || !this.legendaryBigStartGame()) return false;
      const tick =
        typeof this.game?.ticks === "function" ? this.game.ticks() : 0;
      if (tick >= LEGENDARY_LANDLOCKED_ARSENAL_BACKSTOP_TICK) return false;
      const ports = this.player?.units?.(UNIT.Port) || [];
      return ports.length < 5;
    }

    async maybeOpenLegendaryArsenal({
      config,
      cityCount,
      hasOceanPortTiles,
      missileSilosEnabled,
      nukesEnabled,
    }) {
      // Landlocked spawns (Luna interior) never gain ocean port tiles; the
      // tick backstop opens the first-silo lane with one City instead
      // of waiting for a coast and a second City that never came.
      const tick =
        typeof this.game?.ticks === "function" ? this.game.ticks() : 0;
      const landlockedBackstop =
        !hasOceanPortTiles && tick >= LEGENDARY_LANDLOCKED_ARSENAL_BACKSTOP_TICK;
      if (
        cityCount < (landlockedBackstop ? 1 : 2) ||
        (!hasOceanPortTiles && !landlockedBackstop) ||
        !missileSilosEnabled ||
        !nukesEnabled ||
