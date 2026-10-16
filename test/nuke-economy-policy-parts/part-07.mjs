// Production bridge semantics: currentDifficulty() maps the Legendary UI
// tier to the engine's Impossible enum, and the fallback gate is the
// isLegendaryDifficulty union — so the Impossible hydro specialist keeps
// the same affordable-Atom fallback instead of idling a ready Silo.
const impossibleFallbackNuke = await legendaryHydroSpecialist.selectAffordableNuke();
assert.equal(impossibleFallbackNuke?.type, UNIT.AtomBomb);

const nukeSelf = {
  smallID: () => 1,
  isOnSameTeam: () => false,
  isFriendly: () => false,
  allRelationsSorted: () => [],
};
const weakerHostileNation = {
  smallID: () => 2,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Bot,
};
const hostileTargetBehavior = Object.create(sandbox.__NukeBehavior.prototype);
hostileTargetBehavior.player = {
  ...nukeSelf,
  allRelationsSorted: () => [{ relation: "Hostile", player: weakerHostileNation }],
};
hostileTargetBehavior.game = {
  config: () => ({ maxTroops: (player) => (player === nukeSelf ? 200 : 50) }),
};
hostileTargetBehavior.attackBehavior = { shouldAttack: () => true };
assert.equal(
  hostileTargetBehavior.findHostileNukeTarget(),
  weakerHostileNation,
  "a weaker hostile nation remains a valid automatic nuclear target",
);
assert.equal(
  hostileTargetBehavior.isValidNukeTarget(weakerHostileNation),
  true,
  "a hostile Bot-type opponent is eligible when the normal attack policy allows it",
);

testDifficulty = sandbox.Difficulty.Legendary;
const makeArmyPlayer = (id, troops) => ({
  smallID: () => id,
  team: () => null,
  isAlive: () => true,
  troops: () => troops,
});
const makeThreatSelector = ({ threatTroops = 1_000_000, targetable = true } = {}) => {
  const self = makeArmyPlayer(1, 1_000_000);
  const relationTarget = makeArmyPlayer(2, 1_250_000);
  const borderLeader = makeArmyPlayer(3, threatTroops);
  const selector = Object.create(sandbox.__NukeBehavior.prototype);
  selector.player = self;
  selector.game = {
    ticks: () => 2083,
    players: () => [self, relationTarget, borderLeader],
  };
  selector.attackBehavior = {
    findIncomingAttackPlayer: () => null,
    shouldAttack: () => targetable,
    getPendingOutboundAttackTroops: () => 0,
  };
  selector.structureBehavior = {
    strongestQuietStrategicBorderOpponent: () => ({
      opponentSid: 3,
      troops: threatTroops,
    }),
  };
  selector.isRichestNation = () => true;
  selector.random = { chance: () => true };
  selector.findHighDensityTarget = () => relationTarget;
  selector.findDominantCrownNukeTarget = () => null;
  selector.findAllyNukeTarget = () => null;
  selector.findHostileNukeTarget = () => null;
  selector.findFFACrownTarget = () => null;
  selector.findStrongestTeamTarget = () => null;
  selector.findLegendaryStructureTarget = () => null;
  return { selector, relationTarget, borderLeader };
};
{
  const { selector, borderLeader } = makeThreatSelector();
  assert.equal(
    selector.findBestNukeTarget(),
    borderLeader,
    "Legendary prioritizes a hostile border army at parity over the generic density target",
  );
}
{
  const { selector, borderLeader } = makeThreatSelector({ threatTroops: 800_000 });
  selector.attackBehavior.getPendingOutboundAttackTroops = (forceRefresh) => {
    assert.equal(forceRefresh, true, "border priority refreshes pending debits in the same tick");
    return 250_000;
  };
  assert.equal(
    selector.findBestNukeTarget(),
    borderLeader,
    "a border army above the unreflected garrison preempts density while an attack debit is pending",
  );
}
{
  const { selector, relationTarget } = makeThreatSelector({ threatTroops: 0 });
  selector.attackBehavior.getPendingOutboundAttackTroops = () => 1_000_000;
  assert.equal(
    selector.findBestNukeTarget(),
    relationTarget,
    "an empty border army is not treated as a threat when no garrison troops remain",
  );
}
{
  const { selector, relationTarget } = makeThreatSelector();
  selector.attackBehavior.findIncomingAttackPlayer = () => relationTarget;
  assert.equal(
    selector.findBestNukeTarget(),
    relationTarget,
    "an active retaliation target remains ahead of the preemptive border-force target",
  );
  selector.attackBehavior.findIncomingAttackPlayer = () => null;
  selector.structureBehavior.strongestQuietStrategicBorderOpponent = () => ({
    opponentSid: 3,
    troops: 999_999,
  });
  assert.equal(
    selector.findBestNukeTarget(),
    relationTarget,
    "a border force below our troop count does not preempt the ordinary target ladder",
  );
  selector.structureBehavior.strongestQuietStrategicBorderOpponent = () => ({
    opponentSid: 3,
    troops: 1_000_000,
  });
  selector.attackBehavior.shouldAttack = () => false;
  assert.equal(
    selector.findBestNukeTarget(),
    relationTarget,
    "the counterforce target must still pass the normal attackability policy",
  );
}

