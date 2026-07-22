// Auto-Bot — Legendary construction planner.
//
// Legendary is intentionally not a 1:1 Nation port. It ranks the available
// construction intents with an equal-weight max-min objective over gold and
// troops. Missile defense is a safety constraint/tie-breaker, not a third
// production axis; during an un-defended missile salvo it becomes a hard
// construction gate. The existing structure behavior still owns buildability,
// cost formulas, upgrades, and rank-then-probe placement.

"use strict";

const LEGENDARY_PRIORITY_FIELDS = ["mandatory", "safety"];
const LEGENDARY_PRIMARY_FIELDS = ["gold", "troops"];
const LEGENDARY_OBJECTIVE_FIELDS = [...LEGENDARY_PRIMARY_FIELDS, "defense"];
const LEGENDARY_TIE_FIELDS = ["strategic", "deficit", "efficiency"];

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
}

// Simulates the short chained-salvo window that experienced opponents use:
// cheap atoms consume the SAM interception slots, then a hydrogen bomb arrives
// before the SAM cooldown can restore them. `marginTicks` is both the minimum
// time-to-impact safety margin and the minimum separation we accept between the
// atom chain and the hydrogen finisher.
function legendaryRouteMissileSalvoRisk(options) {
    const schedule = options.scheduleOverride || legendaryMissileDefenseSchedule({
      routes: options.routes,
      samProfiles: options.samProfiles,
      samCooldownTicks: options.samCooldownTicks,
      marginTicks: options.marginTicks,
      completionTick: options.completionTick,
    });
    const atomResults = schedule.missiles.filter(
      (missile) => legendaryWeaponKey(missile.weapon) === "atombomb",
    );
    const hydrogenResult = schedule.missiles.find(
      (missile) => legendaryWeaponKey(missile.weapon) === "hydrogenbomb",
    );
    const atomGetsThrough = atomResults.filter(
      (missile) => !missile.intercepted,
    ).length;
    const hydrogenGetsThrough = Boolean(
      hydrogenResult && !hydrogenResult.intercepted,
    );
    const marginSatisfied = schedule.completionMarginTicks >= options.marginTicks;
    let risk = 0;
    if (!schedule.fullyDefended) risk = 1;
    else if (!marginSatisfied) risk = 0.75;
    else if (schedule.minimumInterceptMarginTicks < 1) risk = 0.5;
    const lastAtomArrival =
      options.atomArrivalTicks.length > 0
        ? options.atomArrivalTicks[options.atomArrivalTicks.length - 1]
        : 0;
    return {
      ...schedule,
      risk,
      // Completion margin is a gate for a *new action*, not evidence that an
      // already-complete current SAM network is failing. Keep those concepts
      // separate so a fully defended target does not trigger a redundant SAM.
      critical: !schedule.fullyDefended,
      hydrogenGetsThrough,
      hydrogenIntercepted: Boolean(
        hydrogenResult && hydrogenResult.intercepted,
      ),
      atomIntercepted: atomResults.filter((missile) => missile.intercepted)
        .length,
      atomGetsThrough,
      chainSeparation:
        options.hydrogenArrivalTick == null
          ? Infinity
          : options.hydrogenArrivalTick - lastAtomArrival,
      marginSatisfied,
      timeToImpactTicks: schedule.firstImpactTick,
    };
}

