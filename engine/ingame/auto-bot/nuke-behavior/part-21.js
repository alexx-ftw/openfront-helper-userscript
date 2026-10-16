
    isEnemyNukeSam(sam) {
      const owner = sam.owner?.();
      if (!owner) return false;
      if (owner.smallID?.() === this.player.smallID?.()) return false;
      const permanentTeammate = playersArePermanentTeammates(this.player, owner);
      const isFriendly =
        owner.isFriendly?.(this.player) === true ||
        this.player.isFriendly?.(owner) === true;
      if (isFriendly || permanentTeammate) {
        const hasWinner =
          typeof this.game.hasWinner === "function"
            ? this.game.hasWinner()
            : typeof this.game.getWinner === "function" && this.game.getWinner() != null;
        if (
          !permanentTeammate ||
          !hasWinner ||
          this.game.config().gameConfig().gameType === "Singleplayer"
        ) {
          return false;
        }
      }
      return sam.isAlive?.() !== false;
    }

    collectRouteInterceptorsForTile(tile, found, seen) {
      const spawnTile = this.nukeSpawn(UNIT.AtomBomb, tile);
      if (spawnTile === false) return;
      const interceptingSams = new Set();
      if (!this.isTrajectoryInterceptableBySam(spawnTile, tile, undefined, { interceptingSams })) {
        return;
      }
      for (const sam of interceptingSams) {
        const id = String(sam.id?.() ?? "");
        if (id === "" || seen.has(id)) continue;
        if (!this.isEnemyNukeSam(sam)) continue;
        seen.add(id);
        found.push(sam);
      }
    }

    /**
     * Find all enemy SAMs whose range covers a given tile.
     */
    // ── findEnemySamsCoveringTile — NationNukeBehavior.ts:1010 ────────────────
    findEnemySamsCoveringTile(tile, includeUnderConstruction = false) {
      const nearbySams = this.game.nearbyUnits(
        tile,
        this.game.config().maxSamRange(),
        UNIT.SAMLauncher,
        undefined,
        includeUnderConstruction,
      );

      const result = [];
      for (const sam of nearbySams) {
        if (!this.isEnemyNukeSam(sam.unit)) continue;
        const range = this.game.config().samRange(sam.unit.level());
        if (sam.distSquared <= range * range) {
          result.push(sam.unit);
        }
      }
      return result;
    }

    // Counterforce ordering: prefer the SAM whose overwhelm is cheapest per
    // unit of target value it shields, so atoms strip the umbrella actually
    // protecting structures instead of a cheap launcher covering nothing.
    // Ascending level order remains the fallback when shielded value is
    // unknowable and the tie-break for equal densities.
    orderCounterforceSams(enemySams, nukeTarget) {
      const structureTypes = [
        UNIT.City, UNIT.DefensePost, UNIT.MissileSilo, UNIT.Port, UNIT.Factory,
      ];
      const shieldedDensity = (sam) => {
        const range = this.game.config().samRange?.(sam.level());
        if (!Number.isFinite(range)) return null;
        let total = 0;
        let counted = false;
        for (const type of structureTypes) {
          for (const unit of nukeTarget.units(type) || []) {
            const distance = this.game.euclideanDistSquared?.(
              sam.tile(), unit.tile(),
            );
            if (distance === undefined) return null;
            if (distance > range * range) continue;
            counted = true;
            total += this.nukeStructureValue(unit);
          }
        }
        return counted ? total / (sam.level() + 1) : null;
      };
      return enemySams.slice().map((sam) => ({
        sam,
        density: shieldedDensity(sam),
      })).sort((a, b) => {
        if (a.density === null && b.density === null) {
          return a.sam.level() - b.sam.level();
        }
        if (a.density === null) return 1;
        if (b.density === null) return -1;
        return b.density - a.density || a.sam.level() - b.sam.level();
      }).map((entry) => entry.sam);
    }

    /**
     * Upgrade a missile silo that would actually have helped the failed
     * overwhelm attempt: trajectory to the failed target is not blocked by
     * non-covering enemy SAMs, and the silo is below the upgrade cap. Among
     * those, picks the one best protected by our own SAMs.
     */
    getRouteEligibleSilos(failedTarget) {
      const coveringSamIds = failedTarget.coveringSamIds ?? new Set(
        this.findEnemySamsCoveringTile(failedTarget.targetTile).map((sam) => sam.id()),
      );
      return this.player.units(UNIT.MissileSilo)
        .filter((silo) => !silo.isUnderConstruction())
        .filter((silo) => !this.isTrajectoryInterceptableBySam(
          silo.tile(), failedTarget.targetTile, coveringSamIds,
        ));
    }

    hasUsefulSiloUpgradeCapacity(silos, failedTarget, planStillMissing = false) {
      const requiredSiloCapacity = Math.max(
        Number(failedTarget.requiredSiloCapacity ?? failedTarget.totalBombs),
        Number(failedTarget.totalBombs),
      );
      const currentSiloCapacity = silos.reduce(
        (sum, silo) => sum + Math.max(1, Number(silo.level() || 1)),
        0,
      );
      const maxCapacity = silos.length * MAX_NATION_SILO_UPGRADE_LEVEL;
      // A partial level still adds a real launch slot even if this set cannot
      // satisfy the whole SAM salvo before another Silo is needed.
      return currentSiloCapacity < maxCapacity &&
        (planStillMissing || currentSiloCapacity < requiredSiloCapacity);
    }

    getPreferredHelpfulSilos(silos, failedTarget) {
      const preferredIds = new Set(
        Array.isArray(failedTarget.unblockedSiloIds)
          ? failedTarget.unblockedSiloIds.map(String)
          : [],
      );
      const preferredSilos = silos.filter((silo) => {
        if (preferredIds.size === 0) return true;
        { return preferredIds.has(String(silo.id())); }
      });
      return preferredSilos.length > 0 ? preferredSilos : silos;
    }

    getSiloProtection(silo, sams) {
      return sams.reduce((protection, sam) => {
          const range = this.game.config().samRange(sam.level());
          const distance = this.game.euclideanDistSquared(silo.tile(), sam.tile());
          return distance <= range * range ? protection + sam.level() : protection;
      }, 0);
    }

    findBestProtectedSilo(silos) {
      const sams = this.player.units(UNIT.SAMLauncher);
      return silos
        .filter((silo) => silo.level() < MAX_NATION_SILO_UPGRADE_LEVEL)
        .map((silo) => ({ silo, protection: this.getSiloProtection(silo, sams) }))
        .sort((a, b) => b.protection - a.protection)[0]?.silo ?? null;
    }

    async actuateSiloUpgrade(silo) {
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(silo.tile(), [UNIT.MissileSilo]),
          WORKER_TIMEOUT_MS, null,
        );
      }
      const buildable = Array.isArray(buildables)
        ? buildables.find((entry) => entry.type === UNIT.MissileSilo)
        : null;
      if (!buildable || buildable.canUpgrade === false) return false;
      const buildMenu = getBuildMenu();
      if (typeof buildMenu?.sendBuildOrUpgrade !== "function") return false;
      if (!sendAutoBotBuildOrUpgrade(buildMenu, buildable, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(tr("☢️ Upgrade silo"), "build");
      return true;
    }
