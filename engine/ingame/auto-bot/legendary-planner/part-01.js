// Auto-Bot — Legendary construction planner.
//
// Legendary is intentionally not a 1:1 Nation port. It ranks the available
// construction intents with an equal-weight max-min objective over gold and
// troops. Missile defense is a safety constraint/tie-breaker, not a third
// production axis; during an un-defended missile salvo it becomes a hard
// construction gate. Troop-cap pressure (an army at its maxTroops ceiling)
// contributes a `capacity` priority: the cheapest cap relief — a City build or
// City upgrade — then outranks non-defense intents so idle treasury is
// converted into troop-capacity growth instead of cheaper balanced assets.
// The existing structure behavior still owns buildability, cost formulas,
// upgrades, and rank-then-probe placement.

"use strict";

// Priority fields are compared before any production axis. `mandatory` and
// `safety` remain the defense-critical gates: an urgent interceptor or Defense
// Post always outranks everything else. `capacity` is the troop-cap relief
// priority: while the army sits at its maxTroops ceiling every further
// troop-second of production is lost, so an affordable City build/upgrade —
// the only action that raises the ceiling — outranks non-defense candidates
// (Port/Factory/Silo) that would otherwise win the production balance.
const LEGENDARY_PRIORITY_FIELDS = ["mandatory", "safety", "capacity"];
const LEGENDARY_PRIMARY_FIELDS = ["gold", "troops"];
const LEGENDARY_OBJECTIVE_FIELDS = [...LEGENDARY_PRIMARY_FIELDS, "defense"];
const LEGENDARY_TIE_FIELDS = ["strategic", "deficit", "netTeamGold", "efficiency"];

// The exact fallback covers normal emergency chains. It is bounded by both a
// route count and a node budget: a greedy miss is never presented as a proof
// of impossibility when the exact search is skipped or exhausted.
const LEGENDARY_EXACT_SCHEDULE_ROUTE_LIMIT = 16;
const LEGENDARY_EXACT_SCHEDULE_NODE_LIMIT = 100_000;

// Normalized marginal-role vectors. These are deliberately not combined into a
// hidden weighted sum: rankLegendaryConstructionCandidates maximizes the weakest
// productive axis first. Defense is a guardrail and tie-breaker during normal
// play, but an un-defended missile salvo is a hard safety gate.
const LEGENDARY_BASE_OBJECTIVES = {
  City: { gold: 3, troops: 5, defense: 1 },
  Factory: { gold: 3, troops: 1, defense: 1 },
  Port: { gold: 4, troops: 2, defense: 4 },
  "Missile Silo": { gold: 1, troops: 1, defense: 1 },
  "SAM Launcher": { gold: 1, troops: 1, defense: 5 },
};

function legendaryBigInt(value) {
  if (typeof value === "bigint") return value;
  {
    return BigInt(value ?? 0);
  }
}

function legendaryScoreValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

// The custom missile plan needs one conservative parity target: for each
// hostile player, sum the levels of the relevant unit and keep the largest
// enemy total. This is deliberately a max-per-enemy rather than a global sum;
// several unrelated opponents must not make one nation's target grow without
// bound.
function legendaryMaxEnemyLevelSum(enemyUnitLevels = []) {
  let maximum = 0;
  for (const levels of Array.isArray(enemyUnitLevels) ? enemyUnitLevels : []) {
    if (!Array.isArray(levels)) continue;
    const capacity = levels.reduce((total, level) => {
      let raw = level;
      if (level !== null && typeof level === "object") {
        raw = level.level ?? level.value ?? 0;
      }
      {
        if (typeof raw === "function") raw = raw();
        const number = Number(raw);
        return total +
          (Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0);
      }
    }, 0);
    maximum = Math.max(maximum, capacity);
  }
  return maximum;
}

function legendaryMaxEnemySamCapacity(enemySamLevels = []) {
  return legendaryMaxEnemyLevelSum(enemySamLevels);
}

function legendaryMaxEnemySiloCapacity(enemySiloLevels = []) {
  return legendaryMaxEnemyLevelSum(enemySiloLevels);
}

function legendaryWeaponKey(weapon) {
  return String(weapon ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
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
