
// Pre-registered anti-SAM starvation release: held atoms keep the native
// guard unless the caller signals zero clear candidates this tick.
{
  const { behavior, player, game, world, nukeTarget } = makeSalvoWorld();
  const silo = {
    isActive: () => true,
    isUnderConstruction: () => false,
    level: () => 3,
    missileTimerQueue: () => [],
    tile: () => 5,
  };
  player.units = (type) => {
    if (type === UNIT.MissileSilo) return [silo];
    if (type === UNIT.AtomBomb) return [{}, {}];
    return [];
  };
  world.targetSams = [world.sam(1, 1)];
  game.config = () => ({ defaultNukeSpeed: () => 1, isUnitDisabled: () => false });
  Object.assign(game, {
    x: (tile) => tile,
    y: () => 50,
    height: () => 100,
    ref: (x) => x,
    manhattanDist: (a, b) => Math.abs(a - b),
  });
  behavior.isTrajectoryInterceptableBySam = () => true;
  behavior.cost = async () => 1n;
  behavior.createSamOverwhelmPlan = (_sam, silos) => ({
    capacityMissing: behavior.getAvailableSiloEntries(silos, 20, []).length === 0,
  });
  behavior.rememberFailedSamTarget = (plan) => plan;
  behavior.maybeUpgradeHelpfulSilo = async () => {};
  let salvos = 0;
  behavior.fireSamSalvo = async () => {
    salvos += 1;
    return true;
  };
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.equal(salvos, 0, "held atoms keep the native guard without the starvation flag");
  await behavior.maybeDestroyEnemySam(nukeTarget, true);
  assert.equal(salvos, 1, "the starvation release lets held atoms fund the salvo");
}

// Construction consumes demand before the nuclear decision chain gets to clear it.
for (const change of [
  "unchanged",
  "destroyed",
  "friendly",
  "during-probe",
  "replaced-request",
  "pending-launches",
]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  const sam = world.sam(77, 3);
  let friendly = false;
  world.covering = [sam];
  world.targetSams = [sam];
  game.config = () => ({ isUnitDisabled: () => false, maxSamRange: () => 150 });
  game.units = () => world.covering;
  player.isFriendly = () => friendly;
  player.units = (type) => (type === UNIT.AtomBomb ? [{}] : []);
  behavior.rememberFailedSamTarget({
    targetSamId: 77,
    targetTile: 20,
    totalBombs: 4,
    siloEntries: [],
    coveringSamIds: new Set([77]),
  });
  if (change === "destroyed") world.covering = world.targetSams = [];
  if (change === "friendly") friendly = true;
  await behavior.maybeDestroyEnemySam(nukeTarget);
  const structures = new sandbox.__StructureBehavior({}, game, player);
  const demandSilo = { id: () => 77, level: () => 1 };
  structures.nukeDemandScopedSilos = () => [demandSilo];
  structures.availableGoldAfterReserve = () => 100n;
  structures.safeStructureCost = () => 1n;
  structures.nukeSiloUpgradeBudgetAvailable = () => true;
  structures.buildableForUnits = async () => {
    if (change === "during-probe") world.covering = world.targetSams = [];
    if (change === "replaced-request")
      sandbox.state.nukeWantSlots = { ...sandbox.state.nukeWantSlots, targetSamId: 88 };
    if (change === "pending-launches") sandbox.state.nukeWantSlots.pendingLaunches = true;
    return [];
  };
  structures.rankNukeDemandSiloUpgrades = () => [{ silo: demandSilo }];
  let upgrades = 0;
  structures.executeStructureUpgradeCandidate = async () => {
    upgrades++;
    return true;
  };
  await structures.maybeUpgradeSiloForNukeDemand();
  assert.equal(
    upgrades,
    change === "unchanged" ? 1 : 0,
    `${change} SAM cannot retain obsolete capacity demand`,
  );
  if (change === "pending-launches")
    assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true);
  if (change === "replaced-request") assert.equal(sandbox.state.nukeWantSlots.targetSamId, 88);
  sandbox.state.nukeWantSlots = null;
}

for (const restriction of [
  "budget",
  "budget-during-probe",
  "upgrade-cost",
  "destroyed",
  "during-probe",
  "blocked-route",
  "impossible-capacity",
  "permitted",
]) {
  const { behavior, game, player, world } = makeSalvoWorld();
  const sam = world.sam(77, 3);
  let targetSams = restriction === "destroyed" ? [] : [sam];
  game.units = () => targetSams;
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
  });
  player.units = () => [];
  const failedTarget = behavior.rememberFailedSamTarget({
    targetSamId: 77,
    targetTile: 20,
    totalBombs: 4,
    siloEntries: [],
    coveringSamIds: new Set([77]),
  });
  const silo = { id: () => 1, level: () => 1 };
  behavior.getRouteEligibleSilos = () => (restriction === "blocked-route" ? [] : [silo]);
  behavior.hasUsefulSiloUpgradeCapacity = () => restriction !== "impossible-capacity";
  behavior.getPreferredHelpfulSilos = (silos) => silos;
  behavior.findBestProtectedSilo = () => silo;
  let upgrades = 0;
  behavior.actuateSiloUpgrade = async () => {
    upgrades++;
    return true;
  };
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  behavior.structureBehavior = structures;
  structures.nukeDemandScopedSilos = (_request, routeEligibleSilos = null) =>
    routeEligibleSilos ?? [silo];
  let demandSiloBuildRequested = false;
  structures.maybeSpawnStructure = async (type, options) => {
    if (restriction !== "impossible-capacity") return false;
    demandSiloBuildRequested =
      type === UNIT.MissileSilo &&
      options.forceNewStructure === true &&
      options.nukeDemandRequest === sandbox.state.nukeWantSlots;
    return demandSiloBuildRequested;
  };
  let availableGold = restriction === "budget" ? 50n : 200n;
  structures.availableGoldAfterReserve = () => availableGold;
  structures.safeStructureCost = () => 20n;
  structures.economicConstructionPressure = () => ({ cost: 100n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async () => {
    if (restriction === "during-probe") targetSams = [];
    if (restriction === "budget-during-probe") availableGold = 50n;
    return restriction === "upgrade-cost" || restriction === "permitted"
      ? [{ cost: restriction === "upgrade-cost" ? 150n : 20n, canUpgrade: true }]
      : [];
  };
  if (restriction !== "upgrade-cost" && restriction !== "permitted")
    structures.rankNukeDemandSiloUpgrades = () => [{}];
  structures.executeStructureUpgradeCandidate = async (candidate) => {
    if (!candidate) return false;
    upgrades++;
    return true;
  };
  const upgraded = await behavior.maybeUpgradeHelpfulSilo(failedTarget);
  assert.equal(
    demandSiloBuildRequested,
    restriction === "impossible-capacity",
    `${restriction} only starts a new Silo when existing upgrade capacity is exhausted`,
  );
  assert.equal(
    upgrades,
    restriction === "permitted" ? 1 : 0,
    `${restriction} immediate nuke demand respects shared construction gates`,
  );
  assert.equal(upgraded, restriction === "permitted" || restriction === "impossible-capacity");
  sandbox.state.nukeWantSlots = null;
}
{
  // Legendary missile-defense urgency defers silo capacity work while a
  // hostile missile is live; the structure lane already owns the SAM-vs-silo