testDifficulty = sandbox.Difficulty.Legendary;
const observedSelf = makeArmyPlayer(1, 1_000_000);
const ordinaryNukeTarget = makeArmyPlayer(2, 1_250_000);
const nuclearAttacker = makeArmyPlayer(3, 900_000);
const unrelatedMissileOwner = makeArmyPlayer(4, 800_000);
const neutralBlastAttacker = makeArmyPlayer(5, 700_000);
const friendlyAlly = makeArmyPlayer(6, 600_000);
observedSelf.team = () => "Alpha";
friendlyAlly.team = () => "Alpha";
const friendlyAllyCity = { tile: () => 46 };
friendlyAlly.units = (type) => (type === UNIT.City ? [friendlyAllyCity] : []);
let activeHostileMissiles = [];
let observedTick = 8205;
nuclearAttacker.units = () => [];
unrelatedMissileOwner.units = () => [];
neutralBlastAttacker.units = () => [];
const threatObserver = Object.create(sandbox.__NukeBehavior.prototype);
threatObserver.player = observedSelf;
threatObserver.game = {
  ticks: () => observedTick,
  players: () => [
    observedSelf,
    ordinaryNukeTarget,
    nuclearAttacker,
    unrelatedMissileOwner,
    neutralBlastAttacker,
    friendlyAlly,
  ],
  units: () => activeHostileMissiles,
  owner: (tile) => {
    if (tile === 20) return observedSelf;
    if (tile === 30) return ordinaryNukeTarget;
    return null;
  },
  config: () => ({ nukeMagnitudes: () => ({ outer: 15 }) }),
  euclideanDistSquared: (from, to) => (from - to) ** 2,
};
threatObserver.attackBehavior = {
  findIncomingAttackPlayer: () => null,
  shouldAttack: () => true,
};
threatObserver.structureBehavior = {
  strongestQuietStrategicBorderOpponent: () => null,
};
threatObserver.isRichestNation = () => false;
threatObserver.random = { chance: () => false };
threatObserver.findDominantCrownNukeTarget = () => null;
threatObserver.findAllyNukeTarget = () => null;
threatObserver.findHostileNukeTarget = () => null;
threatObserver.findFFACrownTarget = () => null;
threatObserver.findStrongestTeamTarget = () => null;
threatObserver.findLegendaryStructureTarget = () => ordinaryNukeTarget;
threatObserver._hostileNukeThreats = new Map();
activeHostileMissiles = [
  { owner: () => nuclearAttacker, targetTile: () => 20 },
  { owner: () => unrelatedMissileOwner, targetTile: () => 30 },
  { owner: () => observedSelf, targetTile: () => 20 },
  { owner: () => neutralBlastAttacker, targetTile: () => 40, type: () => UNIT.AtomBomb },
];
