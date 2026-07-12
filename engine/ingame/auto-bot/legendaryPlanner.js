// Auto-Bot — Legendary construction planner.
//
// Legendary is intentionally not a 1:1 Nation port. It ranks the available
// construction intents with an equal-weight max-min objective over gold and
// troops. Missile defense is a safety constraint/tie-breaker, not a third
// production axis. The existing structure behavior still owns buildability,
// cost formulas, upgrades, and rank-then-probe placement.

"use strict";

const LEGENDARY_PRIORITY_FIELDS = ["mandatory", "safety"];
const LEGENDARY_PRIMARY_FIELDS = ["gold", "troops"];
const LEGENDARY_OBJECTIVE_FIELDS = [...LEGENDARY_PRIMARY_FIELDS, "defense"];
const LEGENDARY_TIE_FIELDS = ["strategic", "deficit", "efficiency"];

// Normalized marginal-role vectors. These are deliberately not combined into a
// hidden weighted sum: rankLegendaryConstructionCandidates maximizes the weakest
// productive axis first. Defense is a guardrail and tie-breaker, not a reason to
// sacrifice the economy unless the candidate is marked mandatory/safe-critical.
const LEGENDARY_BASE_OBJECTIVES = {
  City: { gold: 3, troops: 5, defense: 1 },
  Factory: { gold: 3, troops: 1, defense: 1 },
  Port: { gold: 4, troops: 2, defense: 4 },
  "Missile Silo": { gold: 1, troops: 1, defense: 1 },
  "SAM Launcher": { gold: 1, troops: 1, defense: 5 },
};

function legendaryBigInt(value) {
  if (typeof value === "bigint") return value;
  try {
    return BigInt(value ?? 0);
  } catch (_error) {
    return 0n;
  }
}

function legendaryScoreValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function legendaryClamp(value, minimum, maximum) {
  return Math.min(Math.max(legendaryScoreValue(value), minimum), maximum);
}

function legendaryLog10Magnitude(value) {
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    const digits = value.toString();
    const prefixLength = Math.min(15, digits.length);
    const prefix = Number(digits.slice(0, prefixLength));
    return digits.length - prefixLength + Math.log10(Math.max(1, prefix));
  }
  const number = Math.max(0, legendaryScoreValue(value));
  return number > 0 ? Math.log10(number) : 0;
}

function legendaryRelativeMagnitude(value, baseline) {
  const numerator = legendaryLog10Magnitude(legendaryBigInt(value) + 1n);
  const denominator = legendaryLog10Magnitude(legendaryBigInt(baseline) + 1n);
  return 10 ** legendaryClamp(numerator - denominator, -2, 2);
}

// Ally strength is intentionally a max across the three user-specified power
// signals. A partner can be strategically valuable because it has troops, a
// large treasury, or a high gold-production engine; averaging would hide a
// dominant signal behind two weaker ones.
function legendaryAllyPowerScore({
  allyTroops = 0,
  allyGold = 0n,
  allyProduction = 0,
  ownTroops = 0,
  ownGold = 0n,
  ownProduction = 0,
} = {}) {
  return legendaryClamp(
    Math.max(
      legendaryRelativeMagnitude(allyTroops, ownTroops),
      legendaryRelativeMagnitude(allyGold, ownGold),
      legendaryRelativeMagnitude(allyProduction, ownProduction),
    ),
    0.25,
    4,
  );
}

function legendaryPlacementProximityScore(distance, radius) {
  const d = Math.max(0, legendaryScoreValue(distance));
  const r = Math.max(1, legendaryScoreValue(radius));
  return 1 / (1 + d / r);
}

