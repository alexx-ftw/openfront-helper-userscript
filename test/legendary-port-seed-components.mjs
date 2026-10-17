import assert from "node:assert/strict";
import { createLegendaryPortSeedFixture } from "./helpers/legendary-port-seed-components-fixture.mjs";

const {
  actor,
  actorPorts,
  behavior,
  deterministicPartner,
  existingOceanPortShore,
  lakeComponent,
  lakeShore,
  makePort,
  oceanComponent,
  oceanShore,
  secondOceanComponent,
  secondOceanShore,
  secondPartnerShore,
  thirdTeammate,
} = createLegendaryPortSeedFixture();

assert.equal(behavior.portOwnerStateOnWater(actor, oceanComponent).completed, false);
assert.equal(behavior.portOwnerStateOnWater(actor, lakeComponent).completed, false);
assert.equal(behavior.legendaryPortSeedWindowOpen(), true);
assert.deepEqual(
  Array.from(behavior.legendaryPortSeedOwnerIds(oceanComponent)),
  ["1", "2"],
  "the ocean seed owner pair is chosen by stable ID even when players() lists the third teammate first",
);
assert.deepEqual(
  Array.from(behavior.legendaryPortSeedOwnerIds(secondOceanComponent)),
  ["1", "3"],
  "a second shared ocean component gets its own deterministic two-owner pair",
);
assert.equal(
  behavior.legendaryPortSeedPartner(),
  deterministicPartner,
  "the first open component selects its deterministic second owner as partner",
);
assert.equal(
  behavior.legendaryPortSeedPartner(secondOceanComponent),
  thirdTeammate,
  "partner lookup follows the selected component instead of reusing the first component's owner",
);

const candidateTiles = Array.from(behavior.legendaryPortCandidateTilesForEconomy());
assert.deepEqual(candidateTiles, [oceanShore, secondOceanShore]);
assert.ok(!candidateTiles.includes(lakeShore), "shared inland lakes are not Port sites");

const selectedPartnerSeed = {
  portSeedWaterComponent: secondOceanComponent,
  placementTile: secondPartnerShore,
};
let quotedOwner = null;
deterministicPartner.buildables = async (tile) => {
  quotedOwner = "first-component-partner";
  return [{ type: "Port", canBuild: tile, cost: 17n }];
};
thirdTeammate.buildables = async (tile) => {
  quotedOwner = "selected-component-partner";
  return [
    { type: "Port", canBuild: secondOceanShore, cost: 1n },
    { type: "Port", canBuild: tile, cost: 42n },
  ];
};
assert.equal(
  await behavior.legendaryPortSeedPartnerBuildCostQuote(selectedPartnerSeed),
  42n,
  "the joint seed is priced from the exact selected partner and matching tile quote",
);
assert.equal(quotedOwner, "selected-component-partner");

const workerFailure = new Error("partner worker unavailable");
thirdTeammate.buildables = async () => {
  throw workerFailure;
};
assert.equal(
  await behavior.legendaryPortSeedPartnerBuildCostQuote(selectedPartnerSeed),
  null,
  "an optional partner worker rejection conservatively refuses the unpriced seed",
);
const quoteFailure = new Error("unexpected partner quote getter failure");
thirdTeammate.buildables = async (tile) => [
  {
    type: "Port",
    canBuild: tile,
    get cost() {
      throw quoteFailure;
    },
  },
];
await assert.rejects(
  behavior.legendaryPortSeedPartnerBuildCostQuote(selectedPartnerSeed),
  (error) => error === quoteFailure,
  "unexpected quote parsing errors propagate without being treated as worker failures",
);

thirdTeammate.buildables = async (tile) => {
  const buildable = { type: "Port", canBuild: tile, cost: 42n };
  await Promise.resolve();
  buildable.canBuild = secondOceanShore;
  return [buildable];
};
assert.equal(
  await behavior.legendaryPortSeedPartnerBuildCostQuote(selectedPartnerSeed),
  null,
  "a partner quote is rejected when its buildable canBuild changes from the selected tile",
);

actorPorts.push(makePort(existingOceanPortShore, true));
assert.equal(behavior.portOwnerStateOnWater(actor, oceanComponent).inProgress, true);
assert.equal(
  behavior.legendaryPortSeedWindowOpen(oceanComponent),
  false,
  "starting the actor's Port closes only that component's seed window",
);
assert.equal(behavior.legendaryPortSeedWindowOpen(secondOceanComponent), true);
assert.equal(behavior.portCandidateHasTradeRoute(secondOceanShore), true);
assert.equal(
  behavior.legendaryPortSeedPartner(),
  thirdTeammate,
  "the remaining component keeps its own selected partner after the first component is seeded",
);
assert.deepEqual(
  Array.from(behavior.legendaryPortCandidateTilesForEconomy()),
  [secondOceanShore],
  "an in-progress Port blocks duplicates only on its own component",
);

process.stdout.write(
  "PASS Legendary Port seeds are component-scoped and quote the selected partner tile\n",
);
