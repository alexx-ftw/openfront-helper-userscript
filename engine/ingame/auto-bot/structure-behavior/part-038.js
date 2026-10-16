          typeof UniversalPathFinding !== "undefined" &&
          UniversalPathFinding.Parabola
        ) {
          const pathFinder = UniversalPathFinding.Parabola(this.game, {
            increment: speed,
            distanceBasedHeight: true,
            directionUp: true,
          });
          path = pathFinder.findPath(fromTile, targetTile) ?? [];
        }
      }

      if (path.length > 0) {
        this._missileFlightPathCache.set(cacheKey, path);
        return path;
      }

      const distance = Math.sqrt(
        this.game.euclideanDistSquared(fromTile, targetTile),
      );
      const steps = Math.max(1, Math.ceil(distance / speed));
      path = [fromTile];
      {
        const fromX = this.game.x(fromTile);
        const fromY = this.game.y(fromTile);
        const targetX = this.game.x(targetTile);
        const targetY = this.game.y(targetTile);
        for (let step = 1; step <= steps; step++) {
          const x = Math.round(fromX + ((targetX - fromX) * step) / steps);
          const y = Math.round(fromY + ((targetY - fromY) * step) / steps);
          if (!this.game.isValidCoord(x, y)) continue;
          const tile = this.game.ref(x, y);
          if (path[path.length - 1] !== tile) path.push(tile);
        }
      }
      if (path[path.length - 1] !== targetTile) path.push(targetTile);
      this._missileFlightPathCache.set(cacheKey, path);
      return path;
    }

    legendaryExactNukeFlightTime(fromTile, targetTile, speed, path) {
      if (
        typeof UniversalPathFinding === "undefined" ||
        !UniversalPathFinding.Parabola
      ) return null;
      const pathFinder = UniversalPathFinding.Parabola(this.game, {
        increment: speed,
        distanceBasedHeight: true,
        directionUp: true,
      });
      if (typeof pathFinder.next !== "function") return null;
      const directDistance = Math.sqrt(
        this.game.euclideanDistSquared(fromTile, targetTile),
      );
      const estimatedTicks = Math.max(1, Math.ceil(directDistance / speed));
      const maxTicks = Math.min(
        LEGENDARY_MAX_NUKE_FLIGHT_TICKS,
        Math.max(256, path.length * 4 + 64, estimatedTicks * 8 + 64),
      );
      for (let tick = 1; tick <= maxTicks; tick++) {
        const result = pathFinder.next(fromTile, targetTile, speed);
        if (result?.status === "Complete" || result?.status === 2) return tick;
      }
      return null;
    }

    legendaryFallbackNukeFlightTime(fromTile, targetTile, speed, path) {
      if (path.length <= 1) {
        const distance = Math.sqrt(
          this.game.euclideanDistSquared(fromTile, targetTile),
        );
        return Math.max(1, Math.ceil(distance / speed));
      }
      let arc = 0;
      for (let index = 1; index < path.length; index++) {
        const ax = this.game.x(path[index]);
        const ay = this.game.y(path[index]);
        const bx = this.game.x(path[index - 1]);
        const by = this.game.y(path[index - 1]);
        arc += Math.hypot(ax - bx, ay - by);
      }
      return Math.floor(arc / speed) + 1;
    }

    legendaryNukeFlightTime(fromTile, targetTile) {
      const speed = this.legendaryNukeSpeed();
      if (!this._missileFlightTimeCache) {
        this._missileFlightTimeCache = new Map();
      }
      const cacheKey = `${String(fromTile)}:${String(targetTile)}:${String(speed)}`;
      const cachedFlightTime = this._missileFlightTimeCache.get(cacheKey);
      if (cachedFlightTime !== undefined) return cachedFlightTime;

      const path = this.legendaryNukeFlightPath(fromTile, targetTile);
      const flightTime =
        this.legendaryExactNukeFlightTime(fromTile, targetTile, speed, path) ??
        this.legendaryFallbackNukeFlightTime(fromTile, targetTile, speed, path);
      this._missileFlightTimeCache.set(cacheKey, flightTime);
      return flightTime;
    }

    legendaryFriendlySamUnits() {
      const mySid = this.player.smallID();
      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._friendlySamUnitsTick === tick &&
        this._friendlySamUnitsPlayerSid === mySid
      ) {
        return this._friendlySamUnitsCache;
      }
      const sams = [];
      const seen = new Set();
      const add = (sam) => {
        if (!sam || sam.isUnderConstruction()) return;
        const id = sam.id();
        if (id !== null && id !== undefined && seen.has(id)) return;
        const owner = sam.owner();
        if (!owner) return;
        let friendly = owner.smallID() === mySid;
        if (!friendly) {
          {
            friendly =
              this.player.isFriendly(owner) || this.player.isOnSameTeam(owner);
          }
        }
        if (!friendly) return;
        if (id !== null && id !== undefined) seen.add(id);
        sams.push(sam);
      };

      if (typeof this.game.units === "function") {
        for (const sam of this.game.units(UNIT.SAMLauncher)) add(sam);
      }
      if (sams.length === 0) {
        const friendlyPlayers =
          typeof this.game.players === "function"
            ? this.legendaryFriendlyPlayers()
            : [];
        for (const participant of [this.player, ...friendlyPlayers]) {
          {
            for (const sam of participant.units(UNIT.SAMLauncher)) add(sam);
          }
        }
      }
      if (Number.isFinite(tick)) {
        this._friendlySamUnitsTick = tick;
        this._friendlySamUnitsPlayerSid = mySid;
        this._friendlySamUnitsCache = sams;
      }
      return sams;
    }

    legendarySamReadySlots(sam, levelOverride = null) {
      if (!sam || sam.isUnderConstruction()) return 0;
      return this.legendaryReadyShotCountFromSlots(
        this.legendarySamSlotAvailability(sam, levelOverride),
      );
    }

