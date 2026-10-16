    unblockedSiloIds: [],
  };
  const candidates = [{ tile: 20, value: 1, score: 1 }];
  let retries = 0;
  behavior.collectNukeCandidates = async () => candidates;
  behavior.retryWithHigherValueTarget = async () => {
    retries++;
    return { target: { smallID: () => 3 }, candidates: [] };
  };
  const result = await behavior.collectCandidatesWithRetry(
    nukeTarget,
    { type: UNIT.AtomBomb, cost: 1n },
    [],
    "Legendary",
  );
  assert.equal(result.list, candidates, "the pinned target keeps its own candidate list");
  assert.equal(result.retargeted, null, "a live SAM demand is not redirected to another rival");
  assert.equal(retries, 0, "higher-value retry cannot replace the SAM demand target");
  sandbox.state.nukeWantSlots = null;
}
{
  const { world, game, player, behavior } = makeSalvoWorld();
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
  });
  game.units = () => [world.sam("demand-sam", 2)];
  const silo = {
    id: () => 1,
    level: () => 2,
    tile: () => 5,
    isUnderConstruction: () => false,
  };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.economicConstructionPressure = () => ({ cost: 0n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async () => [{ cost: 20n, canUpgrade: true }];
  structures.rankNukeDemandSiloUpgrades = () => [{ silo }];
  structures.executeStructureUpgradeCandidate = async () => true;
  sandbox.state.nukeWantSlots = {
    need: 3,
    targetSamId: "demand-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  behavior.createSamOverwhelmPlan = () => ({ capacityMissing: false });
  behavior.isTrajectoryInterceptableBySam = () => false;
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    false,
    "a closing plan releases the demand even below the static level sum",
  );
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "satisfaction follows the planner gate, not the level sum",
  );
  sandbox.state.nukeWantSlots = {
    need: 2,
    targetSamId: "demand-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  behavior.createSamOverwhelmPlan = () => ({ capacityMissing: true });
  structures.maybeSpawnStructure = async () => false;
  await structures.maybeUpgradeSiloForNukeDemand();
  assert.notEqual(
    sandbox.state.nukeWantSlots,
    null,
    "reload/window gaps keep the demand alive despite the level sum",
  );
  sandbox.state.nukeWantSlots = null;
}
{
  // Unsatisfiable-demand release: with every silo at its level cap and the
  // nation silo budget exhausted, no upgrade or spawn can close the request.
  // The demand must release instead of pinning the surplus lane and the nuke
  // lanes to this SAM owner forever.
  const { world, game, player, behavior } = makeSalvoWorld();
  game.units = () => [world.sam("demand-sam", 2)];
  const maxedSilos = [1, 2, 3].map((id) => ({
    id: () => id,
    level: () => 5,
    tile: () => 5 + id,
    isUnderConstruction: () => false,
  }));
  player.units = (type) => (type === UNIT.MissileSilo ? maxedSilos : []);
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.economicConstructionPressure = () => ({ cost: 0n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async () => [];
  structures.rankNukeDemandSiloUpgrades = () => [];
  structures.maybeSpawnStructure = async () => {
    throw new Error("spawn must not run for an unsatisfiable demand");
  };
  behavior.createSamOverwhelmPlan = () => ({ capacityMissing: true });
  behavior.isTrajectoryInterceptableBySam = () => false;
  sandbox.state.nukeWantSlots = {
    need: 12,
    targetSamId: "demand-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    false,
    "an unsatisfiable demand declines instead of spawning",
  );
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "a demand no upgrade or spawn can ever satisfy is released",
  );
}
{
  // Counterforce ordering: the anti-SAM lane must strip the umbrella that
  // actually shields target value (cost per shielded value), not merely the
  // cheapest launcher. A level-1 SAM covering nothing must not monopolize
  // atoms while a level-2 SAM over the City cluster stays unpinned.
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  const cheapSam = { id: () => "cheap", level: () => 1, owner: () => nukeTarget, tile: () => 900 };
  const umbrellaSam = { id: () => "umbrella", level: () => 2, owner: () => nukeTarget, tile: () => 20 };
  const city = { type: () => UNIT.City, level: () => 3, tile: () => 20 };
  nukeTarget.units = (type) => {
    if (type === UNIT.SAMLauncher) return [cheapSam, umbrellaSam];
    if (type === UNIT.City) return [city];
    return [];
  };
  game.euclideanDistSquared = (a, b) => (a === b ? 0 : 999_999);
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    samRange: () => 150,
    defaultNukeSpeed: () => 1,
  });
  const silo = {
    id: () => 1,
    level: () => 2,
    tile: () => 5,
    isUnderConstruction: () => false,
  };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  behavior.createSamOverwhelmPlan = (sam) => ({
    capacityMissing: true,
    targetSamId: sam.id(),
    targetTile: sam.tile(),
    coveringSamIds: new Set([sam.id()]),
    totalBombs: sam.level() + 1,
    siloEntries: [],
  });
  behavior.maybeUpgradeHelpfulSilo = async () => {};
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.equal(
    sandbox.state.nukeWantSlots?.targetSamId,
    "umbrella",
    "the salvo demand pins the SAM that shields the target's value, not the cheapest one",
  );
  sandbox.state.nukeWantSlots = null;
  behavior._samDemandRequest = null;
}
{
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  const replacement = world.sam("replacement", 3);
  world.covering.push({ unit: replacement, distSquared: 0 });
  world.targetSams.push(replacement);
  behavior.samSalvoStillViable = () => false;
  player.units = (type) =>
    type === UNIT.MissileSilo
      ? [{ id: () => 1, level: () => 1, tile: () => 5, isUnderConstruction: () => false }]
      : [];
  behavior.createSamOverwhelmPlan = (sam) => ({
    targetTile: 20,
    targetSamId: sam.id(),
    coveringSamIds: new Set([sam.id()]),
    totalBombs: 5,
    siloEntries: [],
