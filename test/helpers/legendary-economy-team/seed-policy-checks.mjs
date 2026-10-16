import assert from "node:assert/strict";
import { scenario, networkOwner } from "../../legendary-economy-team-scenario-helpers.mjs";

const waterPlayer = (smallId, teamId) => networkOwner(smallId, teamId, {});

/** Retain policy arithmetic checks; these project payouts, not native execution. */
export function checkSeedProjectionAndPolicy(harness) {
  const {
    UNIT,
    liveCostOf,
    liveDurationOf,
    liveTradeShipGold,
    liveEconomyConfig,
    matchHorizonTicks,
    sandbox,
  } = harness;
  const portCost = liveCostOf(UNIT.Port);
  const portTicks = liveDurationOf(UNIT.Port);
  checkSeedOwners(sandbox);

  scenario("seed pair: projected payout waits for both Ports, then both streams contribute", () => {
    const partnerDelayTicks = portTicks * 2;
    const seedRoute = {
      weight: 1,
      distance: 0,
      teamGoldPerArrival: liveTradeShipGold(0) * 2,
    };
    const ownSource = {
      level: 1,
      portSeedStream: "own",
      routes: [seedRoute],
    };
    const partnerSource = {
      level: 1,
      portSeedStream: "partner",
      constructionDelayTicks: partnerDelayTicks,
      routes: [seedRoute],
    };
    const priceAt = (horizonTicks, sources = [ownSource, partnerSource]) =>
      sandbox.legendaryEconomyNetGold(UNIT.Port, {
        cost: portCost,
        horizonTicks,
        inputs: {
          hasCompletedTradePartner: false,
          portSeedWindowOpen: true,
          portSeedPartnerCommitted: true,
          tradeShipCount: 0,
          portSeedSources: sources,
        },
        config: liveEconomyConfig,
      });
    assert.equal(
      priceAt(portTicks + 1)?.refused,
      true,
      "the first completed seed Port projects no payout while the partner is still building",
    );
    assert.equal(
      priceAt(partnerDelayTicks)?.refused,
      true,
      "the seed pair projects no payout at the tick the slower Port completes",
    );
    const afterBoth = priceAt(matchHorizonTicks);
    assert.ok(
      afterBoth.refused !== true && afterBoth.incomePerTick > 0,
      "once both Ports complete, the committed pair projects positive team income",
    );
    const ownStream = priceAt(matchHorizonTicks, [ownSource]);
    const partnerStream = priceAt(matchHorizonTicks, [partnerSource]);
    assert.ok(
      ownStream.refused !== true && ownStream.incomePerTick > 0,
      "the builder's own committed route has positive projected income",
    );
    assert.ok(
      partnerStream.refused !== true && partnerStream.incomePerTick > 0,
      "the teammate's committed route has positive projected income",
    );
  });

  scenario("seed pair: no eligible partner water refuses the pure-economy Port", () => {
    const owner = waterPlayer(1, 7);
    const landlocked = Object.create(sandbox.__StructureBehavior.prototype);
    landlocked.player = owner;
    landlocked.game = { players: () => [owner], sharedWaterComponents: () => new Set() };
    assert.equal(
      landlocked.legendaryPortSeedWindowOpen(),
      false,
      "no shared water means no seed window",
    );
    assert.equal(
      sandbox.legendaryEconomyNetGold(UNIT.Port, {
        cost: portCost,
        horizonTicks: matchHorizonTicks,
        inputs: { hasCompletedTradePartner: false, tradeShipCount: 0 },
        config: liveEconomyConfig,
      }).refused,
      true,
      "without a partner or committed seed the pure-economy Port is refused",
    );
    const uncommitted = sandbox.legendaryEconomyNetGold(UNIT.Port, {
      cost: portCost,
      horizonTicks: matchHorizonTicks,
      inputs: {
        hasCompletedTradePartner: false,
        portSeedWindowOpen: true,
        tradeShipCount: 0,
        portSeedSources: [],
      },
      config: liveEconomyConfig,
    });
    assert.ok(
      uncommitted === null || uncommitted.refused === true,
      "an open but uncommitted seed window admits no pure-economy Port",
    );
  });
}

function checkSeedOwners(sandbox) {
  const seedBehaviorFor = (players, actor) => {
    const behavior = Object.create(sandbox.__StructureBehavior.prototype);
    behavior.player = actor;
    behavior.game = {
      players: () => players,
      sharedWaterComponents: () => new Set([-1]),
      forEachNeighbor: (tile, callback) => callback(tile + 1),
      isWater: () => true,
      isOcean: () => true,
    };
    return behavior;
  };

  scenario("seed pair: deterministic two-owner commitment on shared water", () => {
    const ownerA = waterPlayer(1, 7);
    const ownerB = waterPlayer(2, 7);
    const third = waterPlayer(3, 7);
    const fourth = waterPlayer(4, 7);
    const forward = seedBehaviorFor([ownerA, ownerB, third, fourth], ownerA);
    const reverse = seedBehaviorFor([fourth, third, ownerB, ownerA], ownerA);
    const expectedPair = ["1", "2"];
    assert.deepEqual(
      Array.from(forward.legendaryPortSeedOwnerIds(-1)),
      expectedPair,
      "the seed selector commits the two smallest tradeable owner ids",
    );
    assert.deepEqual(
      Array.from(reverse.legendaryPortSeedOwnerIds(-1)),
      expectedPair,
      "reversing the players() enumeration keeps the same deterministic pair",
    );
    assert.deepEqual(
      Array.from(forward.legendaryPortSeedOwnerIds(-1)),
      Array.from(forward.legendaryPortSeedOwnerIds(-1)),
      "repeated calls return the identical pair",
    );
    assert.equal(
      forward.legendaryPortSeedWindowOpen(-1),
      true,
      "a pair member may open the window",
    );
    const thirdView = seedBehaviorFor([ownerA, ownerB, third, fourth], third);
    const fourthView = seedBehaviorFor([ownerA, ownerB, third, fourth], fourth);
    assert.equal(
      thirdView.legendaryPortSeedWindowOpen(-1),
      false,
      "a third teammate cannot open a second seed window on the same water",
    );
    assert.equal(
      fourthView.legendaryPortSeedWindowOpen(-1),
      false,
      "a fourth teammate cannot commit a second seed pair on the same water",
    );
  });
}
