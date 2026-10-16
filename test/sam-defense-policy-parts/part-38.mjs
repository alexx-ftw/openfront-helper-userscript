    "The construction dump stays fully inert when the harness never creates it",
  );
  assert.equal(
    state.stats.constructionDump,
    undefined,
    "No construction dump array appears when the feature is disabled",
  );

  state.stats.constructionDump = [];
  assert.equal(
    await dumpBehavior.doHandleLegendaryStructures(dumpContext),
    true,
    "The construction dump does not change the planner decision",
  );
  const constructionRecords = state.stats.constructionDump;
  assert.equal(constructionRecords.length, 1, "One record per planner decision");
  // Field-by-field: the record is created inside the classic-script realm,
  // so cross-realm deepStrictEqual would flag its prototype, not its data.
  const constructionRecord = constructionRecords[0];
  assert.equal(constructionRecord.tick, 1234, "record tick");
  assert.equal(constructionRecord.gold, "249363", "record gold");
  assert.equal(constructionRecord.cityCount, 2, "record cityCount");
  assert.equal(constructionRecord.ownedPorts, 1, "record ownedPorts");
  assert.equal(constructionRecord.outcome, "built", "record outcome");
  assert.equal(constructionRecord.groups.length, 1, "record group count");
  const [dumpPort, dumpCity] = constructionRecord.groups[0];
  assert.equal(dumpPort.type, "Port", "port candidate type");
  assert.equal(dumpPort.cost, "250000", "port candidate cost");
  assert.equal(dumpPort.affordable, true, "port candidate affordability");
  assert.equal(dumpCity.type, "City", "city candidate type");
  assert.equal(dumpCity.cost, "119700", "city candidate cost");
  assert.equal(dumpCity.affordable, true, "city candidate affordability");

  for (let overflowTick = 2000; overflowTick < 2805; overflowTick++) {
    dumpBehavior.game = {
      ticks: () => overflowTick,
      config: () => ({ isUnitDisabled: () => false }),
    };
    await dumpBehavior.doHandleLegendaryStructures(dumpContext);
  }
  assert.equal(
    state.stats.constructionDump.length,
    800,
    "The construction dump is a bounded ring buffer",
  );
  assert.equal(
    state.stats.constructionDump[0].tick,
    2005,
    "The oldest record is evicted once the ring buffer is full",
  );
  state.stats.constructionDump = savedConstructionDump;
}
