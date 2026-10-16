        !owner ||
        owner.smallID() === mySid ||
        playersArePermanentTeammates(this.player, owner)
      ) {
        return null;
      }
      const targetTile = nuke.targetTile();
      const fromTile = nuke.tile();
      if (targetTile === null || targetTile === undefined) return null;
      if (fromTile === null || fromTile === undefined) return null;
      const type = nuke.type();
      if (!this.isNuclearMissileType(type)) return null;
      const radius = this.activeMissileBlastRadius(type, context);
      const exposure = this.legendaryActiveMissileExposure(
        targetTile,
        radius,
        context.structures,
        {
          structureValues: context.structureValues,
          structureTiles: context.structureTiles,
          exposureCache: this.activeMissileExposureCache(context),
        },
      );
      const targetsOwnedTerritory = this.activeMissileTargetsOwnedTerritory(
        targetTile,
        mySid,
      );
      // Nuclear strikes can sever the only territorial bridge and trigger
      // cluster cleanup even when no City/Factory/Port/Silo is inside the
      // blast. Owned land is therefore a first-class defensive asset.
      if (exposure.count === 0 && !targetsOwnedTerritory) return null;
      this.addActiveMissileTerritoryExposure(
        exposure,
        targetsOwnedTerritory,
        context.totalValue,
      );
      return this.legendaryScoredActiveMissileThreat({
        nuke,
        fromTile,
        targetTile,
        type,
        radius,
        exposure,
        context,
        samProfiles,
      });
    }

    isNuclearMissileType(type) {
      return (
        type === UNIT.AtomBomb ||
        type === UNIT.HydrogenBomb
      );
    }

    activeMissileBlastRadius(type, context) {
      if (type === UNIT.HydrogenBomb) return context.hydrogenRadius;
      const configured = Number(this.game.config().nukeMagnitudes?.(type)?.outer);
      return Number.isFinite(configured) && configured > 0
        ? configured
        : context.atomRadius;
    }

    activeMissileTargetsOwnedTerritory(targetTile, mySid) {
      return (
        typeof this.game.ownerID === "function" &&
        this.game.ownerID(targetTile) === mySid
      );
    }

    addActiveMissileTerritoryExposure(exposure, targetsOwnedTerritory, totalValue) {
      if (!targetsOwnedTerritory || exposure.value !== 0) return;
      exposure.value = Math.max(1, Number(totalValue || 0));
      exposure.targetsOwnedTerritory = true;
    }

    activeMissileExposureCache(context) {
      if (
        !context ||
        (typeof context !== "object" && typeof context !== "function")
      ) {
        return null;
      }
      if (!(context._legendaryActiveMissileExposureCache instanceof Map)) {
        context._legendaryActiveMissileExposureCache = new Map();
      }
      return context._legendaryActiveMissileExposureCache;
    }

    activeMissileExposureCacheHit(cache, targetTile, radius) {
      if (!(cache instanceof Map)) return null;
      return cache.get(targetTile)?.get(radius) ?? null;
    }

    rememberActiveMissileExposure(cache, targetTile, radius, exposure) {
      if (!(cache instanceof Map)) return;
      let targetCache = cache.get(targetTile);
      if (!(targetCache instanceof Map)) {
        targetCache = new Map();
        cache.set(targetTile, targetCache);
      }
      targetCache.set(radius, exposure);
    }

    legendaryActiveMissileExposure(
      targetTile,
      radius,
      structures,
      {
        structureValues = null,
        structureTiles = null,
        exposureCache = null,
      } = {},
    ) {
      const cached = this.activeMissileExposureCacheHit(
        exposureCache,
        targetTile,
        radius,
      );
      if (cached !== null) return cached;
      const radiusSquared = radius * radius;
      let value = 0;
      let count = 0;
      for (const structure of structures) {
        const structureTile = structureTiles?.has(structure)
          ? structureTiles.get(structure)
          : structure.tile();
        if (
          this.game.euclideanDistSquared(targetTile, structureTile) > radiusSquared
        ) continue;
        value +=
          structureValues?.get(structure) ??
          this.legendaryCriticalStructureValue(structure);
        count++;
      }
      const exposure = { value, count, radiusSquared };
      this.rememberActiveMissileExposure(
        exposureCache,
        targetTile,
        radius,
        exposure,
      );
      return exposure;
    }

    legendaryScoredActiveMissileThreat(input) {
      const motion = this.legendaryActiveMissileMotion(input.nuke, input.fromTile);
      const flightTimeTicks =
        motion?.impactTick ??
        this.legendaryNukeFlightTime(input.fromTile, input.targetTile);
      const interceptionCapacity =
        this.legendaryCachedSamInterceptionCapacity(
          input.fromTile,
          input.targetTile,
          input.context,
          input.samProfiles,
        );
      const nukeId =
        typeof input.nuke.id === "function" ? input.nuke.id() : "active-missile";
      const route = this.legendaryBuildMissileRoute(
