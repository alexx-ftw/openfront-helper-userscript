      for (const source of inputs.ownPortProducerSources ?? []) {
        const routes = Array.isArray(source.routes) ? source.routes : [];
        if (routes.length === 0) continue;
        const routeKey = routes.map((route) => [
          route.weight,
          route.postAllianceWeight,
          route.distance,
          route.teamGoldPerArrival,
          route.postAllianceGoldPerArrival,
          route.allianceTicksRemaining,
        ].join(":")).join(",");
        const key = `${source.level}:${source.readyAtTicks}:${routeKey}`;
        let group = ownPortGroups.get(key);
        if (!group) {
          group = { ...source, count: 0, structureIds: [] };
          ownPortGroups.set(key, group);
        }
        group.count++;
        group.structureIds.push(String(source.structureId ?? ""));
      }
      for (const source of ownPortGroups.values()) {
        const count = Math.max(
          0,
          source.count - Number(
            inputs.upgradeAction === true && source.structureIds.includes(targetId),
          ),
        );
        if (count === 0) continue;
        const level = Math.max(1, Math.floor(Number(source.level) || 1));
        const readyAt = Math.max(0, Number(source.readyAtTicks) || 0);
        totalTeamGold += count * (
          routeIncome(source, level, false, readyAt, "after") -
          routeIncome(source, level, false, readyAt, "before")
        );
      }
    }
    if (totalTeamGold <= 0) {
      return type === "Port" &&
          inputs.portSeedWindowOpen === true &&
          inputs.portSeedPartnerCommitted !== true
        ? null
        : { refused: true };
    }
    incomePerTick = totalTeamGold / productiveTicks;
  } else {
    return null;
  }

  const eligibleTicks = productiveTicks;
  const teamGold = incomePerTick * eligibleTicks;
  return {
    netTeamGold: teamGold - costNumber,
    paybackTicks:
      incomePerTick > 0 ? costNumber / incomePerTick : Infinity,
    incomePerTick,
    productiveTicks: eligibleTicks,
    ...(factoryPlacementTile === undefined
      ? {}
      : { factoryPlacementTile }),
    ...(portPlacementTile === undefined ? {} : { portPlacementTile }),
  };
}

// Preserve the synchronous API for pure callers and exact numerical regressions.
function legendaryEconomyNetGold(type, options) {
  return legendaryDrainEconomySteps(legendaryEconomyNetGoldSteps(type, options));
}

function legendaryEconomyNetGoldAsync(type, options, scheduling = {}) {
  return legendaryRunEconomyStepsAsync(
    legendaryEconomyNetGoldSteps(type, options),
    scheduling,
  );
}

// Conservative upper-bound threat model used as a construction safety gate.
// It intentionally models what an opponent can do now, not what they are
// statistically likely to do: silo levels, enough gold for Atom/Hydrogen,
// remaining flight time, and the value clustered inside the blast area all
// contribute. A SAM interception capacity reduces, but never erases, risk.
function legendaryMissileWeapon(context, enemyGold) {
  const atomCost = legendaryBigInt(context.atomCost ?? 0n);
  const hydrogenCost = legendaryBigInt(context.hydrogenCost ?? 0n);
  if (hydrogenCost > 0n && enemyGold >= hydrogenCost) return "HydrogenBomb";
  if (atomCost > 0n && enemyGold >= atomCost) return "AtomBomb";
  return null;
}

function legendaryMissileExposure(context, weapon) {
  if (context.vulnerableExposure !== undefined) {
    return legendaryClamp(context.vulnerableExposure, 0, 1);
  }
  const blastValue = weapon === "HydrogenBomb"
    ? context.hydrogenBlastArea ?? context.hydrogenRadius
    : context.atomBlastArea ?? context.atomRadius;
  const blastArea = Math.max(1, legendaryScoreValue(blastValue));
  const vulnerableBlastArea = Math.max(0, legendaryScoreValue(context.vulnerableBlastArea));
  const vulnerableStructures = Math.max(0, legendaryScoreValue(context.vulnerableStructures));
  return Math.min(1, (vulnerableBlastArea + vulnerableStructures) / blastArea);
}

function emptyLegendaryMissileThreat(siloCapacity) {
  return {
    score: 0,
    critical: false,
    weapon: null,
    siloCapacity,
    flightUrgency: 0,
    exposure: 0,
  };
}

function legendaryMissileThreatScore(context = {}) {
  const silos = Array.isArray(context.enemySilos) ? context.enemySilos : [];
  const siloCapacity = silos.reduce(
    (total, silo) => total + Math.max(0, legendaryScoreValue(silo.level ?? silo)),
    0,
  );
  const enemyGold = legendaryBigInt(context.enemyGold ?? 0n);
  const weapon = legendaryMissileWeapon(context, enemyGold);
  if (siloCapacity <= 0 || weapon === null) return emptyLegendaryMissileThreat(siloCapacity);
  const exposure = legendaryMissileExposure(context, weapon);
  const flightTimeTicks = Math.max(
    0,
    legendaryScoreValue(context.flightTimeTicks),
  );
  const flightUrgency = 1 / (1 + flightTimeTicks);
  const interceptionCapacity = Math.max(
    0,
    legendaryScoreValue(context.interceptionCapacity),
  );
  const survivableSalvo = Math.max(0, siloCapacity - interceptionCapacity);
  const interceptionFactor = Math.max(
    0.25,
    (survivableSalvo + 1) / (siloCapacity + 1),
  );
  const weaponFactor = weapon === "HydrogenBomb" ? 1.5 : 1;
  const readyShots = Math.min(
    siloCapacity,
    Math.max(0, legendaryScoreValue(context.readyShots ?? siloCapacity)),
  );
  const readinessFactor =
    0.5 + 0.5 * (readyShots / Math.max(1, siloCapacity));
  const salvoRisk = context.salvoRisk ?? null;
  const salvoFactor = salvoRisk
    ? 1 + 0.75 * legendaryClamp(salvoRisk.risk, 0, 1)
    : 1;
  const score =
    siloCapacity *
    weaponFactor *
    (1 + exposure) *
    flightUrgency *
    interceptionFactor *
    readinessFactor *
    salvoFactor;
  const criticalThreshold = Math.max(
    0,
    legendaryScoreValue(context.criticalThreshold ?? 0.75),
  );

  return {
    score,
    critical: score >= criticalThreshold || Boolean(salvoRisk?.critical),
    weapon,
    siloCapacity,
    flightUrgency,
    exposure,
    interceptionFactor,
    readyShots,
    salvoRisk,
  };
