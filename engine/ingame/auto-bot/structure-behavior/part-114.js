        {
          if (unit.isUnderConstruction?.()) continue;
          const owner = unit.owner?.();
          if (!owner) continue;
          if (owner.smallID?.() === mySid) own.push(unit);
          else if (
            this.player.isFriendly(owner) === true ||
            this.player.isOnSameTeam(owner) === true
          ) {
            ally.push(unit);
          }
        }
      }
      return { own, ally };
    }

    appendTilesNearSam(context) {
      const { unit, cfg, mySid, seen, out, maxTiles } = context;
      const game = this.game;
      const samTile = unit.tile();
      const cx = game.x(samTile);
      const cy = game.y(samTile);
      const range = Number(cfg?.maxSamRange?.()) ||
        Number(cfg?.samRange?.(Number(unit.level?.()) || 1)) || 0;
      const radius = Math.floor(range);
      if (radius <= 0) return;
      const step = Math.max(2, Math.floor(radius / 6));
      const offsets = [{ dx: 0, dy: 0, distanceSquared: 0 }];
      for (let dx = -radius; dx <= radius; dx += step) {
        for (let dy = -radius; dy <= radius; dy += step) {
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared <= range * range) {
            offsets.push({ dx, dy, distanceSquared });
          }
        }
      }
      offsets.sort((left, right) => left.distanceSquared - right.distanceSquared);
      for (const offset of offsets) {
        if (out.length >= maxTiles) break;
        this.appendSamCandidateTile({
          cx,
          cy,
          dx: offset.dx,
          dy: offset.dy,
          mySid,
          seen,
          out,
        });
      }
    }

    appendSamCandidateTile(context) {
      const { cx, cy, dx, dy, mySid, seen, out } = context;
      const game = this.game;
      const nx = cx + dx;
      const ny = cy + dy;
      if (!game.isValidCoord(nx, ny)) return;
      const tile = game.ref(nx, ny);
      if (seen.has(tile) || !game.isLand(tile) || game.ownerID(tile) !== mySid) return;
      seen.add(tile);
      out.push(tile);
    }

    // portValue — NationStructureBehavior.ts:925, enriched so productive
    // stations extend an existing commercial rail line whenever that is legal.
    // A Port placed within the engine's station snap radius splits the real
    // railroad and immediately joins its cluster, which is strictly more useful
    // than an otherwise equivalent isolated coastal Port.
    portValue() {
      const otherTiles = new Set(this.player.units(UNIT.Port).map((u) => u.tile()));
      const nearestOther = this.nearestTileDistanceScorer(otherTiles, true);
      const { structureSpacing } = this.spacingConstants();
      const config = this.game.config();
      const reachableStations = this.getOrBuildReachableStations();
      const railState = this.readRailroadState(this.game);
      const minRangeSquared = config.trainStationMinRange() ** 2;
      const stationRangeSquared = config.trainStationMaxRange() ** 2;
      // Trade-ship gold is a steeply increasing function of route distance
      // (Config.tradeShipGold: sigmoid midpoint at the 300-tile short-range
      // debuff, plus 50 gold/tile), and a completed ship pays its source and
      // destination owners identically. Prefer coastal sites far from
      // tradeable foreign open-ocean ports. PortExecution.tradingPorts allows
      // ANY canTrade player (bots included), so the filter is plain
      // shimCanTrade — not the rail-only isTradeableStationNeighbor, which
      // also excludes Bot tribes. game.isOceanShore marks the canonical
      // open-ocean coastline; lake ports are unreachable from an ocean port
      // and are excluded when the predicate exists.
      const foreignDistanceBonus = this.foreignOceanDistanceBonus(
        this.foreignOceanPorts(),
      );

      return (tile) => {
        let w = 0;

        // Prefer to be as far as possible from other ports
        const closestOtherDist = nearestOther(tile);
        // No existing Port means no spacing preference, not infinite value.
        if (Number.isFinite(closestOtherDist)) w += closestOtherDist;
        if (foreignDistanceBonus !== null) {
          w += foreignDistanceBonus(tile);
        }

        w += this.commercialRailPlacementScore(
          tile,
          reachableStations,
          minRangeSquared,
          stationRangeSquared,
          { structureSpacing, railState },
        );

        return w;
      };
    }

    // Tradeable foreign ports whose water reaches an ocean port: the far end
    // of every ship route we can send or receive. PortExecution.tradingPorts
    // allows ANY canTrade player (bots included), so the filter is plain
    // shimCanTrade — not the rail-only isTradeableStationNeighbor, which also
    // excludes Bot tribes. game.isOceanShore marks the canonical open-ocean
    // coastline; lake ports are unreachable from an ocean port and are
    // excluded when the predicate exists.
    foreignOceanPorts() {
      const ports = [];
      for (const owner of this.tradeableForeignPortOwners()) {
        for (const port of owner.units?.(UNIT.Port) ?? []) {
          const portTile = this.oceanPortTile(port);
          if (portTile !== null) {
            ports.push({
              tile: portTile,
              weight: Math.max(1, Number(port.level?.()) || 1),
            });
          }
        }
      }
      return ports;
    }

    tradeableForeignPortOwners() {
      const owners = [];
      const mySid = this.player?.smallID?.();
      for (const other of this.game.players?.() ?? []) {
        if (!other || (mySid !== undefined && other?.smallID?.() === mySid)) continue;
        if (other?.isAlive?.() === false) continue;
        if (!shimCanTrade(this.player, other)) continue;
        owners.push(other);
      }
      return owners;
    }

    portWaterComponents(tile) {
      const components = new Set();
      if (
        tile === null || tile === undefined ||
        typeof this.game?.forEachNeighbor !== "function" ||
        typeof this.game?.isWater !== "function"
      ) {
        return components;
      }
      this.game.forEachNeighbor(tile, (neighbor) => {
        if (!this.game.isWater(neighbor)) return;
