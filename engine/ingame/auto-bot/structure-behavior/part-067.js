        : 0;
      return [{
        tile,
        teamGoldPerSpawn: stopContext.payout,
        teamGoldAfterPendingPerSpawn: stopContext.payout,
        pending,
        constructionDelayTicks,
        isTeam: stopContext.teamStop,
        allianceTicksRemaining: stopContext.allianceTicksRemaining,
      }];
    }

    legendaryFactorySeedStopUnitEligible(unit) {
      return (
        unit?.hasTrainStation?.() !== true &&
        unit?.isMarkedForDeletion?.() !== true &&
        unit?.isActive?.() !== false
      );
    }

    // Team-economy inputs for the marginal expected-gold evaluator. Rail
    // sources use the placement rail clusters; pending Factories join the
    // connected cluster, while pending stops count only beside a Factory station.
    legendaryEconomyInputs({
      trainCount,
      tradeShipCount,
      hasTradePartner,
      hasCompletedTradePartner,
      connectedStops,
      horizonTicks,
    }) {
      const ownerContext = this.legendaryEconomyOwnerContext();
      const {
        config,
        ownPlayer,
        owners,
        otherOwners,
        idOf,
        sameOwner,
        sameTeam,
        relationship,
        levelOf,
        levelSum,
        trainGold,
        eligibleTicksFor,
      } = ownerContext;
      const fleetOwnersById = new Map();
      for (const owner of [ownPlayer, ...(this.game?.players?.() ?? [])]) {
        if (!owner || owner?.isAlive?.() === false) continue;
        fleetOwnersById.set(idOf(owner) || owner, owner);
      }
      const fleetOwners = [...fleetOwnersById.values()];
      const liveFleetUnit = (unit) =>
        unit?.isMarkedForDeletion?.() !== true && unit?.isActive?.() !== false;
      const fleetUnitReadyAt = (type, unit) => {
        if (unit?.isUnderConstruction?.() !== true) return 0;
        if (typeof config?.unitInfo !== "function") return Infinity;
        const remaining = Number(this.legendaryConstructionRemainingTicks(type, unit));
        return Number.isFinite(remaining) ? Math.max(0, remaining) : Infinity;
      };
      // Factory reachability for opponents is not fully exposed by the local
      // view. Counting every live Factory as potentially productive is an
      // upper bound on fleet growth; payout routes remain separately verified.
      const trainOwners = fleetOwners.flatMap((owner) => {
        const allFactories = owner?.units?.(UNIT.Factory) ?? [];
        const factories = allFactories.filter(liveFleetUnit);
        if (factories.length === 0) return [];
        return [{
          isBuilder: sameOwner(owner, ownPlayer),
          // The client adapter's unitCount returns UnitViews, not level sums.
          factoryCount: levelSum(allFactories),
          factories: factories.map((factory) => ({
            level: levelOf(factory),
            readyAtTicks: fleetUnitReadyAt(UNIT.Factory, factory),
          })),
        }];
      });
      const liveFleetPorts = fleetOwners.flatMap((owner) =>
        (owner?.units?.(UNIT.Port) ?? [])
          .filter(liveFleetUnit)
          .filter((unit) => this.portIsUsable(unit))
          .map((unit) => ({ owner, unit })),
      );
      const ownPortProducerSources = [];
      const portOwners = fleetOwners.flatMap((owner) => {
        const ports = liveFleetPorts
          .filter(({ owner: portOwner }) => sameOwner(owner, portOwner))
          .flatMap(({ unit }) => {
            const tile = unit?.tile?.();
            if (tile === null || tile === undefined) return [];
            const water = this.portWaterComponents(tile);
            if (!water || water.size === 0) return [];
            const partners = liveFleetPorts.filter(({ owner: partnerOwner, unit: partner }) => {
              if (sameOwner(owner, partnerOwner) || !shimCanTrade(owner, partnerOwner)) {
                return false;
              }
              const partnerWater = this.portWaterComponents(partner?.tile?.());
              return [...water].some((component) => partnerWater?.has?.(component));
            });
            if (partners.length === 0) return [];
            // Retain the same route proof that gates productivity: the mean-field
            // fleet projection schedules each port's births along these routes
            // (weight-split) and completes them after the water distance.
            const profile = this.legendaryPortRouteProfile(tile, owner, partners);
            if (!profile) return [];
            const level = levelOf(unit);
            const readyAtTicks = fleetUnitReadyAt(UNIT.Port, unit);
            if (sameOwner(owner, ownPlayer)) {
              ownPortProducerSources.push({
                structureId: String(unit?.id?.() ?? ""),
                level,
                readyAtTicks,
                routes: profile.routes,
              });
            }
            return [{
              level,
              readyAtTicks,
              routes: profile.routes.map((route) => ({
                weight: route.weight,
                distance: route.distance,
              })),
            }];
          });
        return ports.length > 0
          ? [{
            ownerId: String(owner?.smallID?.() ?? ""),
            isBuilder: sameOwner(owner, ownPlayer),
            ports,
          }]
          : [];
      });
      const initialTradeShipRemainingTicks = [];
      const currentTick = safeStructureGameTick(this.game);
      // Missing optional plans retain initial ships conservatively; unexpected
      // query failures must propagate rather than silently changing the projection.
      // GameApi exposes grid-unit plans but keeps GameView's train plans private.
      const motionPlans = this.game?.motionPlans?.() ?? null;
      if (Number.isFinite(currentTick) && typeof motionPlans?.get === "function") {
        for (const ship of this.game?.units?.(UNIT.TradeShip) ?? []) {
          const plan = motionPlans.get(ship?.id?.());
          const startTick = Number(plan?.startTick);
          const ticksPerStep = Math.max(1, Number(plan?.ticksPerStep) || 1);
          const pathLength = Number(plan?.path?.length);
          if (
            !Number.isFinite(startTick) ||
            !Number.isFinite(pathLength) ||
            pathLength < 1
          ) continue;
          initialTradeShipRemainingTicks.push(Math.max(
            1,
            Math.ceil(startTick + (pathLength - 1) * ticksPerStep - currentTick),
          ));
        }
      }
      const fleetProducerSupply = {
        trainOwners,
