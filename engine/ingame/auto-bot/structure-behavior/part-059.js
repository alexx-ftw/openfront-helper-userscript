        representation instanceof Map
          ? representation
          : this.missileDefenseStateRepresentation();
      const entries = Array.from(state.entries());
      entries.sort((left, right) => left[0].localeCompare(right[0]));
      return JSON.stringify(entries);
    }

    missileDefenseSnapshotIsCurrent(expectedTick, expectedStateKey) {
      const currentTick = Number(this.game?.ticks?.());
      if (
        Number.isFinite(expectedTick) &&
        Number.isFinite(currentTick) &&
        currentTick !== expectedTick
      ) {
        return false;
      }
      return (
        expectedStateKey === null ||
        expectedStateKey === undefined ||
        this.missileDefenseStateFingerprint() === expectedStateKey
      );
    }

    legendaryEmptyMissileDefenseContext() {
      let config = {};
      {
        config = this.game.config() || {};
      }
      const isDisabled = (type) => {
        {
          return typeof config.isUnitDisabled === "function"
            ? config.isUnitDisabled(type)
            : false;
        }
      };
      const readRadius = (type, fallback) => {
        {
          const radius = Number(config.nukeMagnitudes?.(type)?.outer);
          return Number.isFinite(radius) && radius > 0 ? radius : fallback;
        }
      };
      const readCost = (type) => {
        {
          return BigInt(this.cost(type));
        }
      };
      const atomCost = isDisabled(UNIT.AtomBomb)
        ? 0n
        : readCost(UNIT.AtomBomb);
      const hydrogenCost = isDisabled(UNIT.HydrogenBomb)
        ? 0n
        : readCost(UNIT.HydrogenBomb);
      const atomRadius = readRadius(UNIT.AtomBomb, 30);
      const hydrogenRadius = readRadius(UNIT.HydrogenBomb, 100);
      let structures;
      {
        structures = this.player.units(
          UNIT.City,
          UNIT.Factory,
          UNIT.Port,
          UNIT.MissileSilo,
        );
      }
      if (!Array.isArray(structures)) structures = [];
      const totalValue = structures.reduce(
        (total, unit) => total + this.legendaryCriticalStructureValue(unit),
        0,
      );
      return {
        score: 0,
        critical: false,
        threats: [],
        structures,
        totalValue,
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        activeMissiles: [],
      };
    }

    getMissileDefenseContext() {
      const tick = safeStructureGameTick(this.game);
      const signal = this.missileDefenseSignalSnapshot();
      const stateRepresentation =
        signal === null ||
        (signal.hasBuiltHostileSilo !== true &&
          signal.hasActiveHostileMissile !== true)
          ? null
          : this.missileDefenseStateProbe();
      const identity = this.missileDefenseContextIdentity(
        tick,
        signal,
        stateRepresentation,
      );
      const { cacheKey, missileSignal, stateChanged } = identity;
      if (
        cacheKey !== null &&
        this._missileDefenseContextKey === cacheKey &&
        this._missileDefenseContextCache !== null
      ) {
        return this._missileDefenseContextCache;
      }

      if (stateChanged) this.invalidateLegendaryMissilePlacementBaseContext();

      const context = missileSignal === false
        ? this.legendaryEmptyMissileDefenseContext()
        : this.legendaryMissilePlacementContext();
      if (Number.isFinite(tick)) {
        this._missileDefenseContextTick = tick;
        this._missileDefenseContextKey = cacheKey;
        this._missileDefenseContextCache = context;
      }
      return context;
    }

    missileDefenseContextIdentity(tick, signal, stateRepresentation = null) {
      const activeMissile = signal?.hasActiveHostileMissile === true;
      const missileSignal =
        signal === null
          ? null
          : signal.hasBuiltHostileSilo ||
            signal.hasActiveHostileMissile === null ||
            activeMissile;
      let cacheTick = null;
      if (Number.isFinite(tick)) {
        cacheTick = activeMissile
          ? tick
          : Math.floor(tick / LEGENDARY_MISSILE_DEFENSE_CONTEXT_BUCKET_TICKS);
      }
      let stateKey = "unknown-missile-signal";
      let stateChanged = false;
      if (missileSignal === false) stateKey = "no-missile-signal";
      else if (signal !== null) {
        if (
          stateRepresentation !== null &&
          this.missileDefenseStateRepresentationsEqual(
            this._missileDefenseStateRepresentationCache,
            stateRepresentation,
          ) &&
          this._missileDefenseStateKeyCache !== null
        ) {
          stateKey = this._missileDefenseStateKeyCache;
        } else {
          stateKey = this.missileDefenseStateFingerprint(stateRepresentation);
          stateChanged = true;
          this._missileDefenseStateRepresentationCache = stateRepresentation;
          this._missileDefenseStateKeyCache = stateKey;
        }
      }
      return {
        missileSignal,
        cacheKey: Number.isFinite(cacheTick) ? `${cacheTick}|${stateKey}` : null,
        stateChanged,
      };
    }

