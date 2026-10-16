// Team-support rescue lane: a permanent teammate under invasion outranks the
// crown/density lanes; teammate attackers, null attackers and non-positive
// pressures are ignored, and the largest aggregate invader wins.
{
  const previousDifficulty = testDifficulty;
  const previousTeammates = sandbox.playersArePermanentTeammates;
  testDifficulty = sandbox.Difficulty.Legendary;
  const rescueBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  rescueBehavior.random = { chance: () => false };
  rescueBehavior.attackBehavior = {
    findIncomingAttackPlayer: () => null,
    shouldAttack: () => true,
  };
  rescueBehavior.findTwoPlayerNukeTarget = () => null;
  rescueBehavior.findStrategicBorderArmyTarget = () => null;
  rescueBehavior.findDominantCrownNukeTarget = () => null;
  rescueBehavior.findAllyNukeTarget = () => null;
  rescueBehavior.findHostileNukeTarget = () => null;
  rescueBehavior.findFFACrownTarget = () => null;
  rescueBehavior.findStrongestTeamTarget = () => null;
  rescueBehavior.findLegendaryStructureTarget = () => null;
  rescueBehavior.player = { smallID: () => 1 };
  const aggressor = { smallID: () => 7, isAlive: () => true };
  const teammateAttacker = { smallID: () => 8, isAlive: () => true };
  const underSiegeAlly = {
    smallID: () => 9,
    isAlive: () => true,
    incomingAttacks: () => [
      { attacker: () => aggressor, troops: () => 12_000 },
      { attacker: () => teammateAttacker, troops: () => 99_999 },
      { attacker: () => null, troops: () => 50_000 },
      { attacker: () => aggressor, troops: () => -5 },
    ],
  };
  const quietPlayer = { smallID: () => 10, isAlive: () => true };
  rescueBehavior.game = { players: () => [underSiegeAlly, quietPlayer] };
  sandbox.playersArePermanentTeammates = (a, b) => {
    const ids = [a.smallID(), b.smallID()];
    return ids.includes(1) && (ids.includes(8) || ids.includes(9));
  };
  assert.equal(
    rescueBehavior.findBestNukeTarget(),
    aggressor,
    "the largest teammate invader outranks the crown/density lanes",
  );
  underSiegeAlly.incomingAttacks = () => [];
  assert.equal(
    rescueBehavior.findAllyRescueNukeTarget(),
    null,
    "an uninvaded team keeps the ordinary ladder",
  );
  sandbox.playersArePermanentTeammates = previousTeammates;
  testDifficulty = previousDifficulty;
}

const policyCalls = [];
behavior.structureBehavior = {
  shouldDeferOffensiveNuke: (cost) => {
    policyCalls.push(cost);
    return true;
  },
};
behavior.attackBehavior = { findIncomingAttackPlayer: () => null };
behavior.isUnderHeavyAttack = () => false;

const legendaryHydroSpecialist = Object.create(sandbox.__NukeBehavior.prototype);
legendaryHydroSpecialist.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
legendaryHydroSpecialist.player = { gold: () => 1_000_000n };
legendaryHydroSpecialist.isHydroNation = true;
legendaryHydroSpecialist.isUnderHeavyAttack = () => false;
legendaryHydroSpecialist.getPerceivedNukeCost = async (type) =>
  type === UNIT.HydrogenBomb ? 5_000_000n : 750_000n;
testDifficulty = sandbox.Difficulty.Legendary;
const legendaryFallbackNuke = await legendaryHydroSpecialist.selectAffordableNuke();
assert.equal(legendaryFallbackNuke?.type, UNIT.AtomBomb);
assert.equal(
  legendaryFallbackNuke?.cost,
  750_000n,
  "Legendary uses an affordable Atom instead of leaving a ready Silo idle while saving for Hydrogen",
);
testDifficulty = sandbox.Difficulty.Impossible;
