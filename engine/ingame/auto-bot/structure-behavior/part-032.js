          .filter((tile) => tile !== null && tile !== undefined)
          .map((tile) => ({ x: this.game.x(tile), y: this.game.y(tile) }));
      }
    }

    safeParticipantLocation(participant) {
      {
        const location = participant.nameLocation();
        if (!location) return null;
        if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) return null;
        return { x: Number(location.x), y: Number(location.y) };
      }
    }

    legendaryCenterTile(center) {
      {
        const x = Math.round(center.x);
        const y = Math.round(center.y);
        return this.game.isValidCoord(x, y) ? this.game.ref(x, y) : null;
      }
    }

    nearestOwnBorderToPoint(point) {
      let nearest = { tile: null, distanceSquared: Infinity };
      {
        for (const tile of this.player.borderTiles()) {
          const dx = this.game.x(tile) - point.x;
          const dy = this.game.y(tile) - point.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= nearest.distanceSquared) continue;
          nearest = { tile, distanceSquared };
        }
      }
      return nearest;
    }

    legendaryAllySupportPlacementScore(tile, type, context = null) {
      if (!ECONOMIC_STRUCTURE_TYPES.includes(type)) return 0;
      const placement = context || this.legendaryAllyPlacementContext();
      if (!placement || placement.allies.length === 0) return 0;
      const spacing = this.spacingConstants().structureSpacing;
      const samConfig = placement.samConfig || this.safeGameConfig();
      let strongest = 0;
      let secondStrongest = 0;
      for (const ally of placement.allies) {
        const supportScore = this.legendarySingleAllySupportScore(
          tile,
          ally,
          placement,
          samConfig,
        );
        if (supportScore > strongest) {
          secondStrongest = strongest;
          strongest = supportScore;
        } else if (supportScore > secondStrongest) {
          secondStrongest = supportScore;
        }
      }
      const combined = Math.min(
        5,
        strongest + 0.35 * secondStrongest,
      );
      return spacing * combined;
    }

    safeGameConfig() {
      {
        return this.game.config();
      }
    }

    legendarySingleAllySupportScore(tile, ally, placement, samConfig) {
      const distance = this.legendaryAllyDistance(tile, ally);
      const proximity = Number.isFinite(distance)
        ? legendaryPlacementProximityScore(distance, placement.supportRadius)
        : 0;
      const samSupport = this.legendaryAllySamSupport(tile, ally, samConfig);
      return ally.power * proximity + samSupport;
    }

    legendaryAllySupportSamProfiles(samUnits, config) {
      if (!config || typeof config.samRange !== "function") return [];
      const rangeByLevel = new Map();
      return (samUnits || []).map((sam) => {
        const level = Math.max(1, Number(sam.level?.() || 1));
        let range = rangeByLevel.get(level);
        if (range === undefined) {
          range = Number(config.samRange(level));
          rangeByLevel.set(level, range);
        }
        return {
          tile: sam.tile?.(),
          level,
          range,
        };
      });
    }

    legendaryAllyDistance(tile, ally) {
      let nearestSquared = Infinity;
      for (const allyTile of ally.tiles) {
        nearestSquared = Math.min(
          nearestSquared,
          this.game.euclideanDistSquared(tile, allyTile),
        );
      }
      if (Number.isFinite(nearestSquared)) return Math.sqrt(nearestSquared);
      if (!ally.location) return Infinity;
      const x = Number(ally.location.x);
      const y = Number(ally.location.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
      const dx = this.game.x(tile) - x;
      const dy = this.game.y(tile) - y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    legendaryAllySamSupport(tile, ally, config) {
      if (!config) return 0;
      let support = 0;
      const samProfiles = Array.isArray(ally.samProfiles)
        ? ally.samProfiles
        : this.legendaryAllySupportSamProfiles(ally.samUnits, config);
      for (const sam of samProfiles) {
        const level = Math.max(1, Number(sam.level || 1));
        const range = Number(sam.range);
        if (range <= 0) continue;
        const distance = Math.sqrt(
          this.game.euclideanDistSquared(tile, sam.tile),
        );
        if (distance > range) continue;
        support = Math.max(
          support,
          level * legendaryPlacementProximityScore(distance, range),
        );
      }
      return support;
    }

    legendaryTeamCenterPlacementScore(tile, context = null) {
      const center = context || this.legendaryTeamCenterPlacementContext();
      if (!center) return 0;
      const spacing = this.spacingConstants().structureSpacing;
      let centerDistance;
      {
        const dx = this.game.x(tile) - center.x;
        const dy = this.game.y(tile) - center.y;
        centerDistance = Math.sqrt(dx * dx + dy * dy);
      }

      let borderDistance = Infinity;
      if (center.nearestBorder !== null) {
        borderDistance = Math.sqrt(
          this.game.euclideanDistSquared(tile, center.nearestBorder),
        );
      }
      let radius = spacing;
      {
        radius = Math.max(
          radius,
          Number(center.radius ?? this.game.config().trainStationMaxRange()),
