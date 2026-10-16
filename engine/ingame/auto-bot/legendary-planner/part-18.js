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
