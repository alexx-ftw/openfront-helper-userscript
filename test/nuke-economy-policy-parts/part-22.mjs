  // Production bridge semantics: currentDifficulty() maps the Legendary UI
  // tier to the engine's Impossible enum, so the survival lane must arm on
  // Impossible and stay dormant below the tier.
  assert.equal(
    mk({ difficulty: "Impossible" }).freezeGiantStrikeTarget(),
    giant,
    "the production Legendary tier (Impossible enum) arms the survival lane",
  );
  assert.equal(
    mk({ difficulty: "Hard" }).freezeGiantStrikeTarget(),
    null,
    "below the Legendary tier the lane stays dormant",
  );
  sandbox.state.settings.winFixes = true;
  testDifficulty = "Impossible";
}

