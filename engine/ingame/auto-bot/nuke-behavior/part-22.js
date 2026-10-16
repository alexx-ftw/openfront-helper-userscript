
    // ── maybeUpgradeHelpfulSilo — NationNukeBehavior.ts:1037 (now async) ──────
    async maybeUpgradeHelpfulSilo(failedTarget) {
      const eligible = this.getRouteEligibleSilos(failedTarget);
      // DIVERGENCE (winFixes): continue partial target-demand upgrades and let
      // shared construction add a route-clear Silo when every helpful one caps.
      if (state.settings.winFixes === true && this.structureBehavior) {
        return this.structureBehavior.maybeUpgradeSiloForNukeDemand(eligible);
      }
      if (eligible.length === 0) return false;
      if (!this.hasUsefulSiloUpgradeCapacity(eligible, failedTarget)) return false;
      const preferred = this.getPreferredHelpfulSilos(eligible, failedTarget);
      const bestSilo = this.findBestProtectedSilo(preferred);
      return bestSilo ? this.actuateSiloUpgrade(bestSilo) : false;
    }

    // ── cost — NationNukeBehavior.ts:1100 ─────────────────────────────────────
    // DIVERGENCE C1: src reads `this.game.unitInfo(type).cost(this.game, this.player)`.
    // The gameApi `game` does NOT expose unitInfo, and the nuke cost fn calls
    // game.stats() (numNukesLaunched etc.) which the client GameView does NOT
    // expose. We read the live price from a buildables probe on an owned tile (the
    // nuke price is global, so any owned tile returns it). Mirrors mirvBehavior.cost.
    // Returns a BigInt (gold). Cached per-tick-ish to avoid re-probing repeatedly.
    async cost(type) {
      // Per-tick memo: src cost() is a pure deterministic calc returning the same
      // value within a tick; here it's an async probe, so cache by type+tick to
      // avoid redundant worker round-trips (getPerceivedNukeCost calls cost() up to
      // ~4× per nuke type). The cached VALUE is identical to a fresh probe — this is
      // a behavior-neutral optimization, not a strategy change.
      const tick = this.game.ticks();
      if (this._costCacheTick !== tick) {
        this._costCacheTick = tick;
        this._costCache = new Map();
      }
      if (this._costCache.has(type)) return this._costCache.get(type);

      const border = this.player.borderTiles();
      const tile =
        border && border.size > 0 ? border.values().next().value : null;
      if (tile === null || tile === undefined) return 0n;
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(tile, [type]),
          WORKER_TIMEOUT_MS,
          null,
        );
      }
      const bu = Array.isArray(buildables)
        ? buildables.find((b) => b.type === type)
        : null;
      const c = bu && bu.cost !== undefined && bu.cost !== null ? bu.cost : 0n;
      this._costCache.set(type, c);
      return c;
    }

    // ── nukeSpawn — mirrors PlayerImpl.nukeSpawn (PlayerImpl.ts:1233), the silo
    //    snap that player.canBuild(nukeType, tile) returns for AtomBomb/HydrogenBomb.
    // DIVERGENCE B1: src calls `this.player.canBuild(nukeType, tile)` to (a) gate
    // buildability and (b) get the launch silo tile for the trajectory check. The
    // client canBuild is async (buildables probe), so we split it: this SYNC helper
    // returns the silo the nuke would fly from — the closest by Manhattan distance
    // among silos that are active, not in cooldown, and not under construction
    // (exactly src nukeSpawn's findClosestBy criteria) — or `false` if none. The
    // async canBuild gate (incl. spawn-immunity / team teammate-structure guards
    // src's nukeSpawn also applies) is enforced separately in probeCanBuildNuke for
    // the FINAL chosen tile. This keeps the trajectory check faithful (same launch
    // silo canBuild would have snapped to) without an await in the inner scoring loop.
    // DIVERGENCE: pending intents use projected native capacity.
    // ponytail: retain readiness outside dispatch until partial-slot policy passes Baikal.
    nukeSpawn(nukeType, targetTile) {
      const silos = this.player.units(UNIT.MissileSilo);
      const projected = typeof autoBotBuildNukeSlots === "function"
        ? autoBotBuildNukeSlots(this.game, this.player) : null;
      let best = false;
      let bestDist = Infinity;
      for (const silo of silos) {
        if (!this.siloCanSpawnNuke(silo, projected)) continue;
        const d = this.game.manhattanDist(silo.tile(), targetTile);
        if (d < bestDist) {
          bestDist = d;
          best = silo.tile();
        }
      }
      return best;
    }

    samDemandOwner(player, targetSamId) {
      if (player === this.player ||
          playersArePermanentTeammates(this.player, player)) {
        return {};
      }
      const sam = (player.units?.(UNIT.SAMLauncher) ?? []).find(
        (unit) => String(unit.id?.()) === String(targetSamId),
      );
      if (!sam || sam.isAlive?.() === false) return {};
      const owner = sam.owner?.();
      if (!owner || !this.isEligibleNukeTarget(owner)) return {};
      return { sam, owner };
    }

    freezeGiantOwnTroops() {
      const gameMode = String(
        this.game.config()?.gameConfig?.()?.gameMode ?? "",
      );
      if (gameMode !== "Free For All" && gameMode !== "FFA") return null;
      const tiles = Number(this.player.numTilesOwned?.() ?? 0);
      if (tiles < 50_000) return null;
      const ourTroops = Number(this.player.troops?.() ?? 0);
      if (!this.freezeGiantArmyReady(ourTroops)) return null;
      return ourTroops;
    }

    largestHostileGiant() {
      let giant = null;
      let giantTroops = 0;
      for (const other of this.game.players()) {
        if (other === this.player || !other?.isPlayer?.()) continue;
        if (other.isAlive?.() === false) continue;
        if (this.player.isFriendly?.(other) === true) continue;
        const troops = Number(other.troops?.() ?? 0);
        if (troops > giantTroops) {
          giant = other;
          giantTroops = troops;
        }
      }
      return { giant, giantTroops };
    }

    ordinaryNukeCandidateHasValue(best, difficulty) {
      return best && (best.value > 0 || difficulty !== Difficulty.Impossible);
    }

    findNukeRelationTarget(difficulty) {
      const dominantCrown = this.findDominantCrownNukeTarget(difficulty);
      if (dominantCrown) return dominantCrown;
      const allyTarget = this.findAllyNukeTarget();
      if (allyTarget) return allyTarget;
      const hostileTarget = this.findHostileNukeTarget(true);
      if (hostileTarget) return hostileTarget;

      // In FFAs, nuke the crown if they're far enough ahead
      const crownTarget = this.findFFACrownTarget();
      if (crownTarget) {
        return crownTarget;
      }

      // In Teams, nuke the strongest team
      const teamTarget = this.findStrongestTeamTarget();
      if (teamTarget) {
        return teamTarget;
      }

      // Legendary fallback: an affordable silo must not remain idle merely
      // because the ordinary relation/crown ladder found no target. Select the
      // enemy with the most replacement value per tile, but never a permanent
      // teammate or our own player; nukeTileScore still rejects friendly-fire geometry.
      if (isLegendaryDifficulty(difficulty)) {
        return this.findLegendaryStructureTarget();
      }
      return null;
    }

    collectAllyRescuePressure(ally, pressureByAttacker) {
      if (ally.smallID?.() === this.player.smallID?.()) return;
      if (ally.isAlive?.() === false) return;
      if (!playersArePermanentTeammates(this.player, ally)) return;
      if (typeof ally.incomingAttacks !== "function") return;
      for (const attack of ally.incomingAttacks() ?? []) {
        this.addAllyRescuePressure(attack, pressureByAttacker);
      }
    }
