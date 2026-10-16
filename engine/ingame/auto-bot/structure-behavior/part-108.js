      if (this.tileInsideActiveHostileMissileImpact(tile)) {
        return false;
      }
      if (emergency.recoverySam === true) {
        return true;
      }
      if (emergency.incrementalSamDefense !== true) {
        return this.legendarySamConstructionSafeForTile(tile, emergency.context);
      }
      // Candidate scoring and coverage probing may revisit the same snapped
      // tile during one immutable missile-defense snapshot. A full trajectory
      // evaluation is expensive, so memoize only within that snapshot; a new
      // tick/fingerprint gets a fresh emergency object and recalculates it.
      const cache =
        emergency.activeSamTileAllowedCache ||
        (emergency.activeSamTileAllowedCache = new Map());
      if (cache.has(tile)) return cache.get(tile);
      const allowed = this.activeMissileSamConstructionImproves(
        tile,
        emergency.context,
        emergency.evaluation,
      );
      cache.set(tile, allowed);
      return allowed;
    }

    isUsableStructureBuildable(buildable, tile, type) {
      return Boolean(
        buildable !== null &&
          buildable !== undefined &&
          buildable.canBuild !== false &&
          buildable.canBuild !== null &&
          buildable.canBuild !== undefined &&
          // The client BuildMenu sends an upgrade before it considers canBuild.
          // A fresh construction must therefore reject a hybrid descriptor even
          // if the worker also found a snapped construction tile nearby.
          buildable.canUpgrade === false &&
          this.isSafeBuildablePlacement(buildable, tile, type),
      );
    }

    /**
     * Keep ordinary structures off an active hostile frontier. Defense posts
     * are deliberately exempt: their purpose is to fortify that exact front.
     * Unknown ownership data fails open so older clients retain their existing
     * placement behavior instead of disabling construction entirely.
     */
    isDangerousStructureTile(tile, type) {
      if (tile === null || tile === undefined) return false;
      // Never spend on a structure that an already in-flight hostile missile
      // will destroy. This applies to every difficulty and to Defense Posts;
      // their frontier exemption is unrelated to blast safety.
      if (this.tileInsideActiveHostileMissileImpact(tile)) return true;
      if (type === UNIT.DefensePost) return false;
      const game = this.game;
      if (
        !game ||
        typeof game.neighbors !== "function" ||
        typeof game.ownerID !== "function" ||
        typeof game.playerBySmallID !== "function"
      ) {
        return false;
      }
      const mySid = this.player.smallID();
      {
        for (const neighbor of game.neighbors(tile) || []) {
          if (this.isHostileStructureNeighbor(neighbor, mySid)) return true;
        }
      }
      return false;
    }

    isHostileStructureNeighbor(tile, mySid) {
      const ownerSid = this.game.ownerID(tile);
      if (ownerSid === mySid || ownerSid === null || ownerSid === undefined) {
        return false;
      }
      const owner = this.game.playerBySmallID(ownerSid);
      if (!owner || owner.isPlayer?.() === false) return false;
      return !(
        this.player.isFriendly?.(owner) === true ||
        this.player.isOnSameTeam?.(owner) === true
      );
    }

    isSafeBuildablePlacement(buildable, requestedTile, type) {
      const resolvedTile =
        buildable &&
        buildable.canBuild !== true &&
        buildable.canBuild !== false &&
        buildable.canBuild !== null &&
        buildable.canBuild !== undefined
          ? buildable.canBuild
          : requestedTile;
      return !this.isDangerousStructureTile(resolvedTile, type);
    }

    /**
     * Client-side reconstruction of PlayerImpl.validStructureSpawnTiles().
     * Returns the nearest legal snapped tile, false when none exists, and null
     * only when the public snapshot lacks a primitive needed for exact parity.
     */
    localLandStructureSpawnTile(tile) {
      const game = this.game;
      if (!this.hasLocalStructurePlacementApi(game, tile)) return null;

      const setup = this.localStructurePlacementSetup(game, tile);
      if (setup === null || setup === false) return setup;

      const nearbyUnits = this.localNearbyStructures(game, tile);
      if (!Array.isArray(nearbyUnits)) return null;

      const ownedNearbyTiles = this.localOwnedStructureTiles(
        game,
        tile,
        setup.mySid,
      );
      if (ownedNearbyTiles === null) return null;

      const validTiles = ownedNearbyTiles.filter((candidate) =>
        this.isLocallyStructureSpaced(
          game,
          candidate,
          nearbyUnits,
          setup.structureMinDist ** 2,
        ),
      );
      validTiles.sort(
        (left, right) =>
          game.euclideanDistSquared(left, tile) -
          game.euclideanDistSquared(right, tile),
      );
      return validTiles[0] ?? false;
    }

    hasLocalStructurePlacementApi(game, tile) {
      return (
        tile !== null &&
        tile !== undefined &&
        game &&
        typeof game.ownerID === "function" &&
        typeof game.neighbors === "function" &&
        typeof game.euclideanDistSquared === "function" &&
        typeof game.nearbyUnits === "function" &&
        typeof game.config === "function"
      );
    }

    localStructurePlacementSetup(game, tile) {
      {
        const mySid = this.player.smallID();
        const config = game.config();
        if (typeof config?.structureMinDist !== "function") return null;
        const structureMinDist = Number(config.structureMinDist());
        if (!Number.isFinite(structureMinDist) || structureMinDist < 0) return null;
        if (game.ownerID(tile) !== mySid) return false;
        return { mySid, structureMinDist };
      }
    }

