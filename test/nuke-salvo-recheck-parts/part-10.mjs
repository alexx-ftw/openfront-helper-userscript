    sandbox.currentDifficulty = () => "Hard";
    sandbox.isAtLeastHardDifficulty = () => true;
    const targetSam = {
      id: () => 91,
      level: () => 1,
      owner: () => nukeTarget,
      tile: () => 20,
      isUnderConstruction: () => false,
    };
    nukeTarget.units = (type) => (type === UNIT.SAMLauncher ? [targetSam] : []);
    behavior.createSamOverwhelmPlan = () => ({ capacityMissing: true });
    behavior.rememberFailedSamTarget = () => ({ targetSamId: targetSam.id() });
    behavior.maybeUpgradeHelpfulSilo = async () => true;
    behavior.maybeDestroyEnemySam = maybeDestroyEnemySam;
    freezeCalls = 0;
    await behavior.maybeSendNuke();
    assert.equal(
      freezeCalls,
      0,
      "a targeted Silo upgrade prevents the freeze lane from spending its capacity",
    );

    const partialPlan = {
      targetTile: 20,
      targetSamId: targetSam.id(),
      totalBombs: 2,
      coveringSamLevels: 1,
      coveringSamIds: [],
      siloEntries: [],
      window: [],
      launchSequence: [],
    };
    behavior.createSamOverwhelmPlan = () => partialPlan;
    behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 0] });
    behavior.hasPendingNukeLaunches = () => false;
    let partialSends = 0;
    behavior.sendNuke = async () => ++partialSends === 1;
    behavior.queueDelayedNukeLaunch = () => false;
    sandbox.state.nukeWantSlots = null;
    freezeCalls = 0;
    await behavior.maybeSendNuke();
    assert.equal(partialSends, 2, "the ordinary lane attempts both bombs in the partial salvo");
    assert.equal(
      freezeCalls,
      0,
      "a partially sent SAM salvo suppresses the same-tick freeze fallback",
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    sandbox.isAtLeastHardDifficulty = previousHardGate;
    sandbox.state.nukeWantSlots = null;
  }
}

{
  const { game, nukeTarget, behavior, player } = makeSalvoWorld();
  player.units = () => [];
  const giant = {
    smallID: () => 3,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    units: () => [],
  };
  game.players = () => [nukeTarget, giant];
  behavior.freezeGiantStrikeTarget = () => giant;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  let candidateOwner = null;
  behavior.collectNukeCandidates = async (target) => {
    candidateOwner = target;
    return [{}];
  };
  behavior.collectCandidatesWithRetry = async () => {
    throw new Error("the freeze fallback must not use value-directed retargeting");
  };
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [{}] });
  behavior.selectBuildableNukeCandidate = async () => ({ tile: 30 });
  let strikeTarget = null;
  let cleanupTarget = null;
  behavior.sendNuke = async (_tile, _type, target) => {
    strikeTarget = target;
    return true;
  };
  behavior.maybeDestroyEnemySam = async (target) => {
    cleanupTarget = target;
  };
  await behavior.maybeFreezeGiantStrike([], "Legendary");
  assert.strictEqual(candidateOwner, giant, "the freeze fallback scores only the selected giant");
  assert.strictEqual(strikeTarget, giant, "the freeze fallback strikes the selected giant");
  assert.strictEqual(cleanupTarget, giant, "SAM cleanup remains aligned with the selected giant");
  sandbox.state.nukeWantSlots = null;
}

const reservation = () => ({
  need: 3,
  at: 800,
  targetTile: 20,
  unblockedSiloIds: [],
  pendingLaunches: true,
});

for (const scenario of [
  "live",
  "destroyed",
  "claimed",
  "other-target",
  "unknown-path",
  "reload",
  "outside-sam",
  "construction",
  "remote-construction",
  "route-construction",
  "insufficient",
]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  world.tick = 805;
  game.config = () => ({
    maxSamRange: () => 5,
    samRange: () => 5,
    SAMCooldown: () => (scenario === "reload" ? 5 : 300),
    defaultNukeTargetableRange: () => 150,
    defaultSamMissileSpeed: () => 2,
  });
  game.manhattanDist = (a, b) => Math.abs(a - b);
  game.euclideanDistSquared = (a, b) => (a - b) ** 2;
  const sam = world.sam("cover", scenario === "insufficient" ? 2 : 1);
  sam.isActive = () => true;
  sam.isUnderConstruction = () => scenario === "construction";
  sam.missileTimerQueue = () => [];
  world.covering = [{ unit: sam, distSquared: 0 }];
  world.targetSams = [sam];
  const missile = {
    id: () => "launched",
    type: () => UNIT.AtomBomb,
    tile: () => 12,
    targetTile: () => (scenario === "other-target" ? 30 : 20),
    isActive: () => scenario !== "destroyed",
    owner: () => player,
  };
  player.units = (type) => (type === UNIT.AtomBomb ? [missile] : []);
  const outsideSam = { ...sam, id: () => "outside", tile: () => 12 };
  const hostileSams = scenario === "outside-sam" ? [outsideSam, sam] : [sam];
  if (scenario === "remote-construction" || scenario === "route-construction") {
    hostileSams.push({
      ...sam,
      id: () => "unfinished",
      tile: () => (scenario === "remote-construction" ? 1000 : 12),
      isUnderConstruction: () => true,
    });
  }
  const interceptors =
    scenario === "claimed" ? [{ isActive: () => true, targetUnit: () => missile }] : [];
  game.units = (type) => {
    if (type === UNIT.SAMLauncher) return hostileSams;
    if (type === UNIT.SAMMissile) return interceptors;
    return [];
  };
  game.motionPlans = () =>
    new Map(
      scenario === "unknown-path"
        ? []
        : [
            [
              "launched",
              {
                startTick: 805,
                ticksPerStep: 1,
                path: new Uint32Array([12, 13, 14, 15, 16, 17, 18, 19]),
              },
            ],
          ],
    );
  behavior.structureBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  behavior.structureBehavior.game = game;
  behavior._pendingNukeLaunches = [
    {
      dueTick: 805,
      tile: 20,
      nukeType: UNIT.AtomBomb,
      targetPlayer: nukeTarget,
      salvo: { salvoId: 42, targetTile: 20, targetSamId: "cover", flightTicks: 10 },
    },
  ];
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    scenario === "live" || scenario === "remote-construction",
    `${scenario}: only an unclaimed live missile that consumes covering capacity supports the finisher`,
  );
}

