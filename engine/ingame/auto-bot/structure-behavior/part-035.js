        return;
      }
      entries.push({ sam, tile, level: level / 2 });
    }

    hydrogenStructureCoverageInputs() {
      if (
        !state.settings.winFixes ||
        !autoBotBuildAllowed(UNIT.SAMLauncher)
      ) {
        return null;
      }
      const hostileSiloLevelSum = this.hostileSiloLevelSumTarget();
      if (hostileSiloLevelSum < HOSTILE_SILO_SAM_COVERAGE_LEVEL_SUM_THRESHOLD) {
        return null;
      }
      const config = this.hydrogenCoverageConfig();
      if (config === null) return null;
      const structures = this.ownedStructureTiles();
      if (structures.length === 0) return null;
      const clanmateStructures = this.clanmateStructureTiles();
      const protectedTiles = structures.concat(clanmateStructures);
      const sams = [];
      for (const sam of this.player.units(UNIT.SAMLauncher) || []) {
        if (!this.isBuiltActiveSam(sam)) continue;
        const tile = sam.tile();
        const level = Math.max(1, Math.floor(Number(sam.level?.() ?? 1)));
        if (tile === null || tile === undefined || !Number.isFinite(level)) continue;
        sams.push({ sam, tile, level });
      }
      const alliedSams = this.alliedCoverageSamEntries();
      const coverageSams = sams.concat(alliedSams);
      return {
        config,
        structures: protectedTiles,
        sams: coverageSams,
        key: [
          hostileSiloLevelSum,
          protectedTiles.join(","),
          coverageSams
            .map(({ sam, tile, level }, index) =>
              [sam.id?.() ?? index, tile, level].join(":"),
            )
            .join(","),
        ].join("|"),
      };
    }

    computeHydrogenStructureCoveragePlan(input = null) {
      const coverage = input || this.hydrogenStructureCoverageInputs();
      if (coverage === null) return null;
      const { config, structures, sams } = coverage;
      if (sams.length === 0) return { needsNewSam: true };
      if (
        this.hydrogenCoveredStructureCount(sams, structures, config) ===
        structures.length
      ) return null;
      return (
        this.bestHydrogenCoverageUpgrade(sams, structures, config) || {
          needsNewSam: true,
        }
      );
    }

    hydrogenCoverageConfig() {
      {
        const config = this.game.config();
        if (config.isUnitDisabled(UNIT.SAMLauncher)) return null;
        if (config.isUnitDisabled(UNIT.HydrogenBomb)) return null;
        return typeof config.samRange === "function" ? config : null;
      }
    }

    ownedStructureTiles() {
      const tiles = [];
      for (const type of STRUCTURES_TYPES) {
        {
          for (const structure of this.player.units(type) || []) {
            const tile = structure.tile();
            if (tile !== null && tile !== undefined) tiles.push(tile);
          }
        }
      }
      return tiles;
    }

    // Goal rule: clanmates' buildings count as our own for protection. The
    // hydrogen-coverage SAM plan seeds clanmate structure tiles alongside
    // ours so a launcher sited to cover the cluster defends both. Tag reads
    // go through the shared spawn-objective API (client-side inference from
    // clanTag / displayName "[TAG] name"), absent API = no clanmates.
    clanmateStructureTiles() {
      const objectiveApi =
        typeof globalThis === "object" ? globalThis.__OFHSpawnObjective : null;
      if (
        !objectiveApi ||
        typeof objectiveApi.getPlayerClanTag !== "function" ||
        typeof objectiveApi.sameClanTag !== "function"
      ) {
        return [];
      }
      const myTag = objectiveApi.getPlayerClanTag(this.player);
      if (myTag === null) return [];
      const tiles = [];
      for (const other of this.game.players()) {
        if (this.playerSharesMyClanTag(objectiveApi, other, myTag)) {
          tiles.push(...this.playerStructureTiles(other));
        }
      }
      return tiles;
    }

    playerSharesMyClanTag(objectiveApi, other, myTag) {
      if (other === this.player || other.isAlive?.() === false) return false;
      return objectiveApi.sameClanTag(
        objectiveApi.getPlayerClanTag(other),
        myTag,
      );
    }

    playerStructureTiles(player) {
      const tiles = [];
      for (const type of STRUCTURES_TYPES) {
        for (const structure of player.units?.(type) || []) {
          const tile = structure.tile?.();
          if (tile !== null && tile !== undefined) tiles.push(tile);
        }
      }
      return tiles;
    }

    isBuiltActiveSam(sam) {
      {
        if (sam.isUnderConstruction && sam.isUnderConstruction()) return false;
        return !sam.isActive || sam.isActive() !== false;
      }
    }

    samCriticalCoverageScore(sam, level) {
      const tile = sam?.tile?.();
      const config = this.game?.config?.();
      if (tile === null || tile === undefined || !config) return 0;
      const rangeSquared = this.samRangeSquared(config, level);
      if (rangeSquared <= 0) return 0;
      return this.samCriticalCoverageScoreForEntries(
        tile,
        rangeSquared,
        this.samCriticalStructureEntries(),
      );
    }

    samCriticalStructureEntries() {
      const entries = [];
      for (const type of SAM_PROTECTABLE_STRUCTURE_TYPES) {
        for (const structure of this.player.units(type) || []) {
          const tile = structure?.tile?.();
          if (tile === null || tile === undefined) continue;
          entries.push({ tile, weight: this.samCriticalStructureWeight(structure) });
        }
      }