function legendaryAggregateMissileSalvoRisk({
  atomArrivalTicks,
  hydrogenArrivalTick,
  interceptionCapacity,
  samCooldownTicks,
  marginTicks,
}) {
  const atoms = atomArrivalTicks
    .map((tick) => legendaryScoreValue(tick))
    .filter((tick) => Number.isFinite(tick) && tick >= 0)
    .sort((a, b) => a - b);
  const capacity = Math.max(0, Math.floor(legendaryScoreValue(interceptionCapacity)));
  const cooldown = Math.max(1, legendaryScoreValue(samCooldownTicks));
  const margin = Math.max(1, legendaryScoreValue(marginTicks));
  const atomState = simulateLegendaryAtomSalvo(atoms, capacity, cooldown);
  const hydrogenArrival = hydrogenArrivalTick == null
    ? null
    : legendaryScoreValue(hydrogenArrivalTick);
  const hydrogenIntercepted = legendaryHydrogenIntercepted(
    hydrogenArrival,
    atomState,
    capacity,
    cooldown,
  );
  const lastAtomArrival = atoms.length > 0 ? atoms[atoms.length - 1] : 0;
  const chainSeparation = hydrogenArrival === null ? Infinity : hydrogenArrival - lastAtomArrival;
  const marginSatisfied =
    hydrogenArrival === null ||
    (hydrogenArrival >= margin && chainSeparation >= margin);
  const hydrogenGetsThrough = hydrogenArrival !== null && !hydrogenIntercepted;
  let risk = 0;
  if (hydrogenGetsThrough) risk = 1;
  else if (atomState.getsThrough > 0) risk = 0.5;
  else if (!marginSatisfied) risk = 0.75;
  return {
    risk,
    critical: hydrogenGetsThrough || !marginSatisfied,
    hydrogenGetsThrough,
    hydrogenIntercepted,
    atomIntercepted: atomState.intercepted,
    atomGetsThrough: atomState.getsThrough,
    chainSeparation,
    marginSatisfied,
    timeToImpactTicks: hydrogenArrival ?? atoms[0] ?? Infinity,
  };
}

function simulateLegendaryAtomSalvo(atoms, capacity, cooldown) {
  let slotsUsed = 0;
  let lastInterceptTick = null;
  let intercepted = 0;
  let getsThrough = 0;
  for (const arrivalTick of atoms) {
    if (
      lastInterceptTick !== null &&
      arrivalTick - lastInterceptTick >= cooldown
    ) {
      slotsUsed = 0;
    }
    if (slotsUsed < capacity) {
      slotsUsed++;
      intercepted++;
      lastInterceptTick = arrivalTick;
    } else {
      getsThrough++;
    }
  }
  return { slotsUsed, lastInterceptTick, intercepted, getsThrough };
}

function legendaryHydrogenIntercepted(arrival, atomState, capacity, cooldown) {
  if (arrival === null) return false;
  const reloaded =
    atomState.lastInterceptTick !== null &&
    arrival - atomState.lastInterceptTick >= cooldown;
  return (reloaded ? 0 : atomState.slotsUsed) < capacity;
}

function legendaryMissileSalvoRisk(options = {}) {
  const normalized = {
    atomArrivalTicks: options.atomArrivalTicks ?? [],
    hydrogenArrivalTick: options.hydrogenArrivalTick ?? null,
    interceptionCapacity: options.interceptionCapacity ?? 0,
    samCooldownTicks: options.samCooldownTicks ?? 90,
    marginTicks: options.marginTicks ?? 5,
    routes: options.routes ?? null,
    samProfiles: options.samProfiles ?? [],
    completionTick: options.completionTick ?? 0,
    scheduleOverride: options.scheduleOverride ?? null,
  };
  return Array.isArray(normalized.routes)
    ? legendaryRouteMissileSalvoRisk(normalized)
    : legendaryAggregateMissileSalvoRisk(normalized);
}

// Defensive scheduling primitive for Legendary. Each route is an
// incoming missile and each `samOption` lists the trajectory ticks at which a
// particular SAM can fire. The option ticks are absolute relative to the
// current bot tick, so a SAM that finishes construction at tick 300 cannot be
// assigned a trajectory opportunity at tick 80.
//
// The 5-tick constant is deliberately applied to `completionMarginTicks`:
// `firstImpactTick - actionCompletionTick`. It is not a vague urgency bonus and
// it is not incorrectly added to every interception. A new SAM is therefore a
// valid emergency investment only when it completes at least five ticks before
// the first landing AND the individual ready/reloading slots can stop every
// missile. Existing SAMs and instant upgrades use actionCompletionTick = 0.
function normalizeLegendarySamProfiles(samProfiles, cooldown) {
  return (Array.isArray(samProfiles) ? samProfiles : []).map((profile, index) => {
    const rawAvailability = Array.isArray(profile?.availableTicks)
      ? profile.availableTicks
      : Array(Math.max(0, Math.floor(legendaryScoreValue(profile?.readyShots)))).fill(0);
    return {
      id: profile?.id ?? index,
      availableTicks: rawAvailability
        .map(Number)
        .filter((tick) => Number.isFinite(tick) && tick >= 0)
        .sort((a, b) => a - b),
      cooldownTicks: Math.max(1, legendaryScoreValue(profile?.cooldownTicks ?? cooldown)),
      fireIntervalTicks: Math.max(1, legendaryScoreValue(profile?.fireIntervalTicks ?? 1)),
    };
  });
}

