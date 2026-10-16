  // The same strict-edge rule prices friendly losses and the hydrogen
  // finisher; the engine deletes only strictly interior tiles for all three
  // scorers.
  const edgePenaltyBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  edgePenaltyBehavior.game = {
    euclideanDistSquared: (a, b) => (a - b) ** 2,
  };
  edgePenaltyBehavior.friendlyNukeStructures = () => [
    { tile: 103, value: 500, replacementValue: 500 },
  ];
  assert.equal(
    edgePenaltyBehavior.friendlyFirePenalty(100, { inner: 2, outer: 3 }),
    0,
    "a friendly structure exactly on the blast edge survives uncharged",
  );
  edgePenaltyBehavior.friendlyNukeStructures = () => [
    { tile: 102, value: 500, replacementValue: 500 },
  ];
  assert.ok(
    edgePenaltyBehavior.friendlyFirePenalty(100, { inner: 2, outer: 3 }) > 0,
    "a friendly structure strictly inside the blast is charged as destroyed",
  );
  const edgeFinisher = Object.create(sandbox.__NukeBehavior.prototype);
  edgeFinisher.game = {
    euclideanDistSquared: (a, b) => (a - b) ** 2,
  };
  edgeFinisher.friendlyFirePenalty = () => 0;
  const edgeFinisherTarget = {
    units: (type) => (type === UNIT.City ? [cityAt(103)] : []),
  };
  assert.equal(
    edgeFinisher.postSalvoHydrogenHasValue(
      { nukeMagnitudes: () => ({ inner: 2, outer: 3 }) },
      edgeFinisherTarget,
      { targetTile: 100 },
    ),
    false,
    "the hydrogen finisher ignores an enemy structure exactly on the blast edge",
  );
  const insideFinisherTarget = {
    units: (type) => (type === UNIT.City ? [cityAt(102)] : []),
  };
  assert.equal(
    edgeFinisher.postSalvoHydrogenHasValue(
      { nukeMagnitudes: () => ({ inner: 2, outer: 3 }) },
      insideFinisherTarget,
      { targetTile: 100 },
    ),
    true,
    "the hydrogen finisher counts an enemy structure strictly inside the blast",
  );

