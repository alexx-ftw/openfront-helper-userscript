      for (const entry of priorityEntries) {
        priorityUnits.push(entry.unit);
      }
      const missileTargetEntriesCache = new Map();
      const missileTargetOrderingCache = new Map();
      const launchMetadataCache = new Map();
      const candidateShotPlanCache = new Map();
      const interceptionCapacityCache = new Map();
      const context = {
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        structures,
        structureValues,
        structureTiles,
        missileTargetEntriesCache,
        missileTargetOrderingCache,
        launchMetadataCache,
        candidateShotPlanCache,
        interceptionCapacityCache,
        totalValue,
        priorityStructures: priorityUnits,
      };
      this.rememberLegendaryMissilePlacementBaseContext(
        game,
        config,
        tick,
        context,
      );
      return context;
    }

    legendaryEnemyMissileThreat(enemy, base, samProfiles) {
      const resources = this.legendaryEnemyMissileResources(enemy);
      if (resources === null || resources.enemySilos.length === 0) return null;
      const { enemyGold, enemySilos, enemySiloLevels } = resources;
      const enemyReadyShots = this.legendaryReadyShotTotal(
        enemySilos,
        base.launchMetadataCache,
      );
      const canHydrogen =
        base.hydrogenCost > 0n && enemyGold >= base.hydrogenCost;
      const canAtom = base.atomCost > 0n && enemyGold >= base.atomCost;
      if (!canHydrogen && !canAtom) return null;
      const weapon = canHydrogen ? UNIT.HydrogenBomb : UNIT.AtomBomb;
      const radius = canHydrogen ? base.hydrogenRadius : base.atomRadius;
      const targets = this.legendaryMissileTargetCandidates(
        base.structures,
        enemySilos,
        radius,
        base.totalValue,
        {
          structureValues: base.structureValues,
          structureTiles: base.structureTiles,
          entryCache: base.missileTargetEntriesCache,
          orderingCache: base.missileTargetOrderingCache,
        },
      );
      let bestTarget = null;
      for (const target of targets) {
        const candidate = this.legendaryScoredEnemyMissileTarget({
          enemy,
          enemyGold,
          enemySilos,
          enemySiloLevels,
          enemyReadyShots,
          weapon,
          target,
          base,
          samProfiles,
        });
        if (candidate && (!bestTarget || candidate.score > bestTarget.score)) {
          bestTarget = candidate;
        }
      }
      return bestTarget;
    }

    legendaryEnemyMissileResources(enemy) {
      {
        const enemyGold = BigInt(enemy.gold());
        const enemySilos = [];
        const enemySiloLevels = [];
        for (const silo of enemy.units(UNIT.MissileSilo)) {
          if (!this.legendaryEligibleEnemyMissileSilo(silo)) continue;
          enemySilos.push(silo);
          enemySiloLevels.push({ level: silo.level() });
        }
        return { enemyGold, enemySilos, enemySiloLevels };
      }
    }

    legendaryScoredEnemyMissileTarget(input) {
      const {
        enemy,
        enemyGold,
        enemySilos,
        enemySiloLevels: cachedEnemySiloLevels,
        enemyReadyShots,
        weapon,
        target,
        base,
        samProfiles,
      } = input;
      const salvoPlan = this.legendaryMissileSalvoPlan(
        {
          enemySilos,
          enemyGold,
          targetTile: target.tile,
          atomCost: base.atomCost,
          hydrogenCost: base.hydrogenCost,
        },
        {
          samProfilesOverride: samProfiles,
          siloMetadataCache: base.launchMetadataCache,
          readyShotsOverride: enemyReadyShots,
        },
      );
      const sourceMetrics = salvoPlan.sourceMetrics || [];
      const enemySiloLevels =
        cachedEnemySiloLevels ??
        enemySilos.map((unit) => ({ level: unit.level() }));
      let best = null;
      for (let index = 0; index < enemySilos.length; index++) {
        const silo = enemySilos[index];
        const source = sourceMetrics[index];
        const flightTimeTicks =
          source?.flightTimeTicks ??
          this.legendaryNukeFlightTime(silo.tile(), target.tile);
        const interceptionCapacity =
          source?.interceptionCapacity ??
          this.legendarySamInterceptionCapacity(silo.tile(), target.tile);
        const threat = legendaryMissileThreatScore({
          enemySilos: enemySiloLevels,
          enemyGold,
          atomCost: base.atomCost,
          hydrogenCost: base.hydrogenCost,
          flightTimeTicks,
          vulnerableExposure: target.exposure,
          vulnerableStructures: target.exposedStructures,
          vulnerableBlastArea: target.exposure,
          atomBlastArea: Math.max(1, base.atomRadius * base.atomRadius),
          hydrogenBlastArea: Math.max(
            1,
            base.hydrogenRadius * base.hydrogenRadius,
          ),
          interceptionCapacity,
          readyShots: salvoPlan.readyShots,
          salvoRisk: salvoPlan.risk,
        });
        if (!best || threat.score > best.score) best = threat;
      }
      if (best === null) return null;
      return {
        ...best,
        weapon,
        critical:
          Boolean(best.critical) && !salvoPlan.schedule?.fullyDefended,
        enemy,
