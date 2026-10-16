      // more raw candidates to reach `count` valid ones; we sample `count` raw
      // candidates and probe them, which can yield slightly fewer probes. Same
      // candidate-generation distribution; only the in-sampler canBuild filter
      // moves to the probe phase (rank-then-probe).
      const sampledTiles = this.sampleTilesNearFront(
        uncoveredFrontTiles,
        25,
        UNIT.DefensePost,
      );
      const tiles = this.rankDefensePostTiles(
        sampledTiles,
        uncoveredFrontTiles,
      );
      return this.buildFirstDefensePost(tiles);
    }

    defensePostFrontDemand(threat, frontTiles) {
      if (Array.isArray(threat.landAttacks)) {
        if (
          this.countDefensePostsNearFront(frontTiles, threat.allowed) >=
          threat.allowed
        ) {
          return null;
        }
        const uncovered = this.uncoveredDefensePostFrontTiles(frontTiles);
        return uncovered.length > 0 ? uncovered : null;
      }
      return this.countDefensePostsNearFront(frontTiles, threat.allowed) <
        threat.allowed
        ? frontTiles
        : null;
    }

    defensePostPlacementThreat(difficulty) {
      return this.defensePostThreat(difficulty);
    }

    defensePostThreat(difficulty) {
      // Land attacks only (src: sourceTile() === null). isLandAttack() uses the
      // exact source tile when present and reconstructs it through a shared
      // land border when the extension omits it. Tribe (Bot) attackers are
      // excluded: they never mount the sustained strategic pressure a Post
      // deters, so a Post on a tribe front is pure gold waste (goal rule).
      const landAttacks = (this.player.incomingAttacks?.() ?? []).filter(
        (attack) =>
          this.isActiveIncomingAttack(attack) &&
          this.isLandAttack(attack) &&
          !this.isTribeLandAttack(attack),
      );
      if (landAttacks.length === 0) {
        // PREEMPTIVE: with no live attack, a bordering army-sized Nation/Human
        // neighbour still authorizes a small capped Post budget — waiting for
        // the first incoming wave is what left quiet frontiers with zero Posts
        // once the multi-nation dogpile actually started.
        return this.strategicBorderDefensePostThreat(difficulty) ||
          this.leadGuardDefensePostThreat(difficulty);
      }
      const ourTroops = this.player.troops();
      if (ourTroops <= 0) return null;
      const incomingTroops = landAttacks.reduce(
        (sum, attack) => sum + attack.troops(),
        0,
      );
      const ratio = incomingTroops / ourTroops;
      const preemptiveStrategicThreat =
        ratio >= PREEMPTIVE_DEFENSE_POST_THREAT_RATIO &&
        landAttacks.some((attack) => this.isStrategicLandAttack(attack));
      if (ratio < UNDER_ATTACK_THREAT_RATIO && !preemptiveStrategicThreat) {
        // War-agnostic guard reach: a sub-threshold live attack must still
        // fall through to the lead guard — an active attacker is precisely
        // the front that needs Posts, and waiting for the ratio threshold is
        // what left the 52%-lead window with zero defensive structures.
        return this.leadGuardDefensePostThreat(difficulty, landAttacks);
      }
      const allowed =
        difficulty === Difficulty.Medium
          ? 1
          : Math.min(
              DEFENSE_POST_MAX_CONCURRENT,
              Math.ceil(ratio / DEFENSE_POST_RATIO_PER_POST),
            );
      return { allowed, incomingTroops, landAttacks, ratio };
    }

    // A frontier shared with a much stronger Nation/Human neighbour is the
    // pre-condition of every multi-nation dogpile. By the time the invasion
    // is a live incoming attack, a Post's long construction cannot finish
    // ahead of it, so the quiet border itself authorizes a capped preemptive
    // budget. The per-tick snapshot reuses the cached hostile-player list and
    // one border scan instead of rescanning the frontier per caller, and the
    // rule never applies on Easy, where Posts are never built at all.
    strategicBorderDefensePostThreat(difficulty) {
      if (difficulty === Difficulty.Easy) return null;
      const rawTick = safeStructureGameTick(this.game);
      const snapshotTick = Number.isFinite(rawTick) ? rawTick : null;
      const snapshot = this._strategicBorderDefensePostThreatSnapshot;
      if (
        snapshot?.tick === snapshotTick &&
        snapshot.difficulty === difficulty
      ) {
        return snapshot.threat;
      }
      const threat = this.computeStrategicBorderDefensePostThreat(difficulty);
      if (snapshotTick !== null) {
        this._strategicBorderDefensePostThreatSnapshot = {
          difficulty,
          tick: snapshotTick,
          threat,
        };
      }
      return threat;
    }

    computeStrategicBorderDefensePostThreat(difficulty) {
      const ourTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      if (ourTroops <= 0) return null;
      // A preemptive post must never eat the foundational City's gold: the
      // first City raises maxTroops for the whole defense, while a pre-war
      // post only makes one stretch of border expensive. Live attacks keep
      // their unconditional Defense Post authorization.
      if (!this.hasBuiltCityForPreemptiveDefense()) return null;
      // Adaptive tier: a quiet-border Post must be pure surplus. Six
      // zero-threat Posts drained ~500k gold on Baikal while the next City
      // rung (the maxTroops raise the whole defense needs) stayed unfunded;
      // live-attack Posts keep their unconditional authorization.
      if (
        difficulty === Difficulty.Legendary &&
        !this.legendaryQuietPostGoldAboveEconomyRung()
      ) {
        return null;
      }
      const strongest = this.strongestQuietStrategicBorderOpponent();
      if (strongest === null) return null;
      if (strongest.troops < STRATEGIC_DEFENSE_POST_TROOP_RATIO * ourTroops) {
        return null;
      }
      const frontTiles = this.getOpponentFrontTiles(strongest.opponentSid);
      if (frontTiles.length === 0) return null;
      const allowed =
        difficulty === Difficulty.Medium
          ? 1
          : this.frontScaledPreemptiveDefensePostBudget(frontTiles);
      return {
        allowed,
        frontTiles,
        incomingTroops: 0,
        landAttacks: [],
        ratio: strongest.troops / ourTroops,
        strategicBorder: true,
      };
    }

    // Front-scaled preemptive Post budget shared by the strategic-border lane
    // and the lead guard: the existing measured constants (2 base posts plus
    // one per extra block of exposed front tiles, capped at 6).
    frontScaledPreemptiveDefensePostBudget(frontTiles) {
      return Math.min(
        PREEMPTIVE_DEFENSE_POST_MAX_POSTS_CEILING,
        PREEMPTIVE_DEFENSE_POST_MAX_POSTS +
          Math.floor(
