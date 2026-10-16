import assert from "node:assert/strict";

export async function checkGameApiCacheViews(api) {
  const { state, playerCore, gameApiSource, wrappedApi, gameApi, playerView } = api;
  await wrappedApi.beginTick(playerCore);
  assert.deepEqual([...playerView.borderTiles()], [1]);
  const firstOceanShores = playerView.oceanShoreBorderTiles();
  const secondOceanShores = playerView.oceanShoreBorderTiles();
  assert.deepEqual(
    [...firstOceanShores],
    [1],
    "ocean shore cache must preserve the exact predicate",
  );
  assert.strictEqual(
    secondOceanShores,
    firstOceanShores,
    "repeated ocean-shore reads should reuse the current border snapshot",
  );
  assert.equal(
    state.oceanShoreCalls,
    1,
    "the exact ocean-shore predicate runs once per border snapshot",
  );
  delete gameApiSource.isOceanShore;
  state.tick += 1;
  await wrappedApi.beginTick(playerCore);
  assert.equal(
    playerView.oceanShoreBorderTiles(),
    null,
    "an unavailable exact ocean predicate is distinguishable from a coastless border",
  );
  assert.equal(playerView.sharesBorderWith(playerView), true);
  const callsAfterFirstBorderCheck = state.borderNeighborCalls;
  assert.equal(playerView.sharesBorderWith(playerView), true);
  assert.equal(
    state.borderNeighborCalls,
    callsAfterFirstBorderCheck,
    "repeated border relations should reuse the exact result within one game tick",
  );
  const firstPlayerUnits = playerView.units("Warship");
  const secondPlayerUnits = playerView.units("Warship");
  assert.strictEqual(
    secondPlayerUnits,
    firstPlayerUnits,
    "gameApi player units should reuse the same snapshot within a game tick",
  );
  assert.equal(state.playerUnitCalls, 1, "player units should be read once per family and tick");
  assert.equal(
    firstPlayerUnits[0].isFriendly(playerView),
    true,
    "wrapped units should inherit friendliness from their owner",
  );
  const visitedNeighbors = [];
  gameApi.forEachNeighbor(1, (neighbor) => visitedNeighbors.push(neighbor));
  assert.deepEqual(
    visitedNeighbors,
    [2, 3],
    "gameApi should synthesize the core forEachNeighbor contract from client neighbors",
  );
  const firstGlobalUnits = gameApi.units("Warship");
  const secondGlobalUnits = gameApi.units("Warship");
  assert.equal(
    firstGlobalUnits[0].targetUnit()?.id(),
    2,
    "UnitView targetUnitId resolves through GameView.unit for live naval reconciliation",
  );
  assert.strictEqual(
    secondGlobalUnits,
    firstGlobalUnits,
    "gameApi global units should reuse the same snapshot within a game tick",
  );
  assert.equal(state.globalUnitCalls, 1, "global units should be read once per family and tick");
  const firstPlayers = gameApi.players();
  const secondPlayers = gameApi.players();
  assert.strictEqual(
    secondPlayers,
    firstPlayers,
    "gameApi player views should reuse the same snapshot within a game tick",
  );
  assert.equal(state.playerListCalls, 1, "players should be read once per game tick");
  state.tick += 1;
  const replacementPlayerCore = {
    ...playerCore,
    troops: () => 999,
  };
  await wrappedApi.beginTick(replacementPlayerCore);
  assert.notStrictEqual(
    gameApi.myPlayer(),
    playerView,
    "a new game tick must replace stale wrapped PlayerView snapshots",
  );
  assert.equal(
    gameApi.myPlayer().troops(),
    999,
    "the refreshed player wrapper must read the current snapshot state",
  );
  const receiverSensitiveAttack = {
    _id: "receiver-sensitive-attack",
    _retreating: true,
    _troops: 17,
    id() {
      return this._id;
    },
    retreating() {
      return this._retreating;
    },
    troops() {
      return this._troops;
    },
  };
  replacementPlayerCore.outgoingAttacks = () => [receiverSensitiveAttack];
  const wrappedReceiverSensitiveAttack = gameApi.myPlayer().outgoingAttacks()[0];
  assert.equal(
    wrappedReceiverSensitiveAttack.retreating(),
    true,
    "wrapped attacks must preserve the source receiver for retreating()",
  );
  assert.equal(
    wrappedReceiverSensitiveAttack.troops(),
    17,
    "wrapped attacks must preserve the source receiver for troops()",
  );
  assert.equal(
    wrappedReceiverSensitiveAttack.id(),
    "receiver-sensitive-attack",
    "wrapped attacks must preserve the source receiver for id()",
  );
  assert.equal(playerView.sharesBorderWith(playerView), true);
  assert.ok(
    state.borderNeighborCalls > callsAfterFirstBorderCheck,
    "advancing the game tick invalidates cached border relations",
  );
  assert.notStrictEqual(
    playerView.units("Warship"),
    firstPlayerUnits,
    "a new game tick must invalidate gameApi player snapshots",
  );
  assert.notStrictEqual(
    gameApi.players(),
    firstPlayers,
    "a new game tick must refresh the player snapshot",
  );
  assert.equal(state.playerListCalls, 2, "players should refresh after the game advances");
}
