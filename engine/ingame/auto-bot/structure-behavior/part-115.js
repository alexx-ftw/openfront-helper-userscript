        const component = this.game.isOcean?.(neighbor)
          ? -1
          : this.game.getWaterComponent?.(neighbor);
        if (component !== null && component !== undefined) components.add(component);
      });
      return components;
    }

    portOwnerStateOnWater(owner, component) {
      let completed = false;
      let inProgress = false;
      for (const port of owner?.units?.(UNIT.Port) ?? []) {
        if (!this.portIsUsable(port)) continue;
        if (!this.portWaterComponents(port?.tile?.()).has(component)) continue;
        if (port?.isUnderConstruction?.() === true) {
          inProgress = true;
          continue;
        }
        completed = true;
      }
      return { completed, inProgress };
    }

    portIsUsable(port) {
      return port?.isMarkedForDeletion?.() !== true && port?.isActive?.() !== false;
    }

    legendaryPortSeedOwnerIds(component) {
      const ownersById = new Map();
      for (const owner of [this.player, ...(this.game?.players?.() ?? [])]) {
        const id = owner?.smallID?.();
        if (id === null || id === undefined) continue;
        if (owner?.isAlive?.() === false) continue;
        const ownerShared = this.game?.sharedWaterComponents?.(owner);
        if (!ownerShared?.has?.(component)) continue;
        ownersById.set(String(id), owner);
      }
      const ids = [...ownersById.keys()].sort((left, right) => {
        const leftNumber = Number(left);
        const rightNumber = Number(right);
        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
          return leftNumber - rightNumber;
        }
        return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
      });
      for (let first = 0; first < ids.length; first++) {
        for (let second = first + 1; second < ids.length; second++) {
          if (shimCanTrade(ownersById.get(ids[first]), ownersById.get(ids[second]))) {
            return [ids[first], ids[second]];
          }
        }
      }
      return [];
    }

    portCandidateHasTradeRoute(tile) {
      const components = this.portWaterComponents(tile);
      const shared = this.game?.sharedWaterComponents?.(this.player);
      if (!shared || components.size === 0) return false;
      const currentId = this.player?.smallID?.();
      const foreignOwners = this.tradeableForeignPortOwners();
      for (const component of components) {
        if (!shared.has(component)) continue;
        const foreignStates = foreignOwners.map((owner) => ({
          owner,
          ...this.portOwnerStateOnWater(owner, component),
        }));
        if (foreignStates.some(({ completed }) => completed)) return true;

        const seedIds = this.legendaryPortSeedOwnerIds(component).map(String);
        if (!seedIds.includes(String(currentId))) continue;
        const ownState = this.portOwnerStateOnWater(this.player, component);
        if (ownState.completed || ownState.inProgress) continue;
        const pendingOwners = foreignStates
          .filter(({ inProgress }) => inProgress)
          .map(({ owner }) => String(owner.smallID()));
        if (pendingOwners.some((id) => !seedIds.includes(id))) continue;
        const seededOwners = pendingOwners.filter((id) => seedIds.includes(id));
        if (seededOwners.length === 0) return true;
        if (
          seededOwners.length === 1 &&
          seededOwners[0] !== String(currentId) &&
          seedIds.includes(String(currentId))
        ) {
          return true;
        }
      }
      return false;
    }

    hasTradeablePortOnSharedWater({ includeInProgress = true } = {}) {
      const shared = this.game?.sharedWaterComponents?.(this.player);
      if (!shared) return this.foreignOceanPorts().length > 0;
      for (const component of shared) {
        if (
          this.tradeableForeignPortOwners().some((owner) => {
            const status = this.portOwnerStateOnWater(owner, component);
            return status.completed || (includeInProgress && status.inProgress);
          })
        ) {
          return true;
        }
      }
      return false;
    }

    oceanPortTile(port) {
      if (port?.isUnderConstruction?.()) return null;
      const portTile = port?.tile?.();
      if (portTile === null || portTile === undefined) return null;
      if (
        typeof this.game.isOceanShore === "function" &&
        !this.game.isOceanShore(portTile)
      ) {
        return null;
      }
      return portTile;
    }

    // Trade-ship gold is a steeply increasing function of route distance
    // (Config.tradeShipGold: sigmoid midpoint at the short-range debuff, plus
    // 50 gold/tile), and a completed ship pays its source and destination
    // owners identically. One debuff-length route already banks the whole
    // sigmoid; beyond it only the linear term grows, so the bonus is capped
    // at the debuff distance to keep it from outweighing rail placement.
    // Null keeps the legacy score untouched (no foreign ports, or an older
    // client without the config hook). Weight by destination Port level, as
    // PortExecution repeats each eligible destination once per level.
    foreignOceanDistanceBonus(foreignPorts) {
      if (foreignPorts.length === 0) return null;
      const cap = Number(this.game.config()?.tradeShipShortRangeDebuff?.() ?? NaN);
      if (!Number.isFinite(cap) || cap <= 0) return null;
      const weightedDistances = foreignPorts.map(({ tile, weight }) => ({
        weight,
        distance: this.nearestTileDistanceScorer(new Set([tile])),
      }));
      return (tile) => {
        let weightedDistance = 0;
        let totalWeight = 0;
        for (const entry of weightedDistances) {
          const distance = entry.distance(tile);
          if (!Number.isFinite(distance)) continue;
          weightedDistance += Math.min(distance, cap) * entry.weight;
          totalWeight += entry.weight;
        }
        return totalWeight > 0 ? weightedDistance / totalWeight : 0;
      };
    }

    // factoryValue — NationStructureBehavior.ts:951.
    factoryValue() {
      const game = this.game;
      const player = this.player;
      const borderTiles = this.economicExposureBorderTiles();
      const otherTiles = new Set(player.units(UNIT.Factory).map((u) => u.tile()));
      const { borderSpacing, structureSpacing } = this.spacingConstants();
      const nearestBorder = this.nearestTileDistanceScorer(borderTiles);
      const nearestOther = this.nearestTileDistanceScorer(otherTiles, true);
      const stationRange = game.config().trainStationMaxRange();
      const stationRangeSquared = stationRange * stationRange;
