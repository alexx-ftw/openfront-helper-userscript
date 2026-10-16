      completionTick,
    ) {
      const routesByStructure = new Map();
      if (threat.targetTile === null || threat.targetTile === undefined) {
        return routesByStructure;
      }
      const sources = this.legendaryThreatSources(threat);
      for (const structure of structures) {
        const structureTile =
          structureTiles?.get(structure) ?? structure.tile();
        if (structureTile === null || structureTile === undefined) {
          routesByStructure.set(structure, []);
          continue;
        }
        routesByStructure.set(
          structure,
          this.legendarySamImpactRoutesForStructure(
            sources,
            structureTile,
            completionTick,
          ),
        );
      }
      return routesByStructure;
    }

    legendarySamImpactRoutesForStructure(sources, structureTile, completionTick) {
      const routes = [];
      for (const source of sources) {
        const fromTile =
          typeof source.tile === "function" ? source.tile() : source;
        if (fromTile === null || fromTile === undefined) continue;
        const impactTick = this.legendaryNukeFlightTime(
          fromTile,
          structureTile,
        );
        if (
          impactTick - completionTick < LEGENDARY_SAM_IMPACT_MARGIN_TICKS
        ) {
          continue;
        }
        const path = this.legendaryNukeFlightPath(fromTile, structureTile);
        const targetableIndexes = this.legendaryCachedTrajectoryTargetableIndexes(
          path,
          fromTile,
          structureTile,
        );
        routes.push({
          path,
          targetableIndexes,
          targetableBounds: this.legendaryTrajectoryTargetableBounds(
            path,
            targetableIndexes,
          ),
          fromTile,
          targetTile: structureTile,
          launchOffset: 0,
          impactTick,
        });
      }
      return routes;
    }

    legendaryCandidateProtectsStructure(
      tile,
      level,
      structure,
      threats,
      impactContext = null,
    ) {
      return threats.some((threat) =>
        this.legendaryCandidateProtectsStructureFromThreat(
          tile,
          level,
          structure,
          threat,
          impactContext,
        ),
      );
    }

    legendaryCandidateProtectsStructureFromThreat(
      tile,
      level,
      structure,
      threat,
      impactContext = null,
    ) {
      if (threat.targetTile === null || threat.targetTile === undefined) return false;
      const preparedRoutes = impactContext?.routesByThreat
        ?.get(threat)
        ?.get(structure);
      if (preparedRoutes) {
        return preparedRoutes.some((route) =>
          this.legendarySamRouteProtectsTile(
            tile,
            level,
            route,
            impactContext.completionTick,
            impactContext.coverageProfile,
          ),
        );
      }
      const structureTile = structure.tile();
      const completionTick = this.legendaryConstructionDuration(UNIT.SAMLauncher);
      for (const source of this.legendaryThreatSources(threat)) {
        const fromTile = typeof source.tile === "function" ? source.tile() : source;
        if (fromTile === null || fromTile === undefined) continue;
        const impactTick = this.legendaryNukeFlightTime(fromTile, structureTile);
        if (impactTick - completionTick < LEGENDARY_SAM_IMPACT_MARGIN_TICKS) {
          continue;
        }
        const interceptTicks = this.legendarySamPathInterceptTicks(
          tile,
          {
            path: this.legendaryNukeFlightPath(fromTile, structureTile),
            fromTile,
            targetTile: structureTile,
            launchOffset: 0,
          },
          level,
        );
        if (interceptTicks.some((tick) => tick >= completionTick && tick <= impactTick)) {
          return true;
        }
      }
      return false;
    }

    legendarySamRouteProtectsTile(
      tile,
      level,
      route,
      completionTick,
      coverageProfile = null,
    ) {
      return this.legendarySamRouteHasIntercept(
        tile,
        level,
        route,
        completionTick,
        coverageProfile,
      );
    }

    legendaryMissileSalvoPlan(
      { enemySilos, enemyGold, targetTile, atomCost, hydrogenCost },
      {
        levelOverrides = null,
        extraSam = null,
        actionCompletionTick = 0,
        samProfilesOverride = null,
        siloMetadataCache = null,
        readyShotsOverride,
      } = {},
    ) {
      if (
        targetTile === null ||
        targetTile === undefined ||
        enemySilos.length === 0
