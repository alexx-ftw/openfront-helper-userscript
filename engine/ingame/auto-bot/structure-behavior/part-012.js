      return strongest;
    }

    // Nation/Human neighbours can assemble and commit a decisive invasion;
    // Bots and Tribes stay the early-game food source and must not freeze the
    // opening economy behind a preventive Post.
    isStrategicBorderOpponent(opponent) {
      const type = opponent?.type?.();
      return type === PlayerType.Nation || type === PlayerType.Human;
    }

    // Frontier tiles shared with one specific opponent — the same
    // owner-identity scan getAttackFrontTiles runs for live attackers. The
    // preemptive front contains ONLY the strong neighbour's tiles, so the
    // existing uncovered-front sampler and coverage ranker in
    // tryBuildDefensePost already aim every candidate at that frontier
    // (bounded samples, no separate proximity pass).
    getOpponentFrontTiles(opponentSid) {
      if (typeof this.player?.borderTiles !== "function") return [];
      if (typeof this.game?.neighbors !== "function") return [];
      if (typeof this.game?.hasOwner !== "function") return [];
      if (typeof this.game?.ownerID !== "function") return [];

      const frontTiles = [];
      outer: for (const borderTile of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(borderTile)) {
          const ownerSid = this.game.hasOwner(neighbor)
            ? this.game.ownerID(neighbor)
            : null;
          if (ownerSid === opponentSid) {
            frontTiles.push(borderTile);
            continue outer;
          }
        }
      }
      return frontTiles;
    }

    async buildFirstDefensePost(tiles) {
      for (
        let offset = 0;
        offset < tiles.length;
        offset += STRUCTURE_PROBE_CONCURRENCY
      ) {
        const batch = tiles.slice(offset, offset + STRUCTURE_PROBE_CONCURRENCY);
        const safeBatch = batch.filter(
          (tile) => !this.isDangerousStructureTile(tile, UNIT.DefensePost),
        );
        const buildables = await Promise.all(
          safeBatch.map((tile) =>
            this.buildableFor(
              UNIT.DefensePost,
              tile,
              STRUCTURE_PROBE_TIMEOUT_MS,
            ),
          ),
        );
        for (let index = 0; index < buildables.length; index++) {
          const bu = buildables[index];
          if (
            !this.isUsableStructureBuildable(
              bu,
              safeBatch[index],
              UNIT.DefensePost,
            ) ||
            // The worker may snap toward the border after the raw candidate
            // passed sampling. Validate the actual site before spending gold.
            !this.hasDefensePostBorderDepth(
              bu.canBuild === true ? safeBatch[index] : bu.canBuild,
            )
          ) {
            continue;
          }
          const buildMenu = getBuildMenu();
          if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
            return false;
          }
          // src: addExecution(new ConstructionExecution(player, DefensePost, tile)).
          if (!sendAutoBotBuildOrUpgrade(buildMenu, bu, bu.canBuild, this.game, this.player)) {
            return false;
          }
          state.stats.builds++;
          setLastAction(tr("🛡️ Defense post"), "build");
          return true;
        }
      }
      return false;
    }

    // defensePostNeeded — NationStructureBehavior.ts:229.
    defensePostNeeded() {
      const difficulty = currentDifficulty();
      if (difficulty === Difficulty.Easy) return false;
      return this.defensePostThreat(difficulty) !== null;
    }

    isStrategicLandAttack(attack) {
      const type = attack.attacker?.()?.type?.();
      return type === PlayerType.Nation || type === PlayerType.Human;
    }

    isTribeLandAttack(attack) {
      return attack.attacker?.()?.type?.() === PlayerType.Bot;
    }

    isActiveIncomingAttack(attack) {
      if (Number(attack?.troops?.()) <= 0 || attack?.retreating?.()) return false;

      // incomingAttacks() can briefly retain a wire snapshot after its target
      // or attacker has changed state.  A positive troop count alone is not a
      // current hostile attack: stale/dead/friendly/misdirected entries must not
      // authorize an economic Defense Post.
      return this.attackTargetsUs(attack) && this.attackHasLiveHostileAttacker(attack);
    }

    attackTargetsUs(attack) {
      const target = attack?.target?.();
      const targetID = target?.smallID?.();
      const ourID = this.player?.smallID?.();
      if (
        !target ||
        targetID === null ||
        targetID === undefined ||
        ourID === null ||
        ourID === undefined
      ) {
        return false;
      }
      return targetID === ourID;
    }

    attackHasLiveHostileAttacker(attack) {
      const attacker = attack?.attacker?.();
      if (!attacker) return false;
      if (attacker?.isAlive?.() === false) return false;
      return this.player?.isFriendly?.(attacker) !== true;
    }

    canAffordDefensePost() {
      {
        return (
          BigInt(this.player.gold() || 0) >=
          BigInt(this.cost(UNIT.DefensePost) || 0)
        );
      }
    }

    // isLandAttack — src filters land attacks by `attack.sourceTile() === null`
    // (boat attacks carry the landing tile). The extension wire AttackUpdate has
    // NO sourceTile, so when it's absent we RECONSTRUCT it: a land attack comes
    // from an enemy we share a LAND border with; a boat attack lands from across
    // water (the attacker need not be a land neighbour). When sourceTile IS
    // present (harness / a future client build) we use the exact value.
    // RESIDUAL: a land-bordering neighbour who ALSO boats has that boat attack
    // counted as land (rare); still far better than counting every attack as land.
    isLandAttack(a) {
      if (a.hasSourceTile && a.hasSourceTile()) {
        return a.sourceTile() === null;
      }
      const attacker = a.attacker();