function normalizeLegendarySamOption(option, impactTick, profileCount) {
  const samIndex = Math.floor(Number(option?.samIndex));
  if (!Number.isFinite(samIndex) || samIndex < 0 || samIndex >= profileCount) return null;
  const rawTicks = Array.isArray(option?.interceptTicks)
    ? option.interceptTicks
    : [option?.interceptTick];
  const interceptTicks = rawTicks
    .map(legendaryScoreValue)
    .filter((tick) => Number.isFinite(tick) && tick >= 0 && tick <= impactTick)
    .sort((a, b) => a - b);
  return interceptTicks.length ? { samIndex, interceptTicks } : null;
}

function normalizeLegendaryMissileRoute(route, routeIndex, profileCount) {
  const impactTick = Number(route?.impactTick);
  if (!Number.isFinite(impactTick) || impactTick < 0) return null;
  let rawOptions = route?.samOptions;
  if (!Array.isArray(rawOptions)) {
    const candidates = Array.isArray(route?.samCandidates) ? route.samCandidates : [];
    const defaultTick = Number.isFinite(Number(route?.interceptTick))
      ? Number(route.interceptTick)
      : Math.max(0, impactTick);
    rawOptions = candidates.map((samIndex) => ({ samIndex, interceptTicks: [defaultTick] }));
  }
  return {
    ...route,
    id: route?.id ?? routeIndex,
    impactTick,
    samOptions: rawOptions
      .map((option) => normalizeLegendarySamOption(option, impactTick, profileCount))
      .filter(Boolean),
  };
}

function normalizeLegendaryMissileRoutes(routes, profileCount) {
  return (Array.isArray(routes) ? routes : [])
    .map((route, index) => normalizeLegendaryMissileRoute(route, index, profileCount))
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.impactTick - right.impactTick ||
        left.samOptions.length - right.samOptions.length ||
        String(left.id).localeCompare(String(right.id)),
    );
}

function buildLegendaryFutureSamUse(routes, profileCount) {
  const futureUseByRoute = routes.map(() => Array(profileCount).fill(0));
  const counts = Array(profileCount).fill(0);
  for (let index = routes.length - 1; index >= 0; index--) {
    futureUseByRoute[index] = counts.slice();
    const used = new Set(routes[index].samOptions.map((option) => option.samIndex));
    for (const samIndex of used) counts[samIndex]++;
  }
  return futureUseByRoute;
}

function collectLegendaryFeasibleAssignments(context, routeIndex, slots, fireTicks) {
  const route = context.routes[routeIndex];
  const feasible = [];
  for (const option of route.samOptions) {
    const profile = context.profiles[option.samIndex];
    for (let slotIndex = 0; slotIndex < slots[option.samIndex].length; slotIndex++) {
      const availableAt = slots[option.samIndex][slotIndex];
      const launcherAvailableAt = Math.max(availableAt, fireTicks[option.samIndex] ?? 0);
      const interceptTick = option.interceptTicks.find(
        (tick) => tick >= launcherAvailableAt && tick <= route.impactTick,
      );
      if (interceptTick === undefined) continue;
      feasible.push({
        samIndex: option.samIndex,
        slotIndex,
        availableAt,
        interceptTick,
        futureUse: context.futureUse[routeIndex][option.samIndex] ?? 0,
        cooldownTicks: profile.cooldownTicks,
        fireIntervalTicks: profile.fireIntervalTicks,
      });
    }
  }
  return feasible.sort(
    (left, right) =>
      left.futureUse - right.futureUse ||
      left.interceptTick - right.interceptTick ||
      left.availableAt - right.availableAt ||
      left.samIndex - right.samIndex ||
      left.slotIndex - right.slotIndex,
  );
}

function applyLegendarySamAssignment(slots, fireTicks, assignment) {
  slots[assignment.samIndex][assignment.slotIndex] =
    assignment.interceptTick + assignment.cooldownTicks;
  slots[assignment.samIndex].sort((left, right) => left - right);
  fireTicks[assignment.samIndex] = assignment.interceptTick + assignment.fireIntervalTicks;
}

