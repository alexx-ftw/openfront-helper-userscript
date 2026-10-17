      // On Easy & Medium, only allow tiles owned by the target player (=> nuke away from the border) to reduce nuke usage
      return false;
    }

    // ── nukeTileScore — NationNukeBehavior.ts:650 ─────────────────────────────
    /**
     * Level-weighted value of a friendly (own or permanent-teammate) structure
     * for the friendly-fire blast penalty. MissileSilo is the heaviest (it is
     * our nuclear strike capability and the most expensive to rebuild); SAMs
     * and Cities follow; Ports/Factories mirror their enemy scoring value.
     * DefensePosts are excluded — they are cheap, spammable border screens and
     * penalizing them would veto every legitimate border tile.
     */
    friendlyFireStructureValue(unit) {
      const level = unit.level();
      switch (unit.type()) {
        case UNIT.MissileSilo:
          return 50_000 * level;
        case UNIT.SAMLauncher:
          return 40_000 * level;
        case UNIT.City:
          return 25_000 * level;
        case UNIT.Port:
          return 15_000 * level;
        case UNIT.Factory:
          return 15_000 * level;
        default:
          return 0;
      }
    }

    /**
     * Live enumeration behind the friendly-fire snapshot: our own structures
     * plus those of permanent teammates only — nuclear coordination already
     * treats their land and structures as ours (see findAllyNukeTarget); a
     * breakable diplomatic ally's structures carry no such guarantee.
     */
    collectFriendlyNukeStructureUnits() {
      const units = [];
      if (typeof this.player?.units === "function") {
        units.push(...unitsOfTypes(this.player));
      }
      if (typeof this.game?.players === "function") {
        for (const other of this.game.players()) {
          if (!other || other.smallID?.() === this.player?.smallID?.()) continue;
          if (!playersArePermanentTeammates(this.player, other)) continue;
          units.push(...unitsOfTypes(other));
        }
      }
      return units;
    }

    /**
     * Per-decision snapshot of friendly structure tiles for the friendly-fire
     * penalty. nukeTileScore runs once per candidate tile; without this memo a
     * sweep would re-enumerate own + teammate units for every tile. Memoized by
     * game tick (a candidate sweep never spans ticks — collectNukeCandidates
     * completes within one decision) with both scoring and replacement values
     * pre-resolved so the per-tile penalty stays a pure distance check.
     */
    friendlyNukeStructures() {
      const tick = Number(this.game.ticks());
      if (
        this._friendlyNukeStructureTick !== tick ||
        !Array.isArray(this._friendlyNukeStructures)
      ) {
        this._friendlyNukeStructures = this.collectFriendlyNukeStructureUnits()
          .map((unit) => ({
            tile: unit.tile(),
            value: this.friendlyFireStructureValue(unit),
            replacementValue: this.nukeStructureValue(unit),
          }))
          .filter((entry) => entry.value > 0);
        this._friendlyNukeStructureTick = tick;
      }
      return this._friendlyNukeStructures;
    }

    /**
     * Penalty for a candidate tile whose blast radii would also hit friendly
     * structures: every structure strictly within the outer circle is
     * destroyed.
     * Uses the existing replacement multiplier for the complete destruction area.
     */
    friendlyFirePenalty(tile, magnitude, replacementValues = false) {
      const friendlyStructures = this.friendlyNukeStructures();
      if (friendlyStructures.length === 0) return 0;
      const outerSquared = magnitude.outer * magnitude.outer;
      let destroyedValue = 0;
      for (const entry of friendlyStructures) {
        if (this.game.euclideanDistSquared(tile, entry.tile) < outerSquared) {
          destroyedValue += replacementValues ? entry.replacementValue : entry.value;
        }
      }
      return destroyedValue * FRIENDLY_FIRE_PENALTY;
    }

    /**
     * Counterforce weighting for enemy MissileSilo tiles: a silo owned by an
     * enemy who can already pay for a MIRV is a loaded gun — destroying it
     * denies a 25M+ saturation strike that would erase our structure core,
     * and (since the engine escalates the MIRV price globally per launch)
     * keeps the market cheaper for us. Gold alone does not prove intent to
     * launch, so the multiplier is bounded; the threshold is the base price
     * because the live escalated quote is only reachable through an async
     * probe while this scorer runs synchronously. Returns 1 for every other
     * owner shape (own silos never reach this scorer; stubs lack owner/gold).
     */
    mirvCapableSiloPriority(unit) {
      const owner = unit?.owner?.();
      if (!owner) return 1;
      const gold = owner.gold?.();
      if (typeof gold !== "bigint" || gold < MIRV_CAPABLE_GOLD_THRESHOLD) {
        return 1;
      }
      return MIRV_CAPABLE_SILO_PRIORITY_MULTIPLIER;
    }

    nukeTileScore(tile, silos, targets, nukeType, survival = false) {
      const magnitude = this.game.config().nukeMagnitudes(nukeType);
      let tileValue = targets
        .filter((unit) => isInsideNukeDestructionRadius(
          this.game, tile, unit.tile(), magnitude.outer,
        ))
        .map((unit) => {
          const level = unit.level();
          switch (unit.type()) {
            case UNIT.City:
              return this.activeTradeDestinationValue(unit, 25_000 * level);
            case UNIT.DefensePost:
              return 5_000 * level;
            case UNIT.MissileSilo:
              return 50_000 * level * this.mirvCapableSiloPriority(unit);
            case UNIT.SAMLauncher:
              // Counterforce cohesion: the wealth ranking prices covering
              // SAMs at 1.5M/level, so a blast that destroys one must score
              // here too — otherwise SAM-rich retargets collect only
              // zero-value tiles and the lane strangles itself.
              return 100_000 * level;
            case UNIT.Port:
              return this.activeTradeDestinationValue(unit, 15_000 * level);
            case UNIT.Factory:
              return 15_000 * level;
            default:
              return 0;
          }
        })
        .reduce((prev, cur) => prev + cur, 0);

      const difficulty = currentDifficulty();
      // On Easy, ignore SAMs entirely.
      // On Medium, apply a simple local SAM penalty.
      // On Hard, Impossible, and Legendary we rely on trajectory-based interception checks instead. See maybeSendNuke().
      if (difficulty === Difficulty.Medium) {
        const dist50 = euclDistFN(tile, 50, false);
        const hasSam = targets.some(
          (unit) =>
            unit.type() === UNIT.SAMLauncher && dist50(this.game, unit.tile()),
        );
        if (hasSam) return -1;
      }

      // On Impossible/Legendary difficulty and a hydrogen bomb, add value for SAMs that can be outranged
      if (
        isAtLeastHardDifficulty(difficulty) &&
        nukeType === UNIT.HydrogenBomb
      ) {
        const hydroMagnitude = this.game
          .config()
          .nukeMagnitudes(UNIT.HydrogenBomb);
        const nearbySams = this.game.nearbyUnits(
          tile,
          hydroMagnitude.outer,
          UNIT.SAMLauncher,
        );

        for (const sam of nearbySams) {
          const samLevel = sam.unit.level();
          if (samLevel >= 5) continue; // Can't outrange level 5+ SAMs
