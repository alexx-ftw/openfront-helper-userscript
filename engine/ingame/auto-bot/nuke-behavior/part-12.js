      // Parabola samples are at most one missile-speed apart; +2 covers tile rounding.
      const searchRange = maxRange + Math.ceil((speed + 2) * stride);
      if (!Number.isFinite(searchRange)) return null;
      const candidates = new Map();
      const addNearby = (tile) => {
        for (const sam of this.game.nearbyUnits(
          tile,
          searchRange,
          UNIT.SAMLauncher,
          undefined,
          includeUnderConstruction,
        )) {
          const unit = sam.unit;
          candidates.set(unit.id?.() ?? unit, unit);
        }
      };
      for (let index = 0; index < trajectory.length; index += stride) {
        addNearby(trajectory[index]);
      }
      const lastIndex = trajectory.length - 1;
      if (lastIndex % stride !== 0) addNearby(trajectory[lastIndex]);
      return [...candidates.values()];
    }

    hasReachableSamAtTrajectoryIndex(
      coverageTile,
      trajectory,
      interceptionIndex,
      excludedSamIds,
      {
        interceptingSams = null,
        includeUnderConstruction = false,
        candidateSamUnits = null,
      } = {},
    ) {
      const maxRange = this.game.config().maxSamRange();
      const nearbySams = candidateSamUnits === null
        ? this.game.nearbyUnits(
            coverageTile,
            maxRange,
            UNIT.SAMLauncher,
            undefined,
            includeUnderConstruction,
          )
        : candidateSamUnits;
      let interceptable = false;
      for (const candidate of nearbySams) {
        const sam = candidateSamUnits === null
          ? candidate
          : {
              unit: candidate,
              distSquared: this.game.euclideanDistSquared(
                coverageTile,
                candidate.tile(),
              ),
            };
        if (sam.distSquared > maxRange * maxRange) continue;
        if (!this.isHostileSamIntercept(sam, excludedSamIds)) continue;
        if (!this.canSamReachTrajectoryIndex(sam, trajectory, interceptionIndex)) continue;
        if (interceptingSams === null) return true;
        interceptingSams.add(sam.unit);
        interceptable = true;
      }
      return interceptable;
    }

    hasFinalExplosionSamInterception(
      trajectory,
      untargetable,
      excludedSamIds,
      options = {},
    ) {
      const finalIndex = trajectory.length - 1;
      const penultimateIndex = finalIndex - 1;
      if (penultimateIndex < 0) return false;
      if (!this.isTrajectoryIndexTargetable(finalIndex, untargetable)) return false;
      if (!this.isTrajectoryIndexTargetable(penultimateIndex, untargetable)) return false;
      return this.hasReachableSamAtTrajectoryIndex(
        trajectory[finalIndex],
        trajectory,
        penultimateIndex,
        excludedSamIds,
        options,
      );
    }

    getNukeTrajectory(spawnTile, targetTile) {
      const tick = this.game.ticks();
      if (this._nukeTrajectoryCacheTick !== tick) {
        this._nukeTrajectoryCacheTick = tick;
        this._nukeTrajectoryCache = new Map();
      }
      let destinations = this._nukeTrajectoryCache.get(spawnTile);
      if (!destinations) {
        destinations = new Map();
        this._nukeTrajectoryCache.set(spawnTile, destinations);
      }
      if (!destinations.has(targetTile)) {
        const pathFinder = UniversalPathFinding.Parabola(this.game, {
          increment: this.game.config().defaultNukeSpeed(),
          distanceBasedHeight: true,
          directionUp: true,
        });
        destinations.set(targetTile, pathFinder.findPath(spawnTile, targetTile) ?? []);
      }
      return destinations.get(targetTile);
    }

    // ── isTrajectoryInterceptableBySam — NationNukeBehavior.ts:547 ────────────
    // mirroring NukeTrajectoryPreviewLayer.ts logic a bit
    isTrajectoryInterceptableBySam(
      spawnTile,
      targetTile,
      excludedSamIds,
      options = {},
    ) {
      const { interceptingSams = null } = options;
      // Reuse only route geometry per tick; SAM interception is checked live on every call.
      const trajectory = this.getNukeTrajectory(spawnTile, targetTile);
      if (trajectory.length === 0) return false;
      const candidateSamUnits = this.collectTrajectorySamCandidates(
        trajectory,
        options.includeUnderConstruction === true,
      );
      const interceptionOptions = candidateSamUnits === null
        ? options
        : { ...options, candidateSamUnits };
      const untargetable = this.findUntargetableTrajectoryRange(
        trajectory, spawnTile, targetTile,
      );

      // NukeExecution advances before SAMMissileExecution, so the explosion
      // tick itself cannot be intercepted. Mirror SAMTargetingSystem's
      // flight-time test for every earlier targetable trajectory tile.
      const lastInterceptableIndex = trajectory.length - 2;
      let interceptable = false;
      for (let i = 0; i <= lastInterceptableIndex; i++) {
        if (!this.isTrajectoryIndexTargetable(i, untargetable)) continue;
        if (
          this.hasReachableSamAtTrajectoryIndex(
            trajectory[i],
            trajectory,
            i,
            excludedSamIds,
            interceptionOptions,
          )
        ) {
          if (interceptingSams === null) return true;
          interceptable = true;
        }
      }

      // If the detonation tile is covered, the engine makes one final attempt
      // against the preceding in-flight tile, even when that tile lies outside
      // the SAM's geometric range.
      return this.hasFinalExplosionSamInterception(
        trajectory,
        untargetable,
        excludedSamIds,
        interceptionOptions,
      ) || interceptable;
    }

    // ── isValidNukeTile — NationNukeBehavior.ts:630 ───────────────────────────
    isValidNukeTile(t, nukeTarget) {
      const difficulty = currentDifficulty();

      const owner = this.game.owner(t);
      // src: `if (owner === nukeTarget) return true;` — identity compare. owner is
      // a wrapped player (or TN passthrough). Compare via smallID when both are
      // players; nukeTarget is always a player here.
      if (
        owner &&
        owner.isPlayer &&
        owner.isPlayer() &&
        owner.smallID() === nukeTarget.smallID()
      ) {
        return true;
      }
      // On Hard & Impossible, allow TerraNullius (hit small islands) and other
      // players unless they are teammates or allies (even AFK ones).
      // DIVERGENCE: Legendary is a port-level superset of upstream's
      // Hard‖Impossible ladder, so the gate applies there too.
      if (
        isAtLeastHardDifficulty(difficulty) &&
        (!(owner && owner.isPlayer && owner.isPlayer()) ||
          !this.player.isFriendly(owner, true))
      ) {
        return true;
      }
