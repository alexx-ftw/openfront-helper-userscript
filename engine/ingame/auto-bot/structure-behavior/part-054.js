            { protectedStructureSnapshots, mySid },
          );
          continue;
        }
        if (
          typeof this.game.ownerID !== "function" ||
          this.game.ownerID(targetTile) === mySid
        ) {
          demands.push({
            missile,
            type: UNIT.MIRVWarhead,
            targetTile,
            deadlineTick,
            exactDestination: true,
          });
        }
      }
      return demands;
    }

    appendMirvDefenseDemands(
      demands,
      missile,
      targetTile,
      deadlineTick,
      { protectedStructureSnapshots, mySid },
    ) {
      const demandCount = demands.length;
      this.appendMirvCarrierSiteDemands(
        demands,
        missile,
        targetTile,
        deadlineTick,
        protectedStructureSnapshots,
      );
      if (
        demands.length === demandCount &&
        this.activeMissileTargetsOwnedTerritory(targetTile, mySid)
      ) {
        demands.push({
          missile,
          type: UNIT.MIRV,
          targetTile,
          deadlineTick,
          carrierPreparation: true,
          exactDestination: true,
        });
      }
    }

    mirvProtectedStructureSnapshots(snapshots, structures) {
      return snapshots ?? this.snapshotMirvProtectedStructures(structures);
    }

    snapshotMirvProtectedStructures(structures) {
      const snapshots = [];
      for (const structure of structures || []) {
        snapshots.push({
          tile: structure.tile?.(),
          id: structure.id?.(),
        });
      }
      return snapshots;
    }

    activeMirvDeadlineTick(missile, fromTile, targetTile) {
      const motion = this.legendaryActiveMissileMotion(missile, fromTile);
      return Math.max(
        0,
        Number(
          motion?.impactTick ??
            this.legendaryNukeFlightTime(fromTile, targetTile),
        ),
      );
    }

    appendMirvCarrierSiteDemands(
      demands,
      missile,
      carrierTargetTile,
      deadlineTick,
      protectedStructureSnapshots = null,
    ) {
      const radiusSquared = MIRV_CARRIER_TARGET_RADIUS ** 2;
      const snapshots =
        protectedStructureSnapshots ??
        this.snapshotMirvProtectedStructures(
          this.player.units(
            UNIT.City,
            UNIT.Factory,
            UNIT.Port,
            UNIT.MissileSilo,
          ) ?? [],
        );
      for (const snapshot of snapshots) {
        const structureTile = snapshot.tile;
        if (structureTile === null || structureTile === undefined) continue;
        if (
          this.game.euclideanDistSquared(carrierTargetTile, structureTile) >
          radiusSquared
        ) continue;
        demands.push({
          missile,
          type: UNIT.MIRV,
          targetTile: structureTile,
          deadlineTick,
          carrierPreparation: true,
          protectedStructureId: snapshot.id,
        });
      }
    }

    activeMirvDemandResultCache(context) {
      if (
        !context ||
        (typeof context !== "object" && typeof context !== "function")
      ) {
        return null;
      }
      if (!(this._activeMirvDemandResultCache instanceof WeakMap)) {
        this._activeMirvDemandResultCache = new WeakMap();
      }
      return this._activeMirvDemandResultCache;
    }

    uncoveredActiveMirvDemands(context) {
      const cache = this.activeMirvDemandResultCache(context);
      const cached = cache?.get(context);
      if (cached !== undefined) return cached;
      const samProfiles = Array.isArray(context?.samProfiles)
        ? context.samProfiles
        : null;
      const demands = context?.mirvDemands || [];
      const covered = this.activeMirvCoveredDemandKeys(demands, samProfiles);
      const uncovered = demands.filter((demand) => !covered.has(demand));
      cache?.set(context, uncovered);
      return uncovered;
    }

    activeMirvDemandCovered(demand, samProfiles = null) {
      return this.activeMirvCoveredDemandKeys([demand], samProfiles).has(demand);
    }

    activeMirvCoveredDemandKeys(demands, samProfiles = null) {
      if (!Array.isArray(demands) || demands.length === 0) return new Set();
      const profiles = Array.isArray(samProfiles)
        ? samProfiles
        : this.legendaryFriendlySamProfiles();
      if (!Array.isArray(profiles) || profiles.length === 0) return new Set();

      // One MIRV carrier can create several protected-site demands, but one
      // interception destroys the carrier and satisfies all of them. Build one
      // route per live missile, then schedule every distinct carrier/warhead
      // together so the same SAM slot cannot defend two simultaneous threats.
      const demandGroups = this.groupActiveMirvDemands(demands);
      const routes = this.legendaryMirvDemandRoutes(demandGroups, profiles);
      const coveredMissileKeys = this.legendaryCoveredMirvMissileKeys(
        routes,
        profiles,
      );
