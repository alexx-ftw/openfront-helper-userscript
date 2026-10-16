      };
    }

    compareMissileDefenseSamUpgrades(left, right) {
      if (right.score !== left.score) return right.score - left.score;
      if (right.marginGain !== left.marginGain) {
        return right.marginGain - left.marginGain;
      }
      if (right.capacityGain !== left.capacityGain) {
        return right.capacityGain - left.capacityGain;
      }
      if (right.interceptedGain !== left.interceptedGain) {
        return right.interceptedGain - left.interceptedGain;
      }
      if (left.cost < right.cost) return -1;
      if (left.cost > right.cost) return 1;
      return 0;
    }

    // Kept as a compatibility name for the Legendary adaptive flow and its
    // existing test surface; the same trajectory-aware action is now also
    // available to the custom win-fix path for the other difficulties.
    async maybeUpgradeLegendarySam() {
      return this.maybeUpgradeMissileDefenseSam();
    }

    // getTotalStructureDensity — NationStructureBehavior.ts:717.
    // src uses unit COUNT (not levels) here — kept on .length.
    getTotalStructureDensity() {
      const tilesOwned = this.player.numTilesOwned();
      return tilesOwned > 0
        ? structuresOfAllTypes(this.player).length / tilesOwned
        : 0; // ignoring levels for structures
    }

    // findBestStructureToUpgrade — NationStructureBehavior.ts:728 (now async).
    // src filters `upgradable = structures.filter(s => player.canUpgradeUnit(s))`
    // synchronously (pre-RNG). The client has no sync canUpgradeUnit, so we PROBE
    // buildables(unit.tile(),[type]) for each candidate FIRST (keeping the
    // BuildableUnit when canUpgrade !== false) BEFORE any RNG draw, preserving the
    // exact src RNG sequence and scoring. Probe candidates in bounded batches;
    // the first 25 preserve the normal structure candidate budget. Returns
    // {structure, bu} | null.
    async findBestStructureToUpgrade(structures) {
      if (structures.length === 0) return null;
      const { upgradable, buByUnitId } =
        await this.probeUpgradableStructures(structures);
      if (upgradable.length === 0) return null;
      const mkResult = (structure) => ({
        structure,
        bu: buByUnitId.get(structure.id()),
      });
      const randomChance = this.structureUpgradeRandomChance();
      if (this.random.nextInt(0, 100) < randomChance) {
        return mkResult(this.random.randElement(upgradable));
      }
      const samLaunchers = this.player.units(UNIT.SAMLauncher);
      const scored = upgradable.map((structure) => ({
        structure,
        score:
          this.structureSamProtectionScore(structure, samLaunchers) +
          this.random.nextInt(0, 5),
      }));
      scored.sort((a, b) => b.score - a.score);
      const selected = this.selectScoredStructureUpgrade(scored);
      return selected ? mkResult(selected) : null;
    }

    async probeUpgradableStructures(structures) {
      const upgradable = [];
      const buByUnitId = new Map();
      const candidates = structures.slice(0, STRUCTURE_PLACEMENT_CANDIDATE_LIMIT);
      for (
        let offset = 0;
        offset < candidates.length;
        offset += STRUCTURE_PROBE_CONCURRENCY
      ) {
        const batch = candidates.slice(
          offset,
          offset + STRUCTURE_PROBE_CONCURRENCY,
        );
        const buildables = await Promise.all(
          batch.map((structure) => {
            const tile = structure.tile();
            if (this.tileInsideActiveHostileMissileImpact(tile)) return null;
            return this.buildableFor(
              structure.type(),
              tile,
              STRUCTURE_PROBE_TIMEOUT_MS,
            );
          }),
        );
        for (let index = 0; index < batch.length; index++) {
          const structure = batch[index];
          const bu = buildables[index];
          if (bu !== null && bu.canUpgrade !== false) {
            upgradable.push(structure);
            buByUnitId.set(structure.id(), bu);
          }
        }
      }
      return { upgradable, buByUnitId };
    }

    structureUpgradeRandomChance() {
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return 70;
        case Difficulty.Medium:
          return 40;
        case Difficulty.Hard:
          return 25;
        case Difficulty.Impossible:
          return 10;
        case Difficulty.Legendary:
          return 0;
        default:
          return 10;
      }
    }

    structureSamProtectionScore(structure, samLaunchers) {
      let score = 0;
      for (const sam of samLaunchers) {
          const samRange = this.legendarySamRange(sam.level());
          const samRangeSquared = samRange * samRange;
          const distSquared = this.game.euclideanDistSquared(
            structure.tile(),
            sam.tile(),
          );
          if (distSquared <= samRangeSquared) {
            // Protected by this SAM, add score based on SAM level.
            score += 10;
            if (sam.level() > 1) {
              score += (sam.level() - 1) * 7.5;
            }
          }
      }
      return score;
    }

    selectScoredStructureUpgrade(scored) {
      if (scored.length === 0) return null;
      // Legendary has already paid to probe and score every legal upgrade.
      // Choosing a lower-ranked structure for variety is strictly dominated:
      // the type, price and added level are identical, while the sorted winner
      // has at least as much SAM protection. Preserve Nation randomness only
      // for the faithful Easy–Impossible modes.
      if (isLegendaryDifficulty(currentDifficulty())) return scored[0].structure;
      // 50% of the time, pick the second or third best for variety.
      if (scored.length >= 2 && this.random.chance(2)) {
        const pickIndex =
          scored.length >= 3
            ? this.random.nextInt(1, 3) // pick index 1 or 2
            : 1; // only index 1 available
        return scored[pickIndex].structure;
      }
      return scored[0].structure;
    }

