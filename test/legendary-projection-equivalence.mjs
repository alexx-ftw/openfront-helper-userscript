// Differential arithmetic guard: optimize current code without changing one
// projected count or investment value from this immutable reviewed candidate.
// Normal checks need no git history; --capture alone reads the pinned source.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const goldenPath = new URL(
  "./fixtures/legendary-projection-equivalence.golden.json",
  import.meta.url,
);
const referenceCommit = "7531188cadfbc5626c523fd920efe8340bd9f6c8";
const referenceSourceHash = "ddc4b118244389ba6482a2d8dd9f5e05bc0c708f1628ab9919d6f34dee1e87b0";
const capture = process.argv.includes("--capture");
let source = readLegendaryPlannerSource();
if (capture) {
  source = Array.from({ length: 22 }, (_, index) =>
    execFileSync(
      "/usr/bin/git",
      [
        "show",
        `${referenceCommit}:engine/ingame/auto-bot/legendary-planner/part-${String(index + 1).padStart(2, "0")}.js`,
      ],
      { cwd: root, encoding: "utf8" },
    ),
  ).join("\n");
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    referenceSourceHash,
    "capture must use the immutable reviewed reference source",
  );
}
const context = { console };
executeClassicScript(source, context, { filename: "planner-equivalence.vm.js" });
// Tagged, length-delimited encoding includes object keys and raw IEEE754
// numbers. In particular -0 differs from +0; there is no decimal rounding.
function digest(value) {
  const hash = createHash("sha256");
  const length = (count) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(count);
    hash.update(bytes);
  };
  const encode = (entry) => {
    if (typeof entry === "number") {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(entry);
      hash.update("number");
      hash.update(bytes);
    } else if (entry !== null && typeof entry === "object") {
      hash.update(Array.isArray(entry) ? "array" : "object");
      const keys = Object.keys(entry);
      length(keys.length);
      for (const key of keys) {
        encode(key);
        encode(entry[key]);
      }
    } else {
      hash.update(typeof entry);
      const bytes = Buffer.from(String(entry));
      length(bytes.length);
      hash.update(bytes);
    }
  };
  encode(value);
  return hash.digest("hex");
}
assert.notEqual(digest(-0), digest(0), "IEEE754 encoding preserves signed zero");
assert.notEqual(digest({ a: 1 }), digest({ b: 1 }), "encoding includes property names");
const expected = capture ? null : JSON.parse(readFileSync(goldenPath, "utf8"));
if (expected) {
  assert.equal(expected.referenceCommit, referenceCommit);
  assert.equal(expected.sourceSHA256, referenceSourceHash);
  assert.equal(expected.encoding, "tagged-keys-ieee754be-v1");
}
const records = [];
function record(id, value) {
  const actual = { id, sha256: digest(value) };
  if (expected)
    assert.deepEqual(actual, expected.records[records.length], `projection changed: ${id}`);
  records.push(actual);
}
const random = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const config = (variant) => ({
  unitInfo: () => ({ constructionDuration: 7 + variant }),
  trainStationMaxRange: () => 24 + variant,
  trainSpawnRate: (factories, trains) =>
    Math.max(1, 11 + Math.floor(trains / (3 + variant)) + factories * (2 + variant)),
  tradeShipSpawnRate: (roll, ships) =>
    Math.max(1, 17 + roll * 3 + Math.floor(ships / (2 + variant))),
});
function scenario(seed, owners = 3, units = 3, horizon = 180) {
  const next = random(seed);
  const integer = (limit) => Math.floor(next() * limit);
  const route = () => ({
    weight: 1 + integer(4),
    postAllianceWeight: 1 + integer(2),
    distance: integer(25) + integer(4) / 4,
    allianceTicksRemaining: integer(horizon) + 0.5,
    teamGoldPerArrival: 100 + integer(800),
    postAllianceGoldPerArrival: 100 + integer(800),
  });
  const supply = {
    trainLifetimeTicks: 11 + integer(20),
    initialTradeShipRemainingTicks: [1, 2.25, 9, horizon + 1],
    trainOwners: Array.from({ length: owners }, (_, owner) => ({
      ownerId: `owner-${owner}`,
      isBuilder: owner === 0,
      factoryCount: units * 3 + owner,
      factories: Array.from({ length: units }, () => ({
        level: 1 + integer(4),
        readyAtTicks: integer(30) / 2,
      })),
    })),
    portOwners: Array.from({ length: owners }, (_, owner) => ({
      ownerId: `owner-${owner}`,
      ports: Array.from({ length: units }, () => ({
        level: 1 + integer(4),
        readyAtTicks: integer(30) / 2,
        routes: [route(), route()],
      })),
    })),
  };
  const inputs = {
    trainCount: integer(100) + 0.25,
    tradeShipCount: integer(80) + 0.75,
    fleetProducerSupply: supply,
    trainLifetimeTicks: supply.trainLifetimeTicks,
  };
  const routes = [route(), route(), route()];
  const oldPort = supply.portOwners[1].ports[0];
  return {
    seed,
    horizon,
    inputs,
    routes,
    candidates: [
      {},
      { factoryReadyAt: 7.5, factoryCountReadyAt: 0, builderFactoryCount: units * 3 },
      {
        factoryReadyAt: 0,
        factoryCountReadyAt: 3.5,
        factoryUpgradeLevel: 2,
        builderFactoryCount: units * 3,
      },
      { portReadyAt: 9.25, portRoutes: routes },
      { portReadyAt: 0, portUpgradeLevel: 3, portRoutes: routes },
      {
        portReadyAt: 4.5,
        portRoutes: routes,
        portInboundSources: [
          {
            ownerId: "owner-1",
            level: oldPort.level,
            readyAtTicks: oldPort.readyAtTicks,
            beforeRoutes: oldPort.routes,
            routes,
          },
        ],
      },
      {
        factoryReadyAt: 4,
        factoryCountReadyAt: 0,
        builderFactoryCount: units * 3,
        portReadyAt: 9,
        portRoutes: routes,
      },
    ],
  };
}
const cases = Array.from({ length: 12 }, (_, index) => scenario(0x51a0 + index));
// Exercise the candidate-only Factory branch when no exposed owner is the builder.
for (const owner of cases[11].inputs.fleetProducerSupply.trainOwners) owner.isBuilder = false;
cases.push(scenario(0x51ff, 16, 16, 256)); // 512 mixed producer units.
cases.push(scenario(0x5200, 2, 2, 4096)); // Longer fleet decay and saturation.
for (const fixture of cases) {
  const inputs = structuredClone(fixture.inputs);
  const liveConfig = config(fixture.seed % 3);
  for (const [index, candidate] of fixture.candidates.entries()) {
    for (let pass = 0; pass < 2; pass++) {
      const fleet = context.legendaryProjectEconomyFleets(
        inputs,
        liveConfig,
        fixture.horizon,
        structuredClone(candidate),
      );
      record(`seed=${fixture.seed}/candidate=${index}/pass=${pass}`, {
        before: fleet.before,
        after: fleet.after,
      });
    }
  }
  for (const type of ["Port", "Factory"]) {
    const economyInputs = {
      ...fixture.inputs,
      hasCompletedTradePartner: true,
      portRoutes: fixture.routes,
      ownFactoryCount: 9,
      ownProductiveFactoryLevels: [1, 2, 3],
      factoryPaidStops: 2,
      factoryTeamGoldPerTrain: 2000,
      routeDelayTicks: 4.5,
      factoryRouteProfiles: [
        {
          clusterId: "rail",
          factorySourceCount: 1,
          paidStops: 2,
          teamGoldPerSpawn: 2000,
          postTeamGoldPerSpawn: 900,
          eligibleTicks: 17.5,
          payoutTimeline: [
            { atTicks: 0, teamGoldPerSpawn: 2000 },
            { atTicks: 17.5, teamGoldPerSpawn: 900 },
          ],
        },
      ],
    };
    const result = context.legendaryEconomyNetGold(type, {
      cost: 100,
      horizonTicks: fixture.horizon,
      inputs: structuredClone(economyInputs),
      config: config(fixture.seed % 3),
    });
    record(`seed=${fixture.seed}/net=${type}`, result);
  }
}
if (capture) {
  writeFileSync(
    goldenPath,
    JSON.stringify(
      {
        referenceCommit,
        sourceSHA256: referenceSourceHash,
        encoding: "tagged-keys-ieee754be-v1",
        seeds: cases.map(({ seed }) => seed),
        records,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  assert.equal(records.length, expected.records.length, "all golden cases were exercised");
}
process.stdout.write(
  `PASS projection equivalence: ${records.length} cold/warm fleet and net-value digests; ` +
    `reference=${referenceCommit}; mode=${capture ? "capture" : "check"}\n`,
);

if (!capture) {
  // A producer's static readiness and level need not be observed every native
  // tick. Instrument the public cohort boundary rather than source syntax so
  // this guards repeated work across any equivalent projection implementation.
  const originalCohorts = context.legendaryTradePortCohorts;
  const staticReads = (horizon) => {
    let reads = 0;
    context.legendaryTradePortCohorts = (...args) =>
      originalCohorts(...args).map((cohort) => {
        const level = cohort.level;
        const readyAt = cohort.readyAtTicks;
        return {
          ...cohort,
          get level() {
            reads++;
            return level;
          },
          get readyAtTicks() {
            reads++;
            return readyAt;
          },
        };
      });
    try {
      context.legendaryProjectEconomyFleets(
        {
          trainCount: 0,
          tradeShipCount: 2,
          fleetProducerSupply: {
            portOwners: [
              {
                ownerId: "work-probe",
                ports: [
                  {
                    level: 2,
                    readyAtTicks: 3.5,
                    routes: [{ weight: 1, distance: 11 }],
                  },
                ],
              },
            ],
          },
        },
        config(0),
        horizon,
        {},
      );
    } finally {
      context.legendaryTradePortCohorts = originalCohorts;
    }
    return reads;
  };
  const shortReads = staticReads(64);
  const longReads = staticReads(4096);
  assert.ok(shortReads > 0, "the cohort work probe observes real producer reads");
  assert.ok(
    longReads <= shortReads * 2 + 8 && longReads <= 32,
    `static cohort work must remain bounded as horizon grows: ${shortReads} -> ${longReads}`,
  );
  process.stdout.write(`PASS static cohort work: 64ticks=${shortReads}, 4096ticks=${longReads}\n`);
}
