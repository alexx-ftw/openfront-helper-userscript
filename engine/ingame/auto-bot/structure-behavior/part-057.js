        {
          fromTile: motion?.fromTile ?? input.fromTile,
          targetTile: input.targetTile,
          impactTick: flightTimeTicks,
          launchOffset: motion?.launchOffset ?? 0,
          weapon: input.type,
          id: `active:${String(nukeId)}`,
          path: motion?.path ?? null,
        },
        input.samProfiles,
      );
      const salvoRisk = legendaryMissileSalvoRisk({
        atomArrivalTicks:
          input.type === UNIT.HydrogenBomb ? [] : [flightTimeTicks],
        hydrogenArrivalTick:
          input.type === UNIT.HydrogenBomb ? flightTimeTicks : null,
        interceptionCapacity,
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        routes: [route],
        samProfiles: input.samProfiles,
        completionTick: 0,
      });
      return this.legendaryActiveMissileThreatResult({
        input,
        flightTimeTicks,
        interceptionCapacity,
        route,
        salvoRisk,
      });
    }

    legendaryActiveMissileThreatResult({
      input,
      flightTimeTicks,
      interceptionCapacity,
      route,
      salvoRisk,
    }) {
      const { atomCost, hydrogenCost, totalValue, atomRadius, hydrogenRadius } =
        input.context;
      const score = legendaryMissileThreatScore({
        enemySilos: [{ level: 1 }],
        enemyGold: this.legendaryMissileThreatGold(
          input.type,
          atomCost,
          hydrogenCost,
        ),
        atomCost: atomCost > 0n ? atomCost : 1n,
        hydrogenCost: hydrogenCost > 0n ? hydrogenCost : 1n,
        flightTimeTicks,
        vulnerableExposure:
          totalValue > 0 ? Math.min(1, input.exposure.value / totalValue) : 0,
        vulnerableStructures: input.exposure.count,
        vulnerableBlastArea: Math.max(1, input.exposure.radiusSquared),
        atomBlastArea: Math.max(1, atomRadius * atomRadius),
        hydrogenBlastArea: Math.max(1, hydrogenRadius * hydrogenRadius),
        interceptionCapacity,
        readyShots: 1,
        salvoRisk,
      });
      return {
        ...score,
        score: Math.max(
          score.score,
          flightTimeTicks < LEGENDARY_SAM_IMPACT_MARGIN_TICKS ? 2 : 0,
        ),
        critical: !salvoRisk.fullyDefended,
        inFlight: true,
        nuke: input.nuke,
        targetTile: input.targetTile,
        weapon: input.type,
        enemySilos: [],
        enemyGold:
          input.type === UNIT.HydrogenBomb ? hydrogenCost : atomCost,
        salvoPlan: {
          risk: salvoRisk,
          readyShots: 1,
          schedule: salvoRisk,
          routes: [route],
          samProfiles: input.samProfiles,
        },
        flightTimeTicks,
      };
    }

    legendaryMissileThreatGold(type, atomCost, hydrogenCost) {
      const preferred = type === UNIT.HydrogenBomb ? hydrogenCost : atomCost;
      return preferred > 0n ? preferred : 1n;
    }

    missileDefenseStateTaggedValue(value) {
      if (value === undefined) return ["undefined"];
      if (value === null) return ["null"];
      if (Array.isArray(value)) {
        const slots = [];
        for (let index = 0; index < value.length; index++) {
          slots.push(
            index in value
              ? this.missileDefenseStateTaggedValue(value[index])
              : ["hole"],
          );
        }
        return ["array", value.length, slots];
      }
      if (typeof value === "bigint") return ["bigint", value.toString()];
      if (typeof value === "number") {
        if (Number.isNaN(value)) return ["number", "NaN"];
        if (Object.is(value, -0)) return ["number", "-0"];
        return ["number", String(value)];
      }
      return [typeof value, value];
    }

    missileDefenseStateRecordKey(fields) {
      const taggedFields = [];
      for (const field of fields) {
        taggedFields.push(this.missileDefenseStateTaggedValue(field));
      }
      return JSON.stringify(["record", taggedFields]);
    }

    addMissileDefenseStateRecord(representation, fields) {
      const key = this.missileDefenseStateRecordKey(fields);
      representation.set(key, (representation.get(key) ?? 0) + 1);
    }

    missileDefenseUnitStateFields(unit) {
      return [
        unit.id?.(),
        unit.tile?.(),
        unit.level?.(),
        unit.isUnderConstruction?.(),
        unit.isActive?.(),
        unit.missileTimerQueue?.(),
      ];
    }

    appendMissileDefenseStateUnits(representation, label, owner, types) {
      for (const type of types) {
        const units =
          typeof owner?.units === "function" ? owner.units(type) : null;
        this.addMissileDefenseStateRecord(representation, [
          "unit-collection",
          label,
          type,
          Array.isArray(units),
          Array.isArray(units) ? units.length : null,
        ]);
        if (!Array.isArray(units)) continue;
        for (const unit of units) {
          if (!unit) continue;
          this.addMissileDefenseStateRecord(representation, [
            "unit",
            label,
            type,
            ...this.missileDefenseUnitStateFields(unit),
          ]);
        }
      }
    }
