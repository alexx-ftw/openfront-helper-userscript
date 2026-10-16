      let capacity = 0;
      for (const sam of sams) {
        const override =
          !preparedProfiles && levelOverrides && levelOverrides.has(sam.id())
            ? levelOverrides.get(sam.id())
            : null;
        let availableTicks = [];
        if (Array.isArray(sam.availableTicks)) {
          availableTicks = sam.availableTicks;
        }
        const readySlots = preparedProfiles
          ? this.legendaryReadyShotCountFromSlots(
              availableTicks,
              sam.readySlots,
            )
          : this.legendarySamReadySlots(sam, override);
        if (readySlots <= 0) continue;
        const hasCoverage = this.legendarySamPathHasCoverageForRoute(
          sam,
          route,
          override,
        );
        if (hasCoverage) capacity += readySlots;
      }
      return capacity;
    }

    legendaryMinimumSamImpactMargin(context, levelOverrides = null) {
      const evaluation = this.legendaryDefenseEvaluation(context, {
        levelOverrides,
      });
      // A schedule with even one missile that cannot be assigned to a ready or
      // reloaded SAM has no usable safety margin. The returned value therefore
      // means “ticks from the action completion to the first landing, but only
      // when every incoming missile is actually defendable.”
      return evaluation.hasThreats && evaluation.fullyDefended
        ? evaluation.completionMarginTicks
        : 0;
    }

    legendaryMinimumSamInterceptionCapacity(context, levelOverrides = null) {
      if (!context || !Array.isArray(context.threats)) return 0;
      const samProfilesOverride = this.legendarySamCapacityProfiles(
        context,
        levelOverrides,
      );
      let minimum = Infinity;
      let routeCount = 0;
      for (const threat of context.threats) {
        const targetTile = threat.targetTile;
        if (targetTile === null || targetTile === undefined) continue;
        const sources = this.legendaryThreatSources(threat);
        for (const source of sources) {
          const fromTile =
            typeof source.tile === "function" ? source.tile() : source;
          if (fromTile === null || fromTile === undefined) continue;
          routeCount++;
          minimum = Math.min(
            minimum,
            this.legendarySamInterceptionCapacity(
              fromTile,
              targetTile,
              levelOverrides,
              samProfilesOverride,
            ),
          );
        }
      }
      return routeCount > 0 && Number.isFinite(minimum) ? minimum : 0;
    }

    legendarySamCapacityProfiles(context, levelOverrides) {
      if (this.hasLegendaryLevelOverrides(levelOverrides)) return null;
      return Array.isArray(context?.samProfiles) ? context.samProfiles : null;
    }

    legendaryThreatSources(threat) {
      if (!threat.inFlight) return threat.enemySilos || [];
      if (!threat.nuke || typeof threat.nuke.tile !== "function") return [];
      return [threat.nuke.tile()];
    }

    legendarySamImpactMarginScore(
      tile,
      context,
      level = 1,
      rangeOverride = null,
    ) {
      if (!context || !Array.isArray(context.threats)) return 0;
      const structures = Array.isArray(context.structures)
        ? context.priorityStructures || context.structures
        : [];
      if (structures.length === 0) return 0;
      let protectedValue = 0;
      const totalValue = Math.max(1, Number(context.totalValue || 0));
      const structureValues = context.structureValues;
      const impactContext = this.legendarySamImpactMarginContext(context);
      const coverageProfile = this.legendarySamCoverageProfile(
        tile,
        level,
        rangeOverride,
      );
      if (coverageProfile === null) return 0;
      const previousCoverageProfile = impactContext.coverageProfile;
      impactContext.coverageProfile = coverageProfile;
      try {
        for (const structure of structures) {
          if (
            this.legendaryCandidateProtectsStructure(
              tile,
              level,
              structure,
              context.threats,
              impactContext,
            )
          ) {
            protectedValue +=
              structureValues?.get(structure) ??
              this.legendaryCriticalStructureValue(structure);
          }
        }
      } finally {
        impactContext.coverageProfile = previousCoverageProfile;
      }
      const spacing = this.spacingConstants().structureSpacing;
      return spacing * Math.min(4, (protectedValue / totalValue) * 4);
    }

    legendarySamImpactMarginContext(context) {
      if (context.samImpactMarginContext) {
        return context.samImpactMarginContext;
      }
      const structures = Array.isArray(context.structures)
        ? context.priorityStructures || context.structures
        : [];
      const structureTiles = context.structureTiles;
      const completionTick = this.legendaryConstructionDuration(
        UNIT.SAMLauncher,
      );
      const routesByThreat = new Map();
      for (const threat of context.threats || []) {
        routesByThreat.set(
          threat,
          this.legendarySamImpactRoutesForThreat(
            threat,
            structures,
            structureTiles,
            completionTick,
          ),
        );
      }
      const impactContext = { completionTick, routesByThreat };
      context.samImpactMarginContext = impactContext;
      return impactContext;
    }

    legendarySamImpactRoutesForThreat(
      threat,
      structures,
      structureTiles,
