// ── Freeze-giant strike gates (FFA endgame survival lane) ──────────────────
{
  const giant = {
    isPlayer: () => true,
    isAlive: () => true,
    troops: () => 6_000_000,
  };
  const mk = ({
    mode = "FFA",
    tiles = 120_000,
    troops = 3_000_000,
    max = 3_200_000,
    winFixes = true,
    difficulty = "Legendary",
  }) => {
    const behavior = Object.create(sandbox.__NukeBehavior.prototype);
    behavior.game = {
      config: () => ({ gameConfig: () => ({ gameMode: mode }) }),
      players: () => [giant],
    };
    behavior.player = {
      numTilesOwned: () => tiles,
      troops: () => troops,
      maxTroops: () => max,
      isFriendly: (o) => o === behavior.player,
    };
    sandbox.state.settings.winFixes = winFixes;
    testDifficulty = difficulty;
    return behavior;
  };
  const fullSignature = mk({});
  assert.equal(
    fullSignature.freezeGiantStrikeTarget(),
    giant,
    "the full freeze signature nominates the strongest enemy",
  );
  assert.equal(
    mk({ tiles: 49_000 }).freezeGiantStrikeTarget(),
    null,
    "below endgame scale the lane stays dormant",
  );
  assert.equal(
    mk({ troops: 2_000_000, max: 3_200_000 }).freezeGiantStrikeTarget(),
    null,
    "an army with growth room keeps its options",
  );
  assert.equal(
    mk({ troops: 4_500_000 }).freezeGiantStrikeTarget(),
    null,
    "a non-outmuscling board never strikes first",
  );
  assert.equal(
    mk({ mode: "Team" }).freezeGiantStrikeTarget(),
    null,
    "team games keep their coordinated win clock",
  );
  assert.equal(
    mk({ winFixes: false }).freezeGiantStrikeTarget(),
    null,
    "the lane is win-fixes gated",
  );
