      const cache = this._legendaryWaterRouteCache ??= new Map();
      if (cache.has(sourceTile)) return cache.get(sourceTile);
      const game = this.game;
      const maxVisited = Math.max(
        1,
        Number(
          typeof WATER_ROUTE_MAX_VISITED === "undefined"
            ? 1280
            : WATER_ROUTE_MAX_VISITED,
        ) || 1280,
      );
      const maxDistance = Math.max(
        1,
        Number(
          typeof BOAT_EXPLORATION_MAX_ROUTE_TICKS === "undefined"
            ? 1200
            : BOAT_EXPLORATION_MAX_ROUTE_TICKS,
        ) || 1200,
      );
      const distances = new Map([[sourceTile, 0]]);
      const queue = [sourceTile];
      for (let head = 0; head < queue.length && distances.size <= maxVisited; head++) {
        const current = queue[head];
        const distance = distances.get(current);
        if (distance >= maxDistance) continue;
        for (const next of game?.neighbors?.(current) ?? []) {
          if (distances.has(next)) continue;
          if (game?.isWater?.(next) !== true) continue;
          distances.set(next, distance + 1);
          queue.push(next);
        }
      }
      cache.set(sourceTile, distances);
      return distances;
    }

    legendaryPortOwnersIncludingSelf() {
      const ownersById = new Map();
      for (const owner of [this.player, ...(this.game?.players?.() ?? [])]) {
        const id = owner?.smallID?.();
        if (id === null || id === undefined || owner?.isAlive?.() === false) continue;
        ownersById.set(String(id), owner);
      }
      return [...ownersById.values()];
    }

    legendaryPortsForOwners(owners) {
      return owners.flatMap((owner) =>
        (owner?.units?.(UNIT.Port) ?? [])
          .filter((unit) => this.portIsUsable(unit))
          .map((unit) => ({ owner, unit, tile: unit?.tile?.() })),
      ).filter((port) => port.tile !== null && port.tile !== undefined);
    }

    legendaryPortInboundProfiles(
      source,
      completedPorts,
      { ownPlayer, tile, targetPort, targetUnit },
    ) {
      const sourceId = String(source.owner?.smallID?.() ?? "");
      const destinations = completedPorts.filter(
        ({ owner }) => String(owner?.smallID?.() ?? "") !== sourceId,
      );
      const beforeProfile = this.legendaryPortRouteProfile(
        source.tile,
        source.owner,
        destinations,
      );
      const targetId = targetPort?.id?.();
      const isTarget = (unit) =>
        unit === targetPort ||
        (targetId !== null && targetId !== undefined &&
          String(unit?.id?.()) === String(targetId));
      const afterDestinations = targetPort
        ? destinations.map((destination) =>
            isTarget(destination.unit)
              ? { ...destination, unit: targetUnit }
              : destination,
          )
        : [...destinations, { owner: ownPlayer, tile, unit: targetUnit }];
      return {
        beforeProfile,
        afterProfile: this.legendaryPortRouteProfile(
          source.tile,
          source.owner,
          afterDestinations,
        ),
      };
    }

    legendaryPortInboundSource(source, profiles) {
      if (!profiles.afterProfile) return null;
      return {
        ownerId: String(source.owner?.smallID?.() ?? ""),
        level: source.unit?.isUnderConstruction?.() === true
          ? 1
          : Math.max(1, Math.floor(Number(source.unit?.level?.() ?? 1))),
        constructionDelayTicks: source.unit?.isUnderConstruction?.() === true
          ? this.legendaryConstructionRemainingTicks(UNIT.Port, source.unit)
          : 0,
        ...profiles,
      };
    }

    legendaryPortInboundSources(tile, targetPort = null, upgradedLevel = null) {
      const ownPlayer = this.player;
      const ownId = String(ownPlayer?.smallID?.() ?? "");
      const ports = this.legendaryPortsForOwners(
        this.legendaryPortOwnersIncludingSelf(),
      );
      // Engine-faithful (PortExecution.ts:107-129): pending Ports remain valid
      // trade-ship destinations — they pay on arrival once active, so each
      // pending source keeps its construction delay instead of vanishing.
      const targetUnit = targetPort
        ? { isUnderConstruction: () => false, level: () => upgradedLevel }
        : { isUnderConstruction: () => true, level: () => 1 };
      return ports
        .filter(({ owner }) => String(owner?.smallID?.() ?? "") !== ownId)
        .map((source) => {
          const profiles = this.legendaryPortInboundProfiles(
            source,
            ports,
            { ownPlayer, tile, targetPort, targetUnit },
          );
          return this.legendaryPortInboundSource(source, profiles);
        })
        .filter(Boolean);
    }

    legendaryPortRouteProfile(sourceTile, sourceOwner, destinations) {
      const config = this.game?.config?.();
      if (typeof config?.tradeShipGold !== "function") return null;
      const sourceComponents = this.portWaterComponents(sourceTile);
      if (sourceComponents.size === 0) return null;
      const routeDistances = this.legendaryWaterDistancesFrom(sourceTile);
      const sourceId = String(sourceOwner?.smallID?.() ?? "");
      const myId = String(this.player?.smallID?.() ?? "");
      const sourceIsTeam = sourceId === myId || this.player?.isOnSameTeam?.(sourceOwner) === true;
      const debuff = Math.max(0, Number(config?.tradeShipShortRangeDebuff?.() ?? 0));
      const eligible = [];
      for (const destination of destinations ?? []) {
        const owner = destination?.owner;
        const tile = destination?.tile ?? destination?.unit?.tile?.();
        if (tile === null || tile === undefined || !owner) continue;
        if (String(owner?.smallID?.() ?? "") === sourceId) continue;
        if (!shimCanTrade(sourceOwner, owner)) continue;
        const targetComponents = this.portWaterComponents(tile);
        const waterComponents = [...sourceComponents].filter((component) =>
          targetComponents.has(component),
        );
        if (waterComponents.length === 0) continue;
        let bestWaterDistance = Infinity;
        for (const neighbor of this.game?.neighbors?.(tile) ?? []) {
          if (this.game?.isWater?.(neighbor) !== true) continue;
          const pathDistance = routeDistances.get(neighbor);
          if (Number.isFinite(Number(pathDistance))) {
            bestWaterDistance = Math.min(bestWaterDistance, Number(pathDistance) + 1);
          }
        }
        if (!Number.isFinite(bestWaterDistance)) continue;
