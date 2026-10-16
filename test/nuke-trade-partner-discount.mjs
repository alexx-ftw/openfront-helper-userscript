// Trade-cohesion regression for nukeTileScore. Trade ships and train stops
// pay both endpoints, but eligibility alone does not prove a live route;
// factories do not pay train-stop income. This pins the coarse half-face-value
// score adjustment for an active owned carrier whose exposed target is a paid
// City/Port stop. It is a relative-score heuristic, not a gold forecast or
// efficacy claim. See docs/legendary-metric-ceilings.md.

import assert from "node:assert/strict";
import { createNukeTradePartnerDiscountFixture } from "./helpers/nuke-trade-partner-discount-fixture.mjs";

const { UNIT, makeWorld, makeScorer, scoreStructure } = createNukeTradePartnerDiscountFixture();

// A mutually tradeable player is not automatically an active trade partner.
// Without an owned ship/train targeting the structure, preserve face value.
assert.equal(
  scoreStructure(UNIT.Port, 2),
  30_000,
  "a merely trade-eligible partner's port keeps full face value",
);

// The scorer applies a provisional half-value discount when an active owned
// carrier targets a paid Port/City stop. This pins the ranking heuristic; it
// does not model route revenue or claim an outcome improvement.
assert.equal(
  scoreStructure(UNIT.Port, 2, { carrierType: UNIT.TradeShip }),
  15_000,
  "an active owned trade ship discounts its target port",
);
assert.equal(
  scoreStructure(UNIT.Port, 2, {
    carrierType: UNIT.TradeShip,
    embargoed: true,
  }),
  30_000,
  "mutual embargo removes the active-route discount",
);
assert.equal(
  scoreStructure(UNIT.Port, 2, {
    carrierType: UNIT.TradeShip,
    carrierActive: false,
  }),
  30_000,
  "an inactive trade ship does not discount its target port",
);
assert.equal(
  scoreStructure(UNIT.City, 1, { carrierType: UNIT.Train }),
  12_500,
  "an active owned train discounts its target city",
);

// A foreign carrier only pays our destination owner, not us; factories are
// not paid rail stops; counterforce value is unrelated to trade.
assert.equal(
  scoreStructure(UNIT.Port, 2, {
    carrierType: UNIT.TradeShip,
    carrierOwnerTag: "rival",
  }),
  30_000,
  "a foreign trade ship does not count as our outgoing income",
);
assert.equal(
  scoreStructure(UNIT.Factory, 2, { carrierType: UNIT.Train }),
  30_000,
  "a factory does not collect trade-stop payouts",
);
assert.equal(
  scoreStructure(UNIT.SAMLauncher, 1, { carrierType: UNIT.TradeShip }),
  100_000,
  "a SAM keeps full counterforce value even if a ship targets its tile",
);

// The destination snapshot is built once per game tick and refreshed on the
// next tick, keeping candidate scoring from rescanning carrier lists.
{
  const world = makeWorld();
  let reads = 0;
  const port = {
    id: () => "partner-port",
    type: () => UNIT.Port,
    level: () => 1,
    tile: () => 10,
    owner: () => world.partner,
  };
  const ship = {
    type: () => UNIT.TradeShip,
    owner: () => world.us,
    targetUnit: () => port,
    isActive: () => true,
  };
  const { behavior, advanceTick } = makeScorer(world.us, [], () => reads++);
  const silo = { tile: () => 10 };
  const score = () => behavior.nukeTileScore(10, [silo], [port], UNIT.AtomBomb, false);
  assert.equal(score(), 15_000);
  assert.equal(score(), 15_000);
  assert.equal(reads, 1, "trade destination lookup is cached per tick");
  world.us.units = (...types) => {
    reads++;
    return types.includes(UNIT.TradeShip) ? [ship] : [];
  };
  assert.equal(score(), 15_000, "same-tick score reuses the snapshot");
  advanceTick();
  assert.equal(score(), 7_500, "next tick refreshes active trade destinations");
  assert.equal(reads, 2, "one destination scan occurs per game tick");
}

process.stdout.write("nuke trade-partner discount tests passed\n");
