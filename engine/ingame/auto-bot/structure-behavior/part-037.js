    }

    legendaryDefenseGap(protectableStructures, enemySilos) {
      if (protectableStructures.length === 0) {
        return enemySilos > 0 ? 1 : 0.25;
      }

      const sams = this.legendaryFriendlySamUnits();

      let uncovered = 0;
      let samRange;
      {
        samRange = (sam) => this.legendarySamRange(sam.level());
      }

      for (const structure of protectableStructures) {
        const covered = sams.some((sam) => {
          const range = Number(samRange(sam));
          return (
            range > 0 &&
            this.game.euclideanDistSquared(structure.tile(), sam.tile()) <=
              range * range
          );
        });
        if (!covered) uncovered++;
      }

      return Math.min(
        2.5,
        Math.max(
          0.25,
          0.5 + uncovered / protectableStructures.length + enemySilos / Math.max(1, protectableStructures.length),
        ),
      );
    }

    legendaryEnemyTargetPressure() {
      const enemies = this.legendaryHostilePlayers();
      if (enemies.length === 0) return 0.25;

      const ownGold = Number(this.player.gold());
      const ownMaxTroops = Math.max(1, this.game.config().maxTroops(this.player));
      let strongestTarget = 0.25;

      for (const enemy of enemies) {
        const unitCounts = this.legendaryEnemyTargetUnitCounts(enemy);
        const targetValue = (() => {
          const goldRatio = Number(enemy.gold()) / Math.max(1, ownGold);
          const troopRatio =
            this.game.config().maxTroops(enemy) / ownMaxTroops;
          const attackCapacity =
            unitCounts[UNIT.MissileSilo] + unitCounts[UNIT.Warship] / 2;
          const defenseCapacity =
            unitCounts[UNIT.SAMLauncher] + unitCounts[UNIT.Warship] / 2;
          const structureCapacity =
            unitCounts[UNIT.City] + unitCounts[UNIT.Factory] + unitCounts[UNIT.Port];
          return Math.max(
            goldRatio,
            troopRatio,
            attackCapacity / 3,
            defenseCapacity / 3,
            structureCapacity / 5,
          );
        })();
        strongestTarget = Math.max(
          strongestTarget,
          Math.min(2.5, 0.75 + targetValue),
        );
      }
      return strongestTarget;
    }

    legendaryEnemyTargetUnitCounts(enemy) {
      const types = [
        UNIT.MissileSilo,
        UNIT.Warship,
        UNIT.SAMLauncher,
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
      ];
      const counts = Object.fromEntries(types.map((type) => [type, 0]));
      // Vendored units() caps at three positional types and silently drops
      // the rest; enumerate per type so City/Factory/Port threat value is
      // not invisible to the Legendary target scorer.
      const roster = [];
      for (const type of types) roster.push(...(enemy.units(type) || []));
      for (const unit of roster) {
        const type = unit.type?.();
        if (Object.hasOwn(counts, type)) counts[type]++;
      }
      return counts;
    }

    legendaryPortSurvivability(ports, enemyWarships) {
      if (ports.length === 0) return 1;
      let covered = 0;
      const sams = this.legendaryFriendlySamUnits();
      for (const port of ports) {
        const safe = sams.some((sam) => {
          const range = this.legendarySamRange(sam.level());
          return (
            range > 0 &&
            this.game.euclideanDistSquared(port.tile(), sam.tile()) <=
              range * range
          );
        });
        if (safe) covered++;
      }
      const coverage = covered / ports.length;
      const ownWarships = this.player.units(UNIT.Warship).length;
      const shipRisk = Math.min(
        0.25,
        enemyWarships / Math.max(4, enemyWarships + ownWarships + 4),
      );
      return Math.min(1, Math.max(0.35, 0.55 + coverage * 0.45 - shipRisk));
    }

    legendaryCriticalStructureValue(unit) {
      const baseValue = {
        [UNIT.City]: 5,
        [UNIT.Factory]: 4,
        [UNIT.Port]: 4,
        [UNIT.MissileSilo]: 3,
      }[unit.type()];
      return (baseValue ?? 1) * Math.max(1, Number(unit.level() || 1));
    }

    legendaryNukeSpeed() {
      const config = this.game.config();
      if (
        config === this._legendaryNukeSpeedConfig &&
        Number.isFinite(this._legendaryNukeSpeedCache)
      ) {
        return this._legendaryNukeSpeedCache;
      }
      const speed = Math.max(1, Number(config.defaultNukeSpeed()));
      this._legendaryNukeSpeedConfig = config;
      this._legendaryNukeSpeedCache = speed;
      return speed;
    }

    legendaryNukeFlightPath(fromTile, targetTile) {
      const speed = this.legendaryNukeSpeed();

      // The map and nuke speed are stable for the lifetime of a game, while a
      // single defense forecast asks for the same source/target parabola from
      // several planner branches. Keep one trajectory per pair so a large
      // salvo does not turn every SAM candidate into another pathfinding pass.
      if (!this._missileFlightPathCache) {
        this._missileFlightPathCache = new Map();
      }
      const cacheKey = `${String(fromTile)}:${String(targetTile)}:${String(speed)}`;
      const cachedPath = this._missileFlightPathCache.get(cacheKey);
      if (cachedPath) return cachedPath;

      let path = [];

      {
        if (
