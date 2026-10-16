      const siloReachContext =
        type === UNIT.MissileSilo ? this.legendarySiloReachContext() : null;
      const placementScoreCache = new Map();

      return (tile) => {
        if (placementScoreCache.has(tile)) {
          return placementScoreCache.get(tile);
        }
        const base = baseValue(tile);
        const missileRisk = Math.min(
          1,
          this.legendaryMissilePlacementRisk(tile, type, missileContext),
        );
        let value = base;

        // A City/Factory/Port/Silo is productive only while it survives. Keep
        // the engine's exact placement value, then discount tiles that let one
        // feasible enemy blast remove a large fraction of our production.
        if (type !== UNIT.SAMLauncher) {
          value -= missileRisk * Math.max(spacing, Math.abs(base) * 0.8);
        }

        if (type === UNIT.Port) {
          value += this.legendaryRailConnectivityPlacementScore(tile);
        }

        // City placement parity with Port: the construction priority vector
        // already values cities by cityRailConnection and connectedCities (see
        // legendaryConstructionObjectiveVector), but the engine's cityValue only
        // scores the single commercial route via commercialRailPlacementScore.
        // Rewarding tiles that reach multiple distinct rail clusters — the same
        // multi-cluster connectivity bonus Port enjoys — keeps tile selection
        // aligned with the priority that picked the type. A City that joins an
        // existing rail network is worth more than an isolated one even when
        // both score equally on elevation and border spacing.
        if (type === UNIT.City) {
          value += this.legendaryRailConnectivityPlacementScore(tile);
        }

        if (
          type === UNIT.City ||
          type === UNIT.Factory ||
          type === UNIT.Port
        ) {
          value += this.legendaryAllySupportPlacementScore(
            tile,
            type,
            allyPlacementContext,
          );
          value += this.legendaryTeamCenterPlacementScore(
            tile,
            teamCenterContext,
          );
        }

        // A Silo's defensive umbrella (samCoverageBonus) already dominates
        // placement. Among tiles that are equally defended, prefer one that
        // reaches a hostile center with a shorter flight: less warning time,
        // less SAM reload window, and a wider choice of impact points. The
        // bonus is deliberately small relative to the SAM-coverage base so it
        // only breaks ties between well-defended candidates, never pulling a
        // silo out of its own SAM umbrella.
        if (type === UNIT.MissileSilo && siloReachContext !== null) {
          value += this.legendarySiloOffensiveReachScore(
            tile,
            siloReachContext,
            spacing,
          );
        }

        if (type === UNIT.SAMLauncher) {
          // SAMs are not a production axis. Their placement is judged by how
          // much uncovered production they protect and by whether they sit on
          // feasible enemy missile trajectories.
          value += this.legendarySamCoveragePlacementScore(
            tile,
            missileContext,
            samCoverageContext,
          );
          if (missileContext.critical) value += spacing * 2;
        }

        placementScoreCache.set(tile, value);
        return value;
      };
    }

    legendaryTrainStationRanges() {
      const config = this.game.config();
      if (
        config === this._legendaryTrainStationRangesConfig &&
        this._legendaryTrainStationRangesCache !== undefined
      ) {
        return this._legendaryTrainStationRangesCache;
      }
      const minRange = config.trainStationMinRange();
      const maxRange = config.trainStationMaxRange();
      const ranges = {
        minRangeSquared: minRange ** 2,
        maxRangeSquared: maxRange ** 2,
        maxRange,
      };
      this._legendaryTrainStationRangesConfig = config;
      this._legendaryTrainStationRangesCache = ranges;
      return ranges;
    }

    legendaryRailConnectivityPlacementScore(tile) {
      {
        const ranges = this.legendaryTrainStationRanges();
        const stations = this.getOrBuildReachableStations();
        const score = this.computeConnectivityScore(
          tile,
          stations,
          ranges.minRangeSquared,
          ranges.maxRangeSquared,
        );
        return score * this.spacingConstants().structureSpacing;
      }
    }

    // Snapshot of hostile player territory centres, reused across every silo
    // candidate tile in one placement decision. A silo that can reach a hostile
    // center with a shorter flight gives the opponent less reaction time and a
    // narrower SAM-reload window, so distance to the nearest hostile center is
    // a clean offensive signal. The snapshot is cached per tick so the per-tile
    // scorer never rescans the roster.
    legendarySiloReachContext() {
      const tick = this.game.ticks();
      if (
        this._legendarySiloReachTick === tick &&
        this._legendarySiloReachContext !== undefined
      ) {
        return this._legendarySiloReachContext;
      }
      this._legendarySiloReachTick = tick;
      // liveNuclearHostilePlayers is a pure roster read against the cached
      // hostile snapshot; guard defensively against a missing roster method
      // (an early-tick view) by falling back to an empty list rather than
      // throwing inside the placement path. Production code must not swallow
      // exceptions (the headless-simulation contract requires failures to
      // propagate), so guard on the method presence instead.
      const hostile =
        typeof this.liveNuclearHostilePlayers === "function"
          ? this.liveNuclearHostilePlayers() ?? []
          : [];
      const centers = [];
      for (const enemy of hostile) {
        const location = enemy?.nameLocation?.();
        if (!location) continue;
        const x = Number(location.x);
        const y = Number(location.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          centers.push({ x, y });
        }
      }
      // The reference distance normalizes the bonus so a candidate on the
      // frontier (close to a hostile center) earns most of the bonus while one
      // deep in the rear (far from every hostile) earns little. Use a generous
      // reference so the term stays a tie-breaker, not a dominant axis.