function legendaryConstructionObjectiveVector(type, context = {}) {
  const base = LEGENDARY_BASE_OBJECTIVES[type] ?? {
    gold: 0,
    troops: 0,
    defense: 0,
  };
  const connectedCities = Math.max(0, legendaryScoreValue(context.connectedCities));
  const cityRailConnection = legendaryClamp(
    context.cityRailConnection ?? 1,
    0,
    1,
  );
  const railNeed = legendaryClamp(context.railNeed ?? 1, 0.25, 2.5);
  const tradeNeed = legendaryClamp(context.tradeNeed ?? 1, 0.25, 2.5);
  const destroyerNeed = legendaryClamp(
    context.destroyerNeed ?? 1,
    0.25,
    2.5,
  );
  const defenseGap = legendaryClamp(context.defenseGap ?? 1, 0.25, 2.5);
  const costFactor = legendaryClamp(context.costFactor ?? 1, 0.25, 1);
  const portSurvivability = legendaryClamp(
    context.portSurvivability ?? 1,
    0.35,
    1,
  );

  let vector;

  switch (type) {
    case "City":
      vector = {
        gold: (base.gold * cityRailConnection) / (1 + connectedCities),
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "Factory":
      vector = {
        gold: base.gold * railNeed,
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "Port":
      vector = {
        gold: base.gold * tradeNeed,
        troops: base.troops * portSurvivability,
        defense: base.defense * destroyerNeed * portSurvivability,
      };
      break;
    case "Missile Silo":
      vector = {
        gold: base.gold,
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "SAM Launcher":
      vector = {
        gold: base.gold,
        troops: base.troops,
        defense: base.defense * defenseGap,
      };
      break;
    default:
      vector = { ...base };
  }

  return Object.fromEntries(
    LEGENDARY_OBJECTIVE_FIELDS.map((field) => [
      field,
      legendaryScoreValue(vector[field]) * costFactor,
    ]),
  );
}

// Conservative upper-bound threat model used as a construction safety gate.
// It intentionally models what an opponent can do now, not what they are
// statistically likely to do: silo levels, enough gold for Atom/Hydrogen,
// remaining flight time, and the value clustered inside the blast area all
// contribute. A SAM interception capacity reduces, but never erases, risk.
function legendaryMissileThreatScore(context = {}) {
  const silos = Array.isArray(context.enemySilos) ? context.enemySilos : [];
  const siloCapacity = silos.reduce(
    (total, silo) => total + Math.max(0, legendaryScoreValue(silo.level ?? silo)),
    0,
  );
  const enemyGold = legendaryBigInt(context.enemyGold ?? 0n);
  const atomCost = legendaryBigInt(context.atomCost ?? 0n);
  const hydrogenCost = legendaryBigInt(context.hydrogenCost ?? 0n);
  const canAtom = atomCost > 0n && enemyGold >= atomCost;
  const canHydrogen = hydrogenCost > 0n && enemyGold >= hydrogenCost;
  if (siloCapacity <= 0 || (!canAtom && !canHydrogen)) {
    return {
      score: 0,
      critical: false,
      weapon: null,
      siloCapacity,
      flightUrgency: 0,
      exposure: 0,
    };
  }

  const weapon = canHydrogen ? "HydrogenBomb" : "AtomBomb";
  const blastArea = Math.max(
    1,
    legendaryScoreValue(
      canHydrogen
        ? context.hydrogenBlastArea ?? context.hydrogenRadius
        : context.atomBlastArea ?? context.atomRadius,
    ),
  );
  const vulnerableBlastArea = Math.max(
    0,
    legendaryScoreValue(context.vulnerableBlastArea),
  );
  const vulnerableStructures = Math.max(
    0,
    legendaryScoreValue(context.vulnerableStructures),
  );
  const exposure =
    context.vulnerableExposure === undefined
      ? Math.min(
          1,
          (vulnerableBlastArea + vulnerableStructures) / blastArea,
        )
      : legendaryClamp(context.vulnerableExposure, 0, 1);
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
  const weaponFactor = canHydrogen ? 1.5 : 1;
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
}

// Simulates the short chained-salvo window that experienced opponents use:
// cheap atoms consume the SAM interception slots, then a hydrogen bomb arrives
// before the SAM cooldown can restore them. `marginTicks` is both the minimum
// time-to-impact safety margin and the minimum separation we accept between the
// atom chain and the hydrogen finisher.
function legendaryMissileSalvoRisk({
  atomArrivalTicks = [],
  hydrogenArrivalTick = null,
  interceptionCapacity = 0,
  samCooldownTicks = 90,
  marginTicks = 5,
} = {}) {
  const atoms = atomArrivalTicks
    .map((tick) => legendaryScoreValue(tick))
    .filter((tick) => Number.isFinite(tick) && tick >= 0)
    .sort((a, b) => a - b);
  const capacity = Math.max(0, Math.floor(legendaryScoreValue(interceptionCapacity)));
  const cooldown = Math.max(1, legendaryScoreValue(samCooldownTicks));
  const margin = Math.max(1, legendaryScoreValue(marginTicks));
  let slotsUsed = 0;
  let lastInterceptTick = null;
  let atomIntercepted = 0;
  let atomGetsThrough = 0;

  for (const arrivalTick of atoms) {
    if (
      lastInterceptTick !== null &&
      arrivalTick - lastInterceptTick >= cooldown
    ) {
      slotsUsed = 0;
    }
    if (slotsUsed < capacity) {
      slotsUsed++;
      atomIntercepted++;
      lastInterceptTick = arrivalTick;
    } else {
      atomGetsThrough++;
    }
  }

  const hydrogenArrival =
    hydrogenArrivalTick === null || hydrogenArrivalTick === undefined
      ? null
      : legendaryScoreValue(hydrogenArrivalTick);
  let hydrogenIntercepted = false;
  if (hydrogenArrival !== null) {
    if (
      lastInterceptTick !== null &&
      hydrogenArrival - lastInterceptTick >= cooldown
    ) {
      slotsUsed = 0;
    }
    if (slotsUsed < capacity) {
      hydrogenIntercepted = true;
      slotsUsed++;
      lastInterceptTick = hydrogenArrival;
    }
  }

  const lastAtomArrival = atoms.length > 0 ? atoms[atoms.length - 1] : 0;
  const chainSeparation =
    hydrogenArrival === null ? Infinity : hydrogenArrival - lastAtomArrival;
  const marginSatisfied =
    hydrogenArrival === null ||
    (hydrogenArrival >= margin && chainSeparation >= margin);
  const hydrogenGetsThrough =
    hydrogenArrival !== null && !hydrogenIntercepted;

  return {
    risk: hydrogenGetsThrough
      ? 1
      : atomGetsThrough > 0
        ? 0.5
        : marginSatisfied
          ? 0
          : 0.75,
    critical: hydrogenGetsThrough || !marginSatisfied,
    hydrogenGetsThrough,
    hydrogenIntercepted,
    atomIntercepted,
    atomGetsThrough,
    chainSeparation,
    marginSatisfied,
    timeToImpactTicks: hydrogenArrival ?? atoms[0] ?? Infinity,
  };
}

function legendaryObjectiveBalance(candidate) {
  return Math.min(
    ...LEGENDARY_PRIMARY_FIELDS.map((field) =>
      legendaryScoreValue(candidate[field]),
    ),
  );
}

function legendaryObjectiveTotal(candidate) {
  return LEGENDARY_PRIMARY_FIELDS.reduce(
    (total, field) => total + legendaryScoreValue(candidate[field]),
    0,
  );
}

function compareLegendaryCandidates(left, right) {
  for (const field of LEGENDARY_PRIORITY_FIELDS) {
    const a = legendaryScoreValue(left[field]);
    const b = legendaryScoreValue(right[field]);
    if (a !== b) return b - a;
  }

  const leftBalance = legendaryObjectiveBalance(left);
  const rightBalance = legendaryObjectiveBalance(right);
  if (leftBalance !== rightBalance) return rightBalance - leftBalance;

  const leftTotal = legendaryObjectiveTotal(left);
  const rightTotal = legendaryObjectiveTotal(right);
  if (leftTotal !== rightTotal) return rightTotal - leftTotal;

  const leftDefense = legendaryScoreValue(left.defense);
  const rightDefense = legendaryScoreValue(right.defense);
  if (leftDefense !== rightDefense) return rightDefense - leftDefense;

  for (const field of LEGENDARY_TIE_FIELDS) {
    const a = legendaryScoreValue(left[field]);
    const b = legendaryScoreValue(right[field]);
    if (a !== b) return b - a;
  }

  const leftCost = legendaryBigInt(left.cost);
  const rightCost = legendaryBigInt(right.cost);
  if (leftCost !== rightCost) return leftCost < rightCost ? -1 : 1;

  const leftOrder = legendaryScoreValue(left.typeOrder);
  const rightOrder = legendaryScoreValue(right.typeOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  return String(left.type ?? "").localeCompare(String(right.type ?? ""));
}

function rankLegendaryConstructionCandidates(candidates, options = {}) {
  const gold = legendaryBigInt(options.gold ?? 0n);
  const reserve = legendaryBigInt(options.reserve ?? 0n);
  const available = gold > reserve ? gold - reserve : 0n;

  return candidates
    .filter((candidate) => {
      if (!candidate || candidate.legal === false || candidate.affordable === false) {
        return false;
      }
      return legendaryBigInt(candidate.cost) <= available;
    })
    .slice()
    .sort(compareLegendaryCandidates);
}

function chooseLegendaryConstructionCandidate(candidates, options = {}) {
  return rankLegendaryConstructionCandidates(candidates, options)[0] ?? null;
}
