  // affordability tradeoff, so no second probe may re-order it.
  const { behavior, game, player, world } = makeSalvoWorld();
  const sam = world.sam(77, 3);
  game.units = () => [sam];
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
  const storedRequest = sandbox.state.nukeWantSlots;
  const silo = { id: () => 1, level: () => 1 };
  behavior.getRouteEligibleSilos = () => [silo];
  behavior.hasUsefulSiloUpgradeCapacity = () => true;
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  behavior.structureBehavior = structures;
  structures.nukeDemandScopedSilos = (_request, routeEligibleSilos = null) =>
    routeEligibleSilos ?? [silo];
  structures.availableGoldAfterReserve = () => 550n;
  structures.safeStructureCost = () => 150n;
  structures.economicConstructionPressure = () => ({ cost: 0n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async () => [{ cost: 150n, canUpgrade: true }];
  structures.rankNukeDemandSiloUpgrades = () => [{ silo }];
  let upgrades = 0;
  structures.executeStructureUpgradeCandidate = async () => {
    upgrades++;
    return true;
  };
  structures.legendaryMissileDefenseUrgent = () => true;
  assert.equal(
    await behavior.maybeUpgradeHelpfulSilo(failedTarget),
    false,
    "an affordable timely SAM defers the silo capacity upgrade",
  );
  assert.equal(upgrades, 0, "the urgent-defense guard emits no silo upgrade");
  assert.equal(
    sandbox.state.nukeWantSlots,
    storedRequest,
    "the guard defers without consuming the capacity demand",
  );
  sandbox.state.nukeWantSlots = storedRequest;
  structures.legendaryMissileDefenseUrgent = () => false;
  assert.equal(
    await behavior.maybeUpgradeHelpfulSilo(failedTarget),
    true,
    "with no missile emergency the demand lane may upgrade",
  );
  assert.equal(upgrades, 1, "the deferred upgrade executes once the emergency clears");
  sandbox.state.nukeWantSlots = null;
}

for (const preferredIds of [[], [99], [2]]) {
  const { behavior, game, player, world } = makeSalvoWorld();
  game.units = () => [world.sam(77, 3)];
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
  });
  const good = { id: () => 1, level: () => 1, isUnderConstruction: () => false };
  const blocked = { id: () => 2, level: () => 1, isUnderConstruction: () => false };
  player.units = (type) => (type === UNIT.MissileSilo ? [good, blocked] : []);
  sandbox.state.nukeWantSlots = { targetSamId: 77, need: 4, unblockedSiloIds: preferredIds };
  behavior.getRouteEligibleSilos = () => [good];
  behavior.hasUsefulSiloUpgradeCapacity = () => true;
  const structures = new sandbox.__StructureBehavior({}, game, player);
  behavior.structureBehavior = structures;
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.nukeSiloUpgradeBudgetAvailable = () => true;
  structures.buildableForUnits = async (silos) =>
    silos.map(() => ({ cost: 20n, canUpgrade: true }));
  structures.siloSamProtectionScore = (silo) => (silo.id() === blocked.id() ? 100 : 0);
  const upgradedIds = [];
  structures.executeStructureUpgradeCandidate = async (candidate) => {
    if (!candidate) return false;
    upgradedIds.push(candidate.silo.id());
    return true;
  };
  assert.equal(await behavior.maybeUpgradeHelpfulSilo({}), true);
  assert.deepEqual(upgradedIds, [good.id()], "scope fallback cannot upgrade a route-blocked silo");
  sandbox.state.nukeWantSlots = null;
}

for (const route of [
  "no-route",
  "blocked-during-probe",
  "insufficient-capacity",
  "capacity-loss",
  "partly-cooling",
  "cooling",
]) {
  const { behavior, game, player, world } = makeSalvoWorld();
  const targetSam = world.sam(77, 3);
  game.units = () => [targetSam];
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
  });
  const silo = {
    id: () => 1,
    tile: () => 10,
    level: () => 1,
    isUnderConstruction: () => false,
    missileTimerQueue: () => [world.tick - 1],
  };
  const secondSilo = { ...silo, id: () => 2, tile: () => 11 };
  player.units = (type) => {
    if (type !== UNIT.MissileSilo) return [];
    if (route === "capacity-loss" || route === "partly-cooling") {
      return [silo, secondSilo];
    }
    return [silo];
  };
  let blocked = route === "no-route";
  behavior.findEnemySamsCoveringTile = () => [targetSam];
  behavior.isTrajectoryInterceptableBySam = (spawn, _target, exclusions) =>
    (blocked && (route !== "capacity-loss" || spawn === secondSilo.tile())) ||
    !exclusions?.has(targetSam.id());
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  structures.maybeSpawnStructure = async () => false;
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.economicConstructionPressure = () => ({ cost: 100n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async (silos) => {
    if (route === "blocked-during-probe" || route === "capacity-loss") blocked = true;
    return silos.map(() => ({ cost: 20n, canUpgrade: true }));
  };
  const upgraded = [];
  structures.executeStructureUpgradeCandidate = async (candidate) => {
    if (!candidate) return false;
    upgraded.push(candidate.silo.id());
    return true;
  };
  sandbox.state.nukeWantSlots = {
    targetSamId: 77,
    targetTile: 20,
    need:
      route === "insufficient-capacity" || route === "capacity-loss" || route === "partly-cooling"
        ? 6
        : 4,
    unblockedSiloIds: route === "partly-cooling" ? [secondSilo.id()] : [],
  };
  const sent = await structures.maybeUpgradeSiloForNukeDemand();
  assert.equal(
    sent,
    route !== "no-route" && route !== "blocked-during-probe",
    `${route} construction demand needs a live useful route`,
  );
  assert.deepEqual(
    upgraded,
    (() => {
      if (route === "partly-cooling") return [secondSilo.id()];
      if (route === "no-route" || route === "blocked-during-probe") return [];
      return [silo.id()];
    })(),
  );
  sandbox.state.nukeWantSlots = null;
}

for (const change of [
  "protected-target",
  "own-aim",
  "aim-during-probe",
  "target-during-probe",
  "hostile",
  "unowned",
]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  let owner = nukeTarget;
  if (change === "own-aim") owner = player;
  if (change === "unowned") owner = { isPlayer: () => false };
  let protectedTarget = change === "protected-target";
  game.owner = () => owner;
  game.units = () => [world.sam(77, 3)];