function legendaryScheduledMissile(route, assignment) {
  if (!assignment) {
    return { ...route, intercepted: false, interceptTick: null, marginTicks: 0, samIndex: null };
  }
  return {
    ...route,
    intercepted: true,
    interceptTick: assignment.interceptTick,
    marginTicks: Math.max(0, route.impactTick - assignment.interceptTick),
    samIndex: assignment.samIndex,
  };
}

function runLegendaryGreedySchedule(context) {
  const slots = context.profiles.map((profile) => profile.availableTicks.slice());
  const fireTicks = context.profiles.map(() => 0);
  return context.routes.map((route, index) => {
    const assignment = collectLegendaryFeasibleAssignments(context, index, slots, fireTicks)[0];
    if (assignment) applyLegendarySamAssignment(slots, fireTicks, assignment);
    return legendaryScheduledMissile(route, assignment);
  });
}

function legendaryScheduleStateKey(routeIndex, slots, fireTicks) {
  return `${routeIndex}|${slots
    .map((profileSlots) => profileSlots.join(","))
    .join(";")}|${fireTicks.join(",")}`;
}

function searchLegendaryExactSchedule(state, routeIndex, slots, fireTicks) {
  state.nodes++;
  if (state.nodes > LEGENDARY_EXACT_SCHEDULE_NODE_LIMIT) {
    state.exhausted = true;
    return null;
  }
  if (routeIndex >= state.context.routes.length) return state.chosen.slice();
  const key = legendaryScheduleStateKey(routeIndex, slots, fireTicks);
  if (state.memo.has(key)) return null;
  const feasible = collectLegendaryFeasibleAssignments(state.context, routeIndex, slots, fireTicks);
  for (const candidate of feasible) {
    const nextSlots = slots.map((profileSlots) => profileSlots.slice());
    const nextFireTicks = fireTicks.slice();
    applyLegendarySamAssignment(nextSlots, nextFireTicks, candidate);
    state.chosen[routeIndex] = candidate;
    const result = searchLegendaryExactSchedule(state, routeIndex + 1, nextSlots, nextFireTicks);
    if (result) return result;
  }
  state.memo.add(key);
  return null;
}

function runLegendaryExactSchedule(context) {
  const state = {
    context,
    nodes: 0,
    exhausted: false,
    memo: new Set(),
    chosen: new Array(context.routes.length),
  };
  const assignments = searchLegendaryExactSchedule(
    state,
    0,
    context.profiles.map((profile) => profile.availableTicks.slice()),
    context.profiles.map(() => 0),
  );
  return { assignments, nodes: state.nodes, exhausted: state.exhausted };
}

function resolveLegendaryMissileSchedule(context, greedyMissiles) {
  const fullyDefended = greedyMissiles.every((missile) => missile.intercepted);
  if (fullyDefended) {
    return { missiles: greedyMissiles, fullyDefended: true, method: "greedy", nodes: 0 };
  }
  if (context.routes.length === 0 || context.routes.length > LEGENDARY_EXACT_SCHEDULE_ROUTE_LIMIT) {
    return { missiles: greedyMissiles, fullyDefended: false, method: "inconclusive", nodes: 0 };
  }
  const exact = runLegendaryExactSchedule(context);
  if (exact.assignments) {
    const missiles = context.routes.map((route, index) =>
      legendaryScheduledMissile(route, exact.assignments[index]),
    );
    return { missiles, fullyDefended: true, method: "backtracking", nodes: exact.nodes };
  }
  const method = exact.exhausted ? "inconclusive" : "exact-impossible";
  return { missiles: greedyMissiles, fullyDefended: false, method, nodes: exact.nodes };
}

