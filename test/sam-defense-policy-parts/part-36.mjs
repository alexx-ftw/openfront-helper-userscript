  denseBehavior.player = {
    numTilesOwned: () => 50_000,
    gold: () => 150_000n,
    units: () => [],
  };
  denseBehavior.ownedLevels = (type) => (type === UNIT.City ? 6 : 0);
  let denseSpawns = 0;
  denseBehavior.maybeSpawnStructure = async () => {
    denseSpawns += 1;
    return true;
  };
  await denseBehavior.maybeSpawnPlateauCity();
  assert.equal(
    denseSpawns,
    0,
    "an already-dense empire (cities >= tiles/8000) is not force-fed Cities",
  );
  sandbox.isLegendaryDifficulty = originalIsLegendary;
}

// ── Enemy-economy/silo nuclear threat forecast (economy-vs-SAM planner) ────
{
  const originalIsLegendary = sandbox.isLegendaryDifficulty;
  sandbox.isLegendaryDifficulty = () => true;
  const forecastBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  let tick = 2_000;
  let ownGold = 400_000;
  let hostileGold = 200_000;
  let hostileSilos = 0;
  const singleHostile = {
    id: 2,
    get gold() {
      return hostileGold;
    },
    get siloCount() {
      return hostileSilos;
    },
  };
  let hostilePlayers = [singleHostile];
  const hostileView = (data) => ({
    smallID: () => data.id,
    isPlayer: () => true,
    isAlive: () => data.alive !== false,
    gold: () => data.gold,
    data,
  });
  forecastBehavior.game = {
    ticks: () => tick,
    players: () => [{ smallID: () => 1 }, ...hostilePlayers.map(hostileView)],
  };
  forecastBehavior.player = {
    smallID: () => 1,
    gold: () => BigInt(ownGold),
  };
  forecastBehavior.player.isFriendly = (other) => other.data?.friendly === true;
  forecastBehavior.playerUnitCapacitySummary = (player) => ({
    count: player.data?.siloCount ?? 0,
  });
  forecastBehavior.safeConstructionCost = () => 1_500_000n;
  delete sandbox.state.hostileEconSamples;
  delete sandbox.state.ownEconSamples;

  // Two samples 100 ticks apart: hostile +100k/100t (1k/t), us +50k/100t.
  hostileGold = 200_000;
  ownGold = 400_000;
  forecastBehavior.hostileNuclearThreatSample();
  forecastBehavior.estimatedOwnGoldPerTick();
  tick += 100;
  hostileGold = 300_000;
  ownGold = 450_000;
  forecastBehavior.hostileNuclearThreatSample();
  forecastBehavior.estimatedOwnGoldPerTick();
  // Hostile needs 1.75M (silo+nuke) from 300k at 1k/t = 1450t + 300 = 1750.
  // Our SAM: (1.5M - 450k)/500t = 2100 + 300 = 2400. 2400 > 1750-600 → chest.
  assert.equal(
    forecastBehavior.nuclearThreatOutrunsOurSamReadiness(),
    true,
    "a threat that matures before our SAM readiness keeps the chest bound",
  );

  // Rich us, poor-and-slow them: we outpace comfortably → economy proceeds.
  tick += 100;
  ownGold = 1_600_000;
  hostileGold = 320_000;
  forecastBehavior.estimatedOwnGoldPerTick();
  forecastBehavior.hostileNuclearThreatSample();
  // Our ETA = 300 (affordable now); the no-Silo path is ~7,450t.
  assert.equal(
    forecastBehavior.nuclearThreatOutrunsOurSamReadiness(),
    false,
    "when our SAM readiness provably precedes the threat, the economy lane stays open",
  );

  // Live hostile silos shorten the horizon (level-weighted existing-silo path).
  hostileSilos = 2;
  tick += 100;
  hostileGold = 700_000;
  ownGold = 1_650_000;
  forecastBehavior.hostileNuclearThreatSample();
  forecastBehavior.estimatedOwnGoldPerTick();
  // Existing-silo ETA: (750k-700k)/3.8k ≈ 13.16t × level factor 2/3 ≈ 8.77t;
  // ours 300t. Pin the exact owner-matched existing-silo ETA value.
  assert.equal(
    forecastBehavior.hostileNuclearThreatEtaTicks(),
    8.771929824561402,
    "a single existing-Silo hostile keeps the exact existing-silo ETA",
  );
  assert.equal(
    forecastBehavior.nuclearThreatOutrunsOurSamReadiness(),
    true,
    "high hostile silo levels with a near-funded nuke re-bind the chest",
  );

  // A rich no-Silo player must not borrow another player's Silo or use the
  // existing-Silo price path; the earliest complete owner-matched ETA is 1,500.
  delete sandbox.state.hostileEconSamples;
  delete sandbox.state.ownEconSamples;
  tick = 3_000;
  ownGold = 1_400_000;
  // Fully player-shaped self entry: only the smallID self-check may exclude it.
  const selfShapedOwner = { id: 1, gold: 9_000_000, siloCount: 3 };
  const poorSiloOwner = { id: 2, gold: 100_000, siloCount: 1 };
  const richNoSiloOwner = { id: 3, gold: 1_100_000, siloCount: 0 };
  hostilePlayers = [selfShapedOwner, poorSiloOwner, richNoSiloOwner];
  forecastBehavior.hostileNuclearThreatSample();
  forecastBehavior.estimatedOwnGoldPerTick();
  tick += 100;
  poorSiloOwner.gold = 110_000;
  richNoSiloOwner.gold = 1_150_000;
  ownGold = 1_450_000;
  forecastBehavior.hostileNuclearThreatSample();
  forecastBehavior.estimatedOwnGoldPerTick();
  assert.equal(
    forecastBehavior.hostileNuclearThreatEtaTicks(),
    1_500,
    "the no-Silo owner's 1.5M gold follows the new-Silo path; the poor Silo owner keeps its own income",
  );
  assert.equal(
    forecastBehavior.nuclearThreatOutrunsOurSamReadiness(),
    false,
    "the unrelated Silo cannot turn a rich no-Silo player into an immediate launch threat",
  );

  // Once that rich player owns a Silo, its own matching samples make the
  // existing-Silo path urgent; high-gold friendly/dead players stay excluded.
  tick += 100;
  richNoSiloOwner.gold = 1_200_000;
  richNoSiloOwner.siloCount = 1;
  richNoSiloOwner.friendly = true;
  const deadSiloOwner = {
    id: 4,
    gold: 2_000_000,
    siloCount: 3,
    alive: false,
  };
  hostilePlayers.push(deadSiloOwner);
  forecastBehavior.hostileNuclearThreatSample();
  assert.deepEqual(
    Array.from(
      sandbox.state.hostileEconSamples[sandbox.state.hostileEconSamples.length - 1].players,
      (player) => player.id,
    ),
    [2],
    "friendly and dead players do not enter the hostile ETA sample",
  );
  richNoSiloOwner.friendly = false;
  tick += 100;
  richNoSiloOwner.gold = 1_250_000;
  forecastBehavior.hostileNuclearThreatSample();
  tick += 100;
  richNoSiloOwner.gold = 1_300_000;
  forecastBehavior.hostileNuclearThreatSample();
  assert.equal(
    forecastBehavior.hostileNuclearThreatEtaTicks(),
    0,
    "a funded Silo owner uses the existing-Silo path",
  );

  // A new match must not reuse either hostile or own gold slopes.
  tick = 50;
  hostilePlayers = [singleHostile];
  hostileGold = 200_000;
  hostileSilos = 0;
  forecastBehavior.hostileNuclearThreatSample();
  assert.equal(sandbox.state.hostileEconSamples.length, 1);
  assert.equal(sandbox.state.ownEconSamples.length, 0);
  assert.equal(
    forecastBehavior.hostileNuclearThreatEtaTicks(),
    null,
    "one sample after a tick reset is insufficient for a projected ETA",
