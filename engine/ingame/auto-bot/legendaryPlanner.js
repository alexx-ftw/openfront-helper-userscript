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
      try {
        if (typeof raw === "function") raw = raw();
        const number = Number(raw);
        return total +
          (Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0);
      } catch (_error) {
        return total;
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
  routes = null,
  samProfiles = [],
  completionTick = 0,
  scheduleOverride = null,
} = {}) {
  // When geometry and individual SAM availability are available, use the
  // per-missile schedule below. The legacy aggregate branch remains for old
  // callers/tests that only provide arrival ticks and a total capacity.
  if (Array.isArray(routes)) {
    const schedule =
      scheduleOverride ||
      legendaryMissileDefenseSchedule({
        routes,
        samProfiles,
        samCooldownTicks,
        marginTicks,
        completionTick,
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
    const marginSatisfied = schedule.completionMarginTicks >= marginTicks;
    return {
      ...schedule,
      risk: !schedule.fullyDefended
        ? 1
        : !marginSatisfied
          ? 0.75
          : schedule.minimumInterceptMarginTicks < 1
            ? 0.5
            : 0,
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
        hydrogenArrivalTick === null || hydrogenArrivalTick === undefined
          ? Infinity
          : hydrogenArrivalTick -
            (atomArrivalTicks.length > 0
              ? atomArrivalTicks[atomArrivalTicks.length - 1]
              : 0),
      marginSatisfied,
      timeToImpactTicks: schedule.firstImpactTick,
    };
  }

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
  const completion = Number.isFinite(rawCompletion)
    ? Math.max(0, rawCompletion)
    : Infinity;
  const profiles = (Array.isArray(samProfiles) ? samProfiles : []).map(
    (profile, index) => {
      const rawAvailability = Array.isArray(profile?.availableTicks)
        ? profile.availableTicks
        : Array(
            Math.max(0, Math.floor(legendaryScoreValue(profile?.readyShots))),
          ).fill(0);
      const availableTicks = rawAvailability
        .map((tick) => Number(tick))
        .filter((tick) => Number.isFinite(tick) && tick >= 0)
        .sort((a, b) => a - b);
      return {
        id: profile?.id ?? index,
        availableTicks,
        cooldownTicks: Math.max(
          1,
          legendaryScoreValue(profile?.cooldownTicks ?? cooldown),
        ),
        // SAMLauncherExecution emits at most one interceptor per game tick,
        // even when a level-2+ launcher has multiple ready queue slots.
        fireIntervalTicks: Math.max(
          1,
          legendaryScoreValue(profile?.fireIntervalTicks ?? 1),
        ),
      };
    },
  );
  const slots = profiles.map((profile) => profile.availableTicks.slice());
  const nextFireTicks = profiles.map(() => 0);

  const normalizedRoutes = (Array.isArray(routes) ? routes : [])
    .map((route, routeIndex) => {
      const impactTick = Number(route?.impactTick);
      if (!Number.isFinite(impactTick) || impactTick < 0) return null;
      const rawOptions = Array.isArray(route?.samOptions)
        ? route.samOptions
        : (Array.isArray(route?.samCandidates) ? route.samCandidates : []).map(
            (samIndex) => ({
              samIndex,
              interceptTicks:
                Number.isFinite(Number(route?.interceptTick))
                  ? [Number(route.interceptTick)]
                  : [Math.max(0, impactTick)],
            }),
          );
      const samOptions = rawOptions
        .map((option) => {
          const samIndex = Math.floor(Number(option?.samIndex));
          if (
            !Number.isFinite(samIndex) ||
            samIndex < 0 ||
            samIndex >= profiles.length
          ) {
            return null;
          }
          const interceptTicks = (Array.isArray(option?.interceptTicks)
            ? option.interceptTicks
            : [option?.interceptTick]
          )
            .map((tick) => legendaryScoreValue(tick))
            .filter(
              (tick) =>
                Number.isFinite(tick) && tick >= 0 && tick <= impactTick,
            )
            .sort((a, b) => a - b);
          if (interceptTicks.length === 0) return null;
          return { samIndex, interceptTicks };
        })
        .filter(Boolean);
      return {
        ...route,
        id: route?.id ?? routeIndex,
        impactTick,
        samOptions,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.impactTick - right.impactTick ||
        left.samOptions.length - right.samOptions.length ||
        String(left.id).localeCompare(String(right.id)),
    );

  const firstImpactTick = normalizedRoutes.length
    ? normalizedRoutes[0].impactTick
    : Infinity;
  const missiles = [];

  // Precompute how many later routes can use each SAM. The old implementation
  // scanned every later route while evaluating every current option, turning a
  // large salvo into an avoidable O(routes²) pass before the actual scheduling
  // decision even started.
  const futureUseByRoute = normalizedRoutes.map(() =>
    Array(profiles.length).fill(0),
  );
  const futureUseCounts = Array(profiles.length).fill(0);
  for (let routeIndex = normalizedRoutes.length - 1; routeIndex >= 0; routeIndex--) {
    futureUseByRoute[routeIndex] = futureUseCounts.slice();
    const usedSamIndexes = new Set(
      normalizedRoutes[routeIndex].samOptions.map((option) => option.samIndex),
    );
    for (const samIndex of usedSamIndexes) {
      futureUseCounts[samIndex]++;
    }
  }

  const collectFeasible = (routeIndex, slotState, fireState) => {
    const route = normalizedRoutes[routeIndex];
    const feasible = [];
    for (const option of route.samOptions) {
      const profile = profiles[option.samIndex];
      const profileSlots = slotState[option.samIndex];
      for (let slotIndex = 0; slotIndex < profileSlots.length; slotIndex++) {
        const availableAt = profileSlots[slotIndex];
        const launcherAvailableAt = Math.max(
          availableAt,
          fireState[option.samIndex] ?? 0,
        );
        const interceptTick = option.interceptTicks.find(
          (tick) => tick >= launcherAvailableAt && tick <= route.impactTick,
        );
        if (interceptTick === undefined) continue;
        feasible.push({
          samIndex: option.samIndex,
          slotIndex,
          availableAt,
          launcherAvailableAt,
          interceptTick,
          futureUse: futureUseByRoute[routeIndex][option.samIndex] ?? 0,
          cooldownTicks: profile.cooldownTicks,
          fireIntervalTicks: profile.fireIntervalTicks,
        });
      }
    }
    feasible.sort(
      (left, right) =>
        left.futureUse - right.futureUse ||
        left.interceptTick - right.interceptTick ||
        left.availableAt - right.availableAt ||
        left.samIndex - right.samIndex ||
        left.slotIndex - right.slotIndex,
    );
    return feasible;
  };

  for (let routeIndex = 0; routeIndex < normalizedRoutes.length; routeIndex++) {
    const route = normalizedRoutes[routeIndex];
    // Use the least reusable SAM first, then fire as early as possible. This
    // preserves a SAM that is the only option for a later route and makes the
    // reload schedule deterministic. A missed route is never silently counted
    // as defended.
    const feasible = collectFeasible(routeIndex, slots, nextFireTicks);
    const selected = feasible[0] ?? null;
    if (selected === null) {
      missiles.push({
        ...route,
        intercepted: false,
        interceptTick: null,
        marginTicks: 0,
        samIndex: null,
      });
      continue;
    }
    slots[selected.samIndex][selected.slotIndex] =
      selected.interceptTick + selected.cooldownTicks;
    slots[selected.samIndex].sort((left, right) => left - right);
    nextFireTicks[selected.samIndex] =
      selected.interceptTick + selected.fireIntervalTicks;
    missiles.push({
      ...route,
      intercepted: true,
      interceptTick: selected.interceptTick,
      marginTicks: Math.max(0, route.impactTick - selected.interceptTick),
      samIndex: selected.samIndex,
    });
  }

  let scheduleMethod = "greedy";
  let fullyDefended = missiles.every((missile) => missile.intercepted);
  let exactSearchNodes = 0;
  let exactSearchExhausted = false;
  if (
    !fullyDefended &&
    normalizedRoutes.length > 0 &&
    normalizedRoutes.length <= LEGENDARY_EXACT_SCHEDULE_ROUTE_LIMIT
  ) {
    // The greedy pass is fast and normally sufficient. If it misses a route,
    // search the finite SAM-slot state space before declaring the salvo
    // impossible. This removes false negatives from an unfortunate early
    // assignment while retaining a bounded amount of work in the common path:
    // each state is memoized by route index plus every slot's next-ready tick.
    const memo = new Set();
    const chosen = new Array(normalizedRoutes.length);

    const search = (routeIndex, slotState, fireState) => {
      exactSearchNodes++;
      if (exactSearchNodes > LEGENDARY_EXACT_SCHEDULE_NODE_LIMIT) {
        exactSearchExhausted = true;
        return null;
      }
      if (routeIndex >= normalizedRoutes.length) {
        return { assignments: chosen.slice() };
      }
      const key = `${routeIndex}|${slotState
        .map((profileSlots) => profileSlots.map((tick) => String(tick)).join(","))
        .join(";")}|${fireState.join(",")}`;
      if (memo.has(key)) return null;
      const feasible = collectFeasible(routeIndex, slotState, fireState);
      if (feasible.length === 0) {
        memo.add(key);
        return null;
      }
      for (const candidate of feasible) {
        const nextSlots = slotState.map((profileSlots) => profileSlots.slice());
        const nextFireState = fireState.slice();
        nextSlots[candidate.samIndex][candidate.slotIndex] =
          candidate.interceptTick + candidate.cooldownTicks;
        nextSlots[candidate.samIndex].sort((left, right) => left - right);
        nextFireState[candidate.samIndex] =
          candidate.interceptTick + candidate.fireIntervalTicks;
        chosen[routeIndex] = candidate;
        const result = search(routeIndex + 1, nextSlots, nextFireState);
        if (result !== null) return result;
      }
      memo.add(key);
      return null;
    };

    const exact = search(
      0,
      profiles.map((profile) => profile.availableTicks.slice()),
      profiles.map(() => 0),
    );
    if (exact !== null) {
      missiles.length = 0;
      for (let index = 0; index < normalizedRoutes.length; index++) {
        const route = normalizedRoutes[index];
        const assignment = exact.assignments[index];
        missiles.push({
          ...route,
          intercepted: true,
          interceptTick: assignment.interceptTick,
          marginTicks: Math.max(
            0,
            route.impactTick - assignment.interceptTick,
          ),
          samIndex: assignment.samIndex,
        });
      }
      fullyDefended = true;
      scheduleMethod = "backtracking";
    } else if (exactSearchExhausted) {
      scheduleMethod = "inconclusive";
    } else {
      scheduleMethod = "exact-impossible";
    }
  } else if (!fullyDefended && normalizedRoutes.length > 0) {
    scheduleMethod = "inconclusive";
  }

  const minimumInterceptMarginTicks = missiles.length
    ? Math.min(...missiles.map((missile) => missile.marginTicks))
    : Infinity;
  const completionMarginTicks = Number.isFinite(firstImpactTick)
    ? Math.max(0, firstImpactTick - completion)
    : Infinity;
  const completionMarginSatisfied =
    Number.isFinite(firstImpactTick) && completionMarginTicks >= margin;

  return {
    fullyDefended,
    completionMarginSatisfied,
    firstImpactTick,
    completionTick: completion,
    completionMarginTicks,
    minimumInterceptMarginTicks,
    interceptedCount: missiles.filter((missile) => missile.intercepted).length,
    uninterceptedCount: missiles.filter((missile) => !missile.intercepted).length,
    missiles,
    samProfiles: profiles,
    scheduleMethod,
    exactSearchNodes,
  };
}

// An emergency defense action is useful before it solves the whole salvo. A
// large enemy silo stockpile can require several SAM upgrades in sequence, so
// rejecting every intermediate improvement would deadlock the upgrade loop.
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

  const currentUnintercepted = Number(currentEvaluation.uninterceptedCount);
  const nextUnintercepted = Number(nextEvaluation.uninterceptedCount);
  if (
    Number.isFinite(currentUnintercepted) &&
    Number.isFinite(nextUnintercepted) &&
    nextUnintercepted < currentUnintercepted
  ) {
    return true;
  }

  if (Number(nextCapacity) > Number(currentCapacity)) {
    return true;
  }

  const currentMargin = Number(currentEvaluation.minimumInterceptMarginTicks);
  const nextMargin = Number(nextEvaluation.minimumInterceptMarginTicks);
  return (
    Number.isFinite(nextMargin) &&
    (!Number.isFinite(currentMargin) || nextMargin > currentMargin)
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

function chooseLegendaryConstructionCandidate(candidates, options = {}) {
  return rankLegendaryConstructionCandidates(candidates, options)[0] ?? null;
}
