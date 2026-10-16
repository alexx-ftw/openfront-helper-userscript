// Deliverable-capacity realism: a covered salvo is only authorized when the
// tubes can actually deliver it this window. Nominal levels parked behind
// missileTimerQueue cooldowns are not capacity (mirrors getAvailableSiloEntries).
const coolingCoveredTarget = {
  smallID: () => 9,
  team: () => null,
  isAlive: () => true,
  units: () => [{ type: () => UNIT.City, level: () => 3, tile: () => 20 }],
};
const richValue = () => 10_000_000;
const coveredSilo = (queueLength) => ({
  isUnderConstruction: () => false,
  level: () => 3,
  missileTimerQueue: () => Array.from({ length: queueLength }),
});
valueGuard.nukeStructureValue = richValue;
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 2 },
    coolingCoveredTarget,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [coveredSilo(3)],
  ),
  false,
  "a covered salvo is declined when every tube is cooling regardless of nominal levels",
);
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 2 },
    coolingCoveredTarget,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [coveredSilo(0)],
  ),
  true,
  "the same covered salvo is authorized once the tubes actually hold ready shots",
);
valueGuard.nukeStructureValue = () => 25_000;

