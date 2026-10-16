      return this.expandCoveredMirvDemands(demandGroups, coveredMissileKeys);
    }

    groupActiveMirvDemands(demands) {
      const demandGroups = new Map();
      for (const demand of demands) {
        const key = demand?.missile ?? demand;
        let group = demandGroups.get(key);
        if (!group) {
          group = [];
          demandGroups.set(key, group);
        }
        group.push(demand);
      }
      return demandGroups;
    }

    legendaryMirvDemandRoutes(demandGroups, profiles) {
      const routes = [];
      let routeIndex = 0;
      for (const [key, group] of demandGroups) {
        const route = this.legendaryMirvDemandRoute(
          group[0],
          profiles,
          `mirv:${routeIndex++}`,
        );
        if (route !== null) {
          route.mirvDemandKey = key;
          routes.push(route);
        }
      }
      return routes;
    }

    legendaryCoveredMirvMissileKeys(routes, profiles) {
      const schedule = legendaryMissileDefenseSchedule({
        routes,
        samProfiles: profiles,
        samCooldownTicks: this.legendarySamCooldownTicks(),
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
      });
      return new Set(
        schedule.missiles
          .filter((missile) => missile.intercepted)
          .map((missile) => missile.mirvDemandKey),
      );
    }

    expandCoveredMirvDemands(demandGroups, coveredMissileKeys) {
      const coveredDemands = new Set();
      for (const [key, group] of demandGroups) {
        if (!coveredMissileKeys.has(key)) continue;
        for (const demand of group) coveredDemands.add(demand);
      }
      return coveredDemands;
    }

    mirvUnitField(unit, field) {
      if (!unit) return null;
      const read = unit[field];
      return typeof read === "function" ? read.call(unit) : null;
    }

    legendaryMirvDemandEndpoints(demand) {
      if (!demand) return null;
      const missile = demand.missile;
      const fromTile =
        demand.fromTile ?? this.mirvUnitField(missile, "tile");
      const targetTile =
        demand.interceptTargetTile ??
        this.mirvUnitField(missile, "targetTile") ??
        demand.targetTile;
      if (
        fromTile === null ||
        fromTile === undefined ||
        targetTile === null ||
        targetTile === undefined
      ) {
        return null;
      }
      return { missile, fromTile, targetTile };
    }

    legendaryMirvDemandRouteState(demand, endpoints, motion) {
      const path = Array.isArray(demand.path)
        ? demand.path
        : motion?.path ?? null;
      const impactTick = Math.max(
        1,
        Number(demand.deadlineTick ?? motion?.impactTick) || 1,
      );
      return {
        weapon: demand.type ?? this.mirvUnitField(endpoints.missile, "type"),
        fromTile: motion?.fromTile ?? endpoints.fromTile,
        targetTile: endpoints.targetTile,
        impactTick,
        path,
      };
    }

    legendaryMirvDemandRoute(demand, samProfiles, routeId) {
      const endpoints = this.legendaryMirvDemandEndpoints(demand);
      if (endpoints === null) return null;
      const motion = this.legendaryActiveMissileMotion(
        endpoints.missile,
        endpoints.fromTile,
      );
      const route = this.legendaryMirvDemandRouteState(
        demand,
        endpoints,
        motion,
      );
      return this.legendaryBuildMissileRoute(
        {
          id: routeId,
          weapon: route.weapon,
          fromTile: route.fromTile,
          targetTile: route.targetTile,
          launchOffset: Array.isArray(demand.path) ? 0 : motion?.launchOffset ?? 0,
          impactTick: route.impactTick,
          path: route.path,
        },
        samProfiles,
      );
    }

    samTileCoversMirvDemand(tile, demand, completionTick = 0) {
      if (tile === null || tile === undefined) return false;
      if (completionTick + LEGENDARY_SAM_IMPACT_MARGIN_TICKS > demand.deadlineTick) {
        return false;
      }
      if (!demand?.missile && !Array.isArray(demand?.path)) {
        return this.game.manhattanDist(tile, demand.targetTile) < 50;
      }
      const candidateProfile = {
        id: "mirv-candidate-sam",
        tile,
        level: 1,
        range: this.legendarySamRange(1),
        availableTicks: [Math.max(0, Number(completionTick) || 0)],
        cooldownTicks: this.legendarySamCooldownTicks(),
      };
      const route = this.legendaryMirvDemandRoute(
        demand,
        [candidateProfile],
        "mirv-candidate-route",
      );
      if (route === null) return false;
      return legendaryMissileDefenseSchedule({
        routes: [route],
        samProfiles: [candidateProfile],
        samCooldownTicks: candidateProfile.cooldownTicks,
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
      }).fullyDefended;
    }

    legendaryActiveMissileThreat(nuke, mySid, context, samProfiles) {
      if (nuke.isActive && nuke.isActive() === false) return null;
      const owner = nuke.owner();
      if (
