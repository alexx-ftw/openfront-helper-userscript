    // structureSpawnTile — NationStructureBehavior.ts:814 (now async).
    // RANK-THEN-PROBE: score ALL candidate tiles SYNC by the src value function,
    // sort DESC, then await buildables down the ranked list and take the FIRST
    // whose BuildableUnit describes construction only. Returns that BuildableUnit | null.
    // (src interleaves the value fn with a SYNC canBuild and short-circuits on the
    // first valid best-value tile; probing in descending value order and taking
    // the first buildable yields the SAME tile src's loop picks — the highest-
    // value buildable in the candidate set.)
    async structureSpawnTile(type, options = {}) {
      const probe = this.structureProbeOptions(options);
      const economicType = ECONOMIC_STRUCTURE_TYPES.includes(type);
      const candidateLimit = economicType
        ? Math.min(
            this.economicPlacementBudgetLimit(probe.candidateLimit),
            ECONOMIC_INITIAL_PLACEMENT_CANDIDATE_LIMIT,
          )
        : probe.candidateLimit;
      if (candidateLimit < 1) return null;
      let tiles = this.structureCandidateTiles(type, options, candidateLimit);
      if (economicType) this.consumeEconomicPlacementBudget(tiles.length);
      if (tiles.length === 0) return null;
      if (type === UNIT.MissileSilo && options.nukeDemandRequest) {
        tiles = this.nukeDemandSiloSpawnTiles(tiles, options.nukeDemandRequest);
        if (tiles.length === 0) return null;
      }
      if (type === UNIT.MissileSilo && options.nukePendingLaunchRoute === true) {
        tiles = tiles.filter((tile) => this.nukePendingLaunchRouteAllowed(tile));
        if (tiles.length === 0) return null;
      }
      const valueFunction = this.structureTileValueFunction(type, options);
      if (valueFunction === null) return null;
      const compactness = this.structurePlacementCompactnessRanker(type);
      const emergency = this.structureMissileEmergency(type, options);
      const { scored, safeScored } = this.rankStructureSpawnTiles(
        type,
        options,
        tiles,
        valueFunction,
        compactness,
      );
      // Do not spend gold on a Factory that can only duplicate routes an
      // existing Factory already serves.  Returning null lets the normal
      // construction order consider City/Port instead, which can create the
      // next paying endpoint.  Keep the fallback when no Factory or no paid
      // endpoint exists yet: those are the cases where a first Factory still
      // has to be allowed.
      if (
        type === UNIT.Factory &&
        !(
          isLegendaryDifficulty() &&
          options.legendaryEconomyFactoryTile !== null &&
          options.legendaryEconomyFactoryTile !== undefined
        ) &&
        safeScored.length > 0 &&
        this.onlyDuplicateFactoryTradeCandidates(safeScored)
      ) {
        return null;
      }
      if (type === UNIT.SAMLauncher && options.prioritizeStructureCoverage) {
        return this.probePriorityStructureCoverageSpawn(
          type,
          scored,
          safeScored,
          probe,
          emergency,
        );
      }
      return this.probeRankedStructureTiles(scored, type, probe, emergency);
    }

    rankStructureSpawnTiles(type, options, tiles, valueFunction, compactness) {
      const protectedSamTiles =
        type === UNIT.SAMLauncher && options.activeMissileDefense !== true
          ? this.samProtectableStructureTiles()
          : null;
      let safeScored = tiles
        .map((t) => ({
          t,
          v: valueFunction(t),
          compactness: compactness?.(t) ?? null,
        }))
        .filter(({ t }) => !this.isDangerousStructureTile(t, type));
      // A Factory only earns when it can send trains to a City or Port.  When
      // at least one safe candidate reaches a paid destination that every
      // existing Factory misses, suppress the candidates that merely duplicate
      // an already-served commercial pocket.  This keeps ordinary spacing as
      // the tie-breaker, but prevents a nearby duplicate Factory from beating
      // an expansion that actually opens a new route.
      if (
        type === UNIT.Factory &&
        isLegendaryDifficulty() &&
        !(
          options.legendaryEconomyFactoryTile !== null &&
          options.legendaryEconomyFactoryTile !== undefined
        ) &&
        safeScored.length > 0
      ) {
        safeScored = this.novelFactoryTradeCandidates(safeScored);
      }
      let scored = safeScored.filter(
        ({ t }) =>
          protectedSamTiles === null ||
          this.samPlacementProtectsStructure(t, protectedSamTiles),
      );
      // A live hostile impact can leave every tile that still covers the
      // current economic core unsafe. Do not place the SAM in that blast, but
      // also do not let a doomed core suppress every safe defensive foothold:
      // the launcher is needed to protect the reconstruction immediately
      // after impact. Outside this explicit emergency we retain the strict
      // central-cluster requirement.
      if (this.shouldUseSafeSamReconstructionFallback(type, options, scored)) {
        scored = safeScored;
      }
      scored.sort((a, b) => this.compareStructurePlacementScores(a, b));
      return { scored, safeScored };
    }

    async probePriorityStructureCoverageSpawn(
      type,
      scored,
      safeScored,
      probe,
      emergency,
    ) {
      const localResult = await this.probeCoveragePrioritySamTiles(
        scored,
        type,
        probe.probeTimeoutMs,
        emergency,
      );
      if (localResult.handled) return localResult.buildable;
      const remaining = this.unattemptedPriorityStructureTiles(scored, localResult);
      const strictBuildable = await this.probeRankedStructureTiles(
        remaining,
        type,
        probe,
        emergency,
      );
      if (strictBuildable !== null) return strictBuildable;
      // Prefer the expensive core, but never turn a verified failure of every
      // core-covering site into permanent missile helplessness. This only
      // applies while replacing a missing first SAM; normal SAM placement
      // remains strictly centred on protectable structures.
      if (!this.shouldRetryFirstSamWithSafeCandidates(type, emergency, scored, safeScored)) {
        return null;
      }
      return this.probeRankedStructureTiles(safeScored, type, probe, emergency);
    }

    unattemptedPriorityStructureTiles(scored, localResult) {
      const attemptedTiles = localResult.attemptedTiles;
      if (!(attemptedTiles instanceof Set) || attemptedTiles.size === 0) {
        return scored;
      }
      return scored.filter(({ t }) => !attemptedTiles.has(t));
    }

    shouldRetryFirstSamWithSafeCandidates(type, emergency, scored, safeScored) {
      return (
        type === UNIT.SAMLauncher &&
