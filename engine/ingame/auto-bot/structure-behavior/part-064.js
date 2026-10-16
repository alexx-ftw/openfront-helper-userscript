        enemySilos,
        enemySiloLevels,
        enemyGold,
        targetTile: target.tile,
        salvoPlan,
      };
    }

    legendaryMissilePlacementRisk(tile, type, context) {
      if (!context || !Array.isArray(context.threats)) return 0;
      let candidateValue = 1;
      if (type === UNIT.MissileSilo) candidateValue = 3;
      if (type === UNIT.Factory || type === UNIT.Port) candidateValue = 4;
      if (type === UNIT.City) candidateValue = 5;
      let worstRisk = this.legendaryActivePlacementRisk(tile, context);
      for (const threat of context.threats) {
        if (threat.inFlight) continue;
        worstRisk = Math.max(
          worstRisk,
          this.legendaryProspectivePlacementRisk(
            tile,
            candidateValue,
            threat,
            context,
          ),
        );
      }
      return worstRisk;
    }

    legendaryActivePlacementRisk(tile, context) {
      let risk = 0;
      for (const active of context.activeMissiles || []) {
        const radius =
          active.weapon === UNIT.HydrogenBomb
            ? context.hydrogenRadius
            : context.atomRadius;
        if (active.targetTile === null || active.targetTile === undefined) continue;
        if (
          this.game.euclideanDistSquared(tile, active.targetTile) <= radius * radius
        ) {
          risk = Math.max(risk, Number(active.score || 0));
        }
      }
      return risk;
    }

    legendaryProspectivePlacementRisk(tile, candidateValue, threat, context) {
      const exposure = this.legendaryCandidateMissileExposure(
        tile,
        candidateValue,
        threat,
        context,
      );
      const shotPlan = this.legendaryCandidateShotPlan(tile, threat, context);
      if (shotPlan === null) return 0;
      let interceptionCapacity = 0;
      for (const silo of threat.enemySilos || []) {
        interceptionCapacity += this.legendaryCachedSamInterceptionCapacity(
          silo,
          tile,
          context,
        );
      }
      const salvoRisk = legendaryMissileSalvoRisk({
        atomArrivalTicks: shotPlan.atomArrivalTicks,
        hydrogenArrivalTick: shotPlan.hydrogenArrivalTick,
        interceptionCapacity,
        samCooldownTicks: this.legendarySamCooldownTicks(),
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        readyShots: shotPlan.sourcePlan.readyShots ?? 0,
        routes: null,
        samProfiles: [],
        completionTick: 0,
      });
      let enemySiloLevels = threat.enemySiloLevels;
      if (!enemySiloLevels) {
        enemySiloLevels = [];
        for (const unit of threat.enemySilos || []) {
          enemySiloLevels.push({ level: unit.level() });
        }
      }
      const risk = legendaryMissileThreatScore({
        enemySilos: enemySiloLevels,
        enemyGold: threat.enemyGold,
        atomCost: context.atomCost,
        hydrogenCost: context.hydrogenCost,
        flightTimeTicks: shotPlan.nearestFlightTime,
        vulnerableExposure: exposure.ratio,
        vulnerableStructures: exposure.count,
        vulnerableBlastArea: exposure.ratio,
        atomBlastArea: Math.max(1, context.atomRadius * context.atomRadius),
        hydrogenBlastArea: Math.max(
          1,
          context.hydrogenRadius * context.hydrogenRadius,
        ),
        interceptionCapacity,
        readyShots: shotPlan.sourcePlan.readyShots ?? 0,
        salvoRisk,
      });
      return risk.score;
    }

    legendaryCachedSamInterceptionCapacity(
      silo,
      targetTile,
      context = null,
      samProfilesOverride = null,
    ) {
      const samProfiles = samProfilesOverride ?? context?.samProfiles;
      const cache = context?.interceptionCapacityCache;
      if (
        !cache ||
        typeof cache.get !== "function" ||
        typeof cache.set !== "function"
      ) {
        const fromTile =
          typeof silo?.tile === "function" ? silo.tile() : silo;
        return this.legendarySamInterceptionCapacity(
          fromTile,
          targetTile,
          null,
          samProfiles,
        );
      }
      let byTarget = cache.get(silo);
      if (!byTarget) {
        byTarget = new Map();
        cache.set(silo, byTarget);
      }
      if (byTarget.has(targetTile)) return byTarget.get(targetTile);
      const fromTile =
        typeof silo?.tile === "function" ? silo.tile() : silo;
      const capacity = this.legendarySamInterceptionCapacity(
        fromTile,
        targetTile,
        null,
        samProfiles,
      );
      byTarget.set(targetTile, capacity);
      return capacity;
    }

    legendaryCandidateMissileExposure(tile, candidateValue, threat, context) {
      const radius =
        threat.weapon === UNIT.HydrogenBomb
          ? context.hydrogenRadius
          : context.atomRadius;
      const radiusSquared = radius * radius;
      let value = candidateValue;
      let count = 1;
      const structureValues = context.structureValues;
      const structureTiles = context.structureTiles;
      for (const structure of
        context.priorityStructures || context.structures || []) {
        const structureTile = structureTiles?.has(structure)
          ? structureTiles.get(structure)
          : structure.tile();
        if (
          this.game.euclideanDistSquared(tile, structureTile) > radiusSquared