function legendaryMissileDefenseSchedule({
  routes = [],
  samProfiles = [],
  samCooldownTicks = 90,
  marginTicks = 5,
  completionTick = 0,
} = {}) {
  const cooldown = Math.max(1, legendaryScoreValue(samCooldownTicks));
  const margin = Math.max(0, legendaryScoreValue(marginTicks));
  const rawCompletion = Number(completionTick);
  const completion = Number.isFinite(rawCompletion) ? Math.max(0, rawCompletion) : Infinity;
  const profiles = normalizeLegendarySamProfiles(samProfiles, cooldown);
  const normalizedRoutes = normalizeLegendaryMissileRoutes(routes, profiles.length);
  const context = {
    profiles,
    routes: normalizedRoutes,
    futureUse: buildLegendaryFutureSamUse(normalizedRoutes, profiles.length),
  };
  const resolved = resolveLegendaryMissileSchedule(context, runLegendaryGreedySchedule(context));
  const firstImpactTick = normalizedRoutes[0]?.impactTick ?? Infinity;
  const completionMarginTicks = Number.isFinite(firstImpactTick)
    ? Math.max(0, firstImpactTick - completion)
    : Infinity;
  const margins = resolved.missiles.map((missile) => missile.marginTicks);
  return {
    fullyDefended: resolved.fullyDefended,
    completionMarginSatisfied: Number.isFinite(firstImpactTick) && completionMarginTicks >= margin,
    firstImpactTick,
    completionTick: completion,
    completionMarginTicks,
    minimumInterceptMarginTicks: margins.length ? Math.min(...margins) : Infinity,
    interceptedCount: resolved.missiles.filter((missile) => missile.intercepted).length,
    uninterceptedCount: resolved.missiles.filter((missile) => !missile.intercepted).length,
    missiles: resolved.missiles,
    samProfiles: profiles,
    scheduleMethod: resolved.method,
    exactSearchNodes: resolved.nodes,
  };
}

// An emergency defense action is useful before it solves the whole salvo. A
// large enemy silo stockpile can require several SAM upgrades in sequence, so
// rejecting every intermediate improvement would deadlock the upgrade loop.
function legendaryFiniteValueImproves(currentValue, nextValue) {
  const current = Number(currentValue);
  const next = Number(nextValue);
  return Number.isFinite(next) && (!Number.isFinite(current) || next > current);
}

function legendaryFiniteValueDecreases(currentValue, nextValue) {
  const current = Number(currentValue);
  const next = Number(nextValue);
  return Number.isFinite(current) && Number.isFinite(next) && next < current;
}

function legendaryDefenseActionImproves(
  currentEvaluation = {},
  nextEvaluation = {},
  currentCapacity = 0,
  nextCapacity = 0,
) {
  if (!currentEvaluation || !nextEvaluation) return false;
  if (nextEvaluation.hasThreats === false) return false;
  if (nextEvaluation.fullyDefended && !currentEvaluation.fullyDefended) {
    return true;
  }

  if (legendaryFiniteValueDecreases(
    currentEvaluation.uninterceptedCount,
    nextEvaluation.uninterceptedCount,
  )) {
    return true;
  }

  if (Number(nextCapacity) > Number(currentCapacity)) {
    return true;
  }

  return legendaryFiniteValueImproves(
    currentEvaluation.minimumInterceptMarginTicks,
    nextEvaluation.minimumInterceptMarginTicks,
  );
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

function rankLegendaryConstructionActions(candidates, options = {}) {
  const gold = legendaryBigInt(options.gold ?? 0n);
  const reserve = legendaryBigInt(options.reserve ?? 0n);
  const available = gold > reserve ? gold - reserve : 0n;
  const eligible = candidates
    .filter((candidate) => candidate && candidate.legal !== false)
    .slice()
    .sort(compareLegendaryCandidates);
  const affordable = eligible.filter(
    (candidate) =>
      candidate.affordable !== false && legendaryBigInt(candidate.cost) <= available,
  );
  const bestFuture = eligible.find(
    (candidate) => legendaryBigInt(candidate.cost) > available,
  );

  if (!bestFuture) return affordable;
  const shortfall = legendaryBigInt(bestFuture.cost) - available;
  const bestNow = affordable[0] ?? null;
  // Waiting is an actual portfolio action.  It wins only when the preferred
  // future asset dominates every affordable one and buying the best immediate
  // alternative would consume at least the entire funding gap.  In that case
  // spending now necessarily delays the dominating action by more gold than is
  // currently missing; no income-rate guess or arbitrary ratio is required.
  if (
    bestNow === null ||
    (compareLegendaryCandidates(bestFuture, bestNow) < 0 &&
      shortfall <= legendaryBigInt(bestNow.cost))
  ) {
    return [
      {
        action: "wait",
        type: "Wait",
        targetType: bestFuture.type,
        shortfall,
        cost: 0n,
      },
      ...affordable,
    ];
  }
  return affordable;
}

function chooseLegendaryConstructionCandidate(candidates, options = {}) {
  return rankLegendaryConstructionCandidates(candidates, options)[0] ?? null;
}
