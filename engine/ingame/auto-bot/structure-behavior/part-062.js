        priorityStructures,
      } = base;
      const enemies = this.legendaryNuclearHostilePlayers();
      const samProfiles = this.legendaryFriendlySamProfiles();
      const threats = [];

      for (const enemy of enemies) {
        const bestTarget = this.legendaryEnemyMissileThreat(
          enemy,
          base,
          samProfiles,
        );
        if (bestTarget !== null) threats.push(bestTarget);
      }

      const activeMissiles = this.legendaryActiveMissileThreats(
        {
          structures,
          totalValue,
          atomCost,
          hydrogenCost,
          atomRadius,
          hydrogenRadius,
          samProfiles,
          structureValues,
          structureTiles,
          launchMetadataCache,
        },
      );
      threats.push(...activeMissiles);

      threats.sort((a, b) => b.score - a.score);
      const strongest = threats[0] ?? {
        score: 0,
        critical: false,
        weapon: null,
        flightTimeTicks: Infinity,
        targetTile: null,
        atomRadius,
        hydrogenRadius,
        activeMissiles,
      };
      return {
        ...strongest,
        threats,
        samProfiles,
        structures,
        structureValues,
        structureTiles,
        launchMetadataCache,
        priorityStructures,
        totalValue,
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        activeMissiles,
      };
    }

    legendaryActiveMissileDefenseContext() {
      const base = this.legendaryMissilePlacementBaseContext();
      const samProfiles = this.legendaryFriendlySamProfiles();
      const activeMissiles = this.legendaryActiveMissileThreats({
        ...base,
        samProfiles,
      });
      const strongest = activeMissiles[0] ?? {
        score: 0,
        critical: false,
        weapon: null,
        flightTimeTicks: Infinity,
        targetTile: null,
      };
      return {
        ...strongest,
        threats: activeMissiles,
        samProfiles,
        ...base,
        activeMissiles,
      };
    }

    legendaryMissilePlacementBaseContextCacheHit(game, config, tick) {
      if (!Number.isFinite(tick)) return null;
      if (
        this._legendaryMissilePlacementBaseContextTick !== tick ||
        this._legendaryMissilePlacementBaseContextGame !== game ||
        this._legendaryMissilePlacementBaseContextConfig !== config
      ) {
        return null;
      }
      return this._legendaryMissilePlacementBaseContextCache ?? null;
    }

    rememberLegendaryMissilePlacementBaseContext(game, config, tick, context) {
      if (!Number.isFinite(tick)) return;
      this._legendaryMissilePlacementBaseContextTick = tick;
      this._legendaryMissilePlacementBaseContextGame = game;
      this._legendaryMissilePlacementBaseContextConfig = config;
      this._legendaryMissilePlacementBaseContextCache = context;
    }

    legendaryMissilePlacementBaseContext() {
      const game = this.game;
      const config = game.config();
      const tick = safeStructureGameTick(game);
      const cached = this.legendaryMissilePlacementBaseContextCacheHit(
        game,
        config,
        tick,
      );
      if (cached !== null) return cached;
      const atomCost = config.isUnitDisabled(UNIT.AtomBomb)
        ? 0n
        : this.cost(UNIT.AtomBomb);
      const hydrogenCost = config.isUnitDisabled(UNIT.HydrogenBomb)
        ? 0n
        : this.cost(UNIT.HydrogenBomb);
      const atomRadius = Number(config.nukeMagnitudes(UNIT.AtomBomb).outer);
      const hydrogenRadius = Number(
        config.nukeMagnitudes(UNIT.HydrogenBomb).outer,
      );
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      const structureValues = new Map();
      const structureTiles = new Map();
      const priorityEntries = [];
      const priorityLimit = Math.min(
        LEGENDARY_MAX_MISSILE_TARGETS,
        structures.length,
      );
      let totalValue = 0;
      for (const unit of structures) {
        const value = this.legendaryCriticalStructureValue(unit);
        totalValue += value;
        structureValues.set(unit, value);
        structureTiles.set(unit, unit?.tile?.());
        if (
          priorityLimit > 0 &&
          (priorityEntries.length < priorityLimit ||
            value > priorityEntries[priorityEntries.length - 1].value)
        ) {
          const entry = { unit, value };
          let insertionIndex = priorityEntries.length;
          while (
            insertionIndex > 0 &&
            priorityEntries[insertionIndex - 1].value < value
          ) {
            insertionIndex--;
          }
          priorityEntries.splice(insertionIndex, 0, entry);
          if (priorityEntries.length > priorityLimit) priorityEntries.pop();
        }
      }
      const priorityUnits = [];
