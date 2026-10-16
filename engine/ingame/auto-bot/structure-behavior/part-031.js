        for (const sam of player.units(UNIT.SAMLauncher)) {
          if (sam.isUnderConstruction()) continue;
          samUnits.push(sam);
          const tile = sam.tile();
          if (tile !== null && tile !== undefined) tiles.push(tile);
        }
      }
      return { troops, gold, goldProduction, tiles, samUnits };
    }

    legendaryProductiveUnitMetrics(unit) {
      const rawTile = unit.tile();
      const tile = rawTile === null || rawTile === undefined ? null : rawTile;
      const connected =
        typeof unit.hasTrainStation === "function" && unit.hasTrainStation();
      if (!connected) return { tile, goldProduction: 0 };
      const cityMultiplier = unit.type() === UNIT.City ? 1 : 0.25;
      return {
        tile,
        goldProduction: this.trainGoldBase("ally", 1) * cityMultiplier,
      };
    }

    legendaryAllyPlacementContext() {
      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._legendaryAllyPlacementContextTick === tick
      ) {
        return this._legendaryAllyPlacementContextCache;
      }
      const own = this.legendaryProductionMetrics(this.player);
      const config = this.safeGameConfig();
      const supportRadius = Math.max(
        1,
        Number(config.trainStationMaxRange()),
      );

      const allies = [];
      for (const ally of this.legendaryFriendlyPlayers()) {
        const metrics = this.legendaryProductionMetrics(ally);
        let location;
        {
          location = ally.nameLocation();
        }
        allies.push({
          player: ally,
          ...metrics,
          samProfiles: this.legendaryAllySupportSamProfiles(
            metrics.samUnits,
            config,
          ),
          location,
          power: legendaryAllyPowerScore({
            allyTroops: metrics.troops,
            allyGold: metrics.gold,
            allyProduction: metrics.goldProduction,
            ownTroops: own.troops,
            ownGold: own.gold,
            ownProduction: own.goldProduction,
          }),
        });
      }
      const context = { own, allies, supportRadius, samConfig: config };
      if (Number.isFinite(tick)) {
        this._legendaryAllyPlacementContextTick = tick;
        this._legendaryAllyPlacementContextCache = context;
      }
      return context;
    }

    legendaryTeamCenterPlacementContext() {
      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._legendaryTeamCenterPlacementContextTick === tick
      ) {
        return this._legendaryTeamCenterPlacementContextCache;
      }
      const participants = [this.player, ...this.legendaryFriendlyPlayers()];
      const points = [];
      for (const participant of participants) {
        points.push(...this.legendaryParticipantCenterPoints(participant));
      }

      if (points.length === 0) {
        if (Number.isFinite(tick)) {
          this._legendaryTeamCenterPlacementContextTick = tick;
          this._legendaryTeamCenterPlacementContextCache = null;
        }
        return null;
      }
      const center = points.reduce(
        (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
        { x: 0, y: 0 },
      );
      center.x /= points.length;
      center.y /= points.length;

      const centerTile = this.legendaryCenterTile(center);
      const nearest = this.nearestOwnBorderToPoint(center);
      const radius = Math.max(
        this.spacingConstants().structureSpacing,
        Number(this.game.config().trainStationMaxRange()),
      );

      const context = {
        x: center.x,
        y: center.y,
        tile: centerTile,
        nearestBorder: nearest.tile,
        nearestBorderDistanceSquared: nearest.distanceSquared,
        radius,
      };
      if (Number.isFinite(tick)) {
        this._legendaryTeamCenterPlacementContextTick = tick;
        this._legendaryTeamCenterPlacementContextCache = context;
      }
      return context;
    }

    legendaryParticipantCenterPoints(participant) {
      const border = this.safeParticipantBorder(participant);
      if (border?.size > 0) return this.sampleBorderPoints(border);
      const points = this.participantStructurePoints(participant);
      const location = this.safeParticipantLocation(participant);
      if (location !== null) points.push(location);
      return points;
    }

    safeParticipantBorder(participant) {
      {
        return participant.borderTiles();
      }
    }

    sampleBorderPoints(border) {
      const points = [];
      const stride = Math.max(1, Math.ceil(border.size / 2000));
      let index = 0;
      for (const tile of border) {
        if (index++ % stride !== 0) continue;
        points.push({ x: this.game.x(tile), y: this.game.y(tile) });
      }
      return points;
    }

    participantStructurePoints(participant) {
      {
        const out = [];
        for (const type of [
          UNIT.City,
          UNIT.Factory,
          UNIT.Port,
          UNIT.SAMLauncher,
        ]) {
          out.push(...participant.units(type));
        }
        return out
          .map((unit) => unit.tile())
