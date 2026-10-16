// Production-shape value retarget: the UI's Legendary tier normalizes to the
// Impossible raw value, so the higher-value retry must run through the policy
// tier bridge — and compare candidate sets by their ranked blast score.
{
  const previousDifficulty = testDifficulty;
  const previousUnion = sandbox.isLegendaryDifficulty;
  sandbox.isLegendaryDifficulty = (difficulty) =>
    difficulty === "Legendary" || difficulty === "Impossible";
  testDifficulty = sandbox.Difficulty.Impossible;
  const ladderTarget = { smallID: () => 43 };
  const richerTarget = { smallID: () => 44 };
  // Raw-value comparison would keep the 400-value ladder shot; the ranked
  // blast score (value + coverage) favors the richer rival's 380-value tile.
  const ladderCandidates = [{ tile: 10, value: 400, score: 12_900 }];
  const richerCandidates = [{ tile: 30, value: 380, score: 45_380 }];
  const retryBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  retryBehavior.samDemandStrikeTarget = () => null;
  retryBehavior.collectNukeCandidates = async (candidateTarget) =>
    candidateTarget === richerTarget ? richerCandidates : ladderCandidates;
  retryBehavior.findHighestValueNukeTarget = () => richerTarget;
  retryBehavior.findValueRankedNukeTargets = () => [{ target: richerTarget, value: 3_000_000 }];
  retryBehavior.isEligibleNukeTarget = () => true;
  retryBehavior.shouldDeferNukeForEconomy = async () => false;
  retryBehavior.playerStructureValue = (candidateTarget) =>
    candidateTarget === richerTarget ? 3_000_000 : 100_000;
  const normalUiRetry = await retryBehavior.collectCandidatesWithRetry(
    ladderTarget,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    sandbox.currentDifficulty(),
  );
  assert.equal(
    normalUiRetry.retargeted,
    richerTarget,
    "the normal Legendary UI tier retargets to the richer rival when the ladder is blocked",
  );
  assert.equal(normalUiRetry.list, richerCandidates);
  assert.equal(
    retryBehavior.bestCandidateValue([{ tile: 1, value: 10, score: 60 }]),
    60,
    "candidate comparison reads the ranked blast score, not the raw value",
  );

  const lowValueTarget = { smallID: () => 45 };
  const borderArmyTarget = { smallID: () => 46 };
  const survivalTarget = { smallID: () => 47 };
  const collectedTargets = [];
  retryBehavior.findValueRankedNukeTargets = () => [
    { target: richerTarget, value: 3_000_000 },
    { target: lowValueTarget, value: 500_000 },
    { target: borderArmyTarget, value: 100_000 },
    { target: survivalTarget, value: 50_000 },
  ];
  retryBehavior.attackBehavior = { findIncomingAttackPlayer: () => survivalTarget };
  retryBehavior.findStrategicBorderArmyTarget = () => borderArmyTarget;
  retryBehavior.isInvasionSurvivalTarget = (candidateTarget) => candidateTarget === survivalTarget;
  retryBehavior.collectNukeCandidates = async (candidateTarget) => {
    collectedTargets.push(candidateTarget);
    return candidateTarget === survivalTarget ? [{ tile: 40, value: 1, score: 1 }] : [];
  };
  const screenedRetry = await retryBehavior.retryWithHigherValueTarget(
    ladderTarget,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    sandbox.currentDifficulty(),
    { candidates: [] },
  );
  assert.equal(screenedRetry?.target, survivalTarget);
  assert.deepEqual(
    collectedTargets,
    [richerTarget, borderArmyTarget, survivalTarget],
    "zero-score retries skip targets below one bomb's value but preserve invasion and border-army exceptions",
  );

  sandbox.isLegendaryDifficulty = previousUnion;
  testDifficulty = previousDifficulty;
}

