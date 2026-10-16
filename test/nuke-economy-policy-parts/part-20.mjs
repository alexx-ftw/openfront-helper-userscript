// This schedule test uses the plan's flight ticks, not a second pathfinding pass.
scheduledSalvoBehavior.getAvailableSiloEntries = () => [];
scheduledSalvoBehavior.getSamSalvo = () => ({
  bombsToFire: 2,
  waits: [0, 7],
});
const scheduledPlan = {
  targetTile: 20,
  totalBombs: 2,
  coveringSamIds: new Set(["enemy-sam"]),
  siloEntries: [{ silo: { id: () => "silo-1" }, interceptable: false }],
};
sandbox.state.nukeWantSlots = null;
assert.equal(
  await scheduledSalvoBehavior.fireSamSalvo(scheduledPlan, scheduledTarget, 1n),
  true,
  "a valid staggered salvo is accepted as one pending launch plan",
);
assert.deepEqual(
  scheduledBuilds,
  [{ tick: 600, type: UNIT.AtomBomb, tile: 20 }],
  "only the zero-wait bomb launches on the planning tick",
);
assert.equal(
  sandbox.state.nukeWantSlots?.pendingLaunches,
  true,
  "the silo reservation remains active until every delayed bomb is emitted",
);
scheduledTick = 607;
assert.equal(
  await scheduledSalvoBehavior.processPendingNukeLaunches(),
  true,
  "the delayed salvo bomb launches when its exact game tick becomes due",
);
assert.deepEqual(scheduledBuilds, [
  { tick: 600, type: UNIT.AtomBomb, tile: 20 },
  { tick: 607, type: UNIT.AtomBomb, tile: 20 },
]);
assert.equal(sandbox.state.nukeWantSlots, null);

const mirvStateReserve = 987n;
const readyMirvSilo = {
  isActive: () => true,
  isUnderConstruction: () => false,
  level: () => 1,
  missileTimerQueue: () => [],
};
const exhaustedMirvSilo = {
  isActive: () => true,
  isUnderConstruction: () => false,
  level: () => 1,
  missileTimerQueue: () => [123],
};
const mirvActuationTarget = {
  id: () => "mirv-actuation-target",
  smallID: () => 9,
  isPlayer: () => true,
  type: () => "Human",
};
const mirvActuationPlayer = {
  smallID: () => 1,
  isFriendly: () => false,
  units: () => [readyMirvSilo],
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvActuationBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 700,
    units: () => [],
    config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  },
  mirvActuationPlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
mirvActuationBehavior.calculateTerritoryCenter = async () => 11;
assert.equal(
  await mirvActuationBehavior.maybeSendMIRV(mirvActuationTarget),
  true,
  "a successful MIRV build intent reports success",
);

const exhaustedMirvPlayer = {
  ...mirvActuationPlayer,
  units: () => [exhaustedMirvSilo],
};
const exhaustedMirvBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 701,
    units: () => [],
    config: () => ({
      isUnitDisabled: () => false,
      nukeMagnitudes: () => ({ inner: 10 }),
    }),
  },
  exhaustedMirvPlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await exhaustedMirvBehavior.considerMIRV(),
  false,
  "an exhausted Silo does not claim that MIRV consideration succeeded",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "an exhausted Silo preserves the MIRV reserve state",
);

exhaustedMirvBehavior.teamHasWon = () => true;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await exhaustedMirvBehavior.considerWinFixMIRV(1n),
  false,
  "a secured team victory does not need a ready MIRV slot",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  0n,
  "a secured team victory releases the MIRV reserve even while every Silo reloads",
);

const rejectedProbePlayer = {
  ...mirvActuationPlayer,
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: false }],
};
const rejectedProbeBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 702,
    units: () => [],
    config: () => ({ gameConfig: () => ({ gameMode: "FFA" }) }),
  },
  rejectedProbePlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
rejectedProbeBehavior.calculateTerritoryCenter = async () => 12;
rejectedProbeBehavior.selectWinFixMirvTarget = () => mirvActuationTarget;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await rejectedProbeBehavior.considerWinFixMIRV(1n),
  false,
  "a rejected MIRV probe does not claim that the win-fix launch succeeded",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "a rejected MIRV probe preserves the win-fix MIRV reserve state",
);

const firstEligibleRejectedBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 703,
    units: () => [],
    config: () => ({ gameConfig: () => ({ gameMode: "FFA" }) }),
  },
  rejectedProbePlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
firstEligibleRejectedBehavior.calculateTerritoryCenter = async () => 13;
firstEligibleRejectedBehavior.selectCounterMirvTarget = () => mirvActuationTarget;
firstEligibleRejectedBehavior.selectVictoryDenialTarget = () => null;
firstEligibleRejectedBehavior.selectSteamrollStopTarget = () => null;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await firstEligibleRejectedBehavior.sendFirstEligibleMIRV(),
  false,
  "the first eligible MIRV path reports false when its probe is rejected",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "a rejected first-eligible MIRV probe preserves decision state",
);

