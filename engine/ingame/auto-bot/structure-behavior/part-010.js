            Math.max(0, frontTiles.length - PREEMPTIVE_DEFENSE_POST_FRONT_FLOOR) /
              PREEMPTIVE_DEFENSE_POST_FRONT_TILES_PER_POST,
          ),
      );
    }

    // Lead-survival guard (measured baikal-nuke-wars collapse: 52% territory
    // at tick 3000 with zero defensive structures, dead by 4433): while the
    // bot is the leading non-team player by territory AND holds gold headroom
    // beyond a Defense Post plus the next economy rung, its most pressured
    // strategic border — regardless of quiet/war status — must reach the same
    // front-scaled Post expectation the preemptive lane already uses before
    // discretionary offense spending resumes. Legendary-only (the documented
    // adaptive construction mode) and winFixes-scoped; reuses the existing
    // numTilesOwned/hostile-player/front accessors and coverage math — no new
    // plumbing or thresholds.
    leadGuardDefensePostThreat(difficulty, activeLandAttacks = null) {
      if (!isLegendaryDifficulty(difficulty)) {
        if (Array.isArray(state.stats?.constructionDump)) {
          this._leadGuardTraceState = {
            gate: "not_legendary",
            tick: safeStructureGameTick(this.game),
            difficulty: String(difficulty),
          };
        }
        return null;
      }
      if (state.settings.winFixes !== true) {
        if (Array.isArray(state.stats?.constructionDump)) {
          this._leadGuardTraceState = {
            gate: "winfixes_off",
            tick: safeStructureGameTick(this.game),
            difficulty: String(difficulty),
          };
        }
        return null;
      }
      const rawTick = safeStructureGameTick(this.game);
      const snapshotTick = Number.isFinite(rawTick) ? rawTick : null;
      const snapshot = this._leadGuardDefensePostThreatSnapshot;
      if (
        snapshot?.tick === snapshotTick &&
        snapshot.difficulty === difficulty
      ) {
        return snapshot.threat;
      }
      const threat = this.computeLeadGuardDefensePostThreat(
        difficulty,
        activeLandAttacks,
      );
      if (snapshotTick !== null) {
        this._leadGuardDefensePostThreatSnapshot = {
          difficulty,
          tick: snapshotTick,
          threat,
        };
      }
      return threat;
    }

    computeLeadGuardDefensePostThreat(difficulty, knownLandAttacks = null) {
      // Runtime-truth diagnostic is inert without the test harness dump.
      const trace = Array.isArray(state.stats?.constructionDump);
      const numbers = {
        ourTiles: null,
        maxHostileTiles: null,
        strongestTroops: null,
        frontCount: null,
        postsNearFront: null,
        allowed: null,
        activeLandAttacks: null,
        strategicLandAttacks: null,
        attackerTypes: null,
        borderCandidates: null,
      };
      const reportGate = (gate) => {
        if (trace) {
          this._leadGuardTraceState = {
            gate,
            tick: safeStructureGameTick(this.game),
            ...numbers,
          };
        }
        return null;
      };
      const hostilePlayers = this.liveHostilePlayers();
      if (!Array.isArray(hostilePlayers) || hostilePlayers.length === 0) {
        return reportGate("hostiles_empty");
      }
      if (!this.leadGuardTerritorialLead(hostilePlayers, numbers)) {
        return reportGate("not_lead");
      }
      if (!this.legendaryQuietPostGoldAboveEconomyRung()) {
        return reportGate("gold_rung");
      }
      const activeLandAttacks = knownLandAttacks ??
        (this.player?.incomingAttacks?.() ?? []).filter(
          (attack) =>
            this.isActiveIncomingAttack(attack) &&
            this.isLandAttack(attack) &&
            !this.isTribeLandAttack(attack),
        );
      const activeStrategicLandAttacks = activeLandAttacks.filter((attack) =>
        this.isStrategicLandAttack(attack),
      );
      numbers.activeLandAttacks = activeLandAttacks.length;
      numbers.strategicLandAttacks = activeStrategicLandAttacks.length;
      numbers.attackerTypes = [...new Set(activeLandAttacks.map((attack) =>
        String(attack.attacker?.()?.type?.() ?? "unknown"),
      ))];
      const front = this.leadGuardFrontData(
        hostilePlayers,
        activeStrategicLandAttacks,
        numbers,
        trace,
      );
      if (front === null) return reportGate("no_border_opponent");
      return this.buildLeadGuardDefensePostThreat(
        front,
        numbers,
        trace,
        reportGate,
      );
    }

    leadGuardTerritorialLead(hostilePlayers, numbers) {
      const isTeam =
        String(this.game.config().gameConfig().gameMode) === "Team";
      let ourTiles = Number(this.player?.numTilesOwned?.());
      if (isTeam) {
        ourTiles = 0;
        for (const player of this.game.players()) {
          if (player.isPlayer() && this.player.isOnSameTeam(player)) {
            ourTiles += Number(player.numTilesOwned?.());
          }
        }
      }
      if (!Number.isFinite(ourTiles) || ourTiles <= 0) return false;
      let isLead = true;
      for (const opponent of hostilePlayers) {
        const tiles = Number(opponent.numTilesOwned?.() || 0);
        numbers.ourTiles = ourTiles;
        numbers.maxHostileTiles = Math.max(
          numbers.maxHostileTiles ?? 0,
          tiles,
        );
        if (tiles >= ourTiles) isLead = false;
      }
      return isLead;
    }

    leadGuardFrontData(hostilePlayers, activeStrategicLandAttacks, numbers, trace) {
      const borderingOwnerIds = this.borderingLandOwnerIds();
      const borderPlayers = hostilePlayers.filter((opponent) => {
        const sid = this.readPlayerSmallId(opponent);
        return borderingOwnerIds !== null
          ? borderingOwnerIds.has(sid)
          : this.safeSharesBorder(opponent);
      });
      const leadFrontPlayers = new Map(
