import assert from "node:assert/strict";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";

const SOURCE = repositoryFilePath("engine/ingame/spawn-objective.js");

function loadApi() {
  const sandbox = { Array, Math, Number, Uint8Array, Uint16Array };
  sandbox.globalThis = sandbox;
  executeClassicScript(readRepositoryFile("engine/ingame/spawn-objective.js"), sandbox, {
    filename: SOURCE,
  });
  assert.ok(sandbox.__OFHSpawnObjective, "spawn objective API must be exposed");
  return sandbox.__OFHSpawnObjective;
}

const api = loadApi();

function test(name, fn) {
  {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  }
}

test("robust objective prefers a balanced candidate over a specialist", () => {
  const ranked = api.rankModelCandidates([
    { id: "specialist", startScore: 1, expansionScore: 0.1, safetyScore: 1, teamScore: 1 },
    { id: "balanced", startScore: 0.8, expansionScore: 0.8, safetyScore: 0.8, teamScore: 0.8 },
  ]);

  assert.equal(ranked[0].id, "balanced");
  assert.equal(ranked[0].objective.robustFloor, 0.8);
});

test("dominance keeps a candidate that is never worse on any model dimension", () => {
  const ranked = api.rankModelCandidates([
    { id: "dominated", startScore: 0.6, expansionScore: 0.6, safetyScore: 0.6, teamScore: 0.6 },
    { id: "dominant", startScore: 0.7, expansionScore: 0.6, safetyScore: 0.8, teamScore: 0.6 },
  ]);

  assert.equal(ranked[0].id, "dominant");
});

test("extracts only the official clan-tag display prefix", () => {
  assert.equal(api.extractClanTag("[FOX] Pilot"), "FOX");
  assert.equal(api.extractClanTag("[fOx] Pilot"), "FOX");
  assert.equal(api.extractClanTag("Pilot"), null);
  assert.equal(api.extractClanTag("[F] Pilot"), null);
  assert.equal(api.extractClanTag("[FOX]Pilot"), null);
});

test("same-clan matching never groups players without a real tag", () => {
  assert.equal(api.sameClanTag("FOX", "fox"), true);
  assert.equal(api.sameClanTag("FOX", "WOLF"), false);
  assert.equal(api.sameClanTag(null, "FOX"), false);
  assert.equal(api.sameClanTag("", ""), false);
});

test("reads the raw PlayerView display name when available", () => {
  const player = {
    __src: { static: { displayName: "[FOX] Pilot" } },
    displayName: () => "Pilot",
  };
  assert.equal(api.getPlayerClanTag(player), "FOX");
  assert.equal(api.getPlayerClanTag({ displayName: () => "Pilot" }), null);
});

test("clan proximity is strongest at the known spawn and vanishes outside its radius", () => {
  const points = [{ x: 100, y: 100 }];
  assert.equal(api.clanProximityScore(100, 100, points, 110), 1);
  assert.equal(api.clanProximityScore(155, 155, points, 110), 0);
  assert.equal(api.clanProximityScore(100, 100, [], 110), 0);
});

test("clan proximity outranks the legacy visual tie-break after robust dimensions", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "far-clan",
      ref: 1,
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 1,
      clanScore: 0,
      score: 999,
    },
    {
      id: "near-clan",
      ref: 2,
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 1,
      clanScore: 1,
      score: 0,
    },
  ]);

  assert.equal(ranked[0].id, "near-clan");
  assert.equal(ranked[0].objective.clanScore, 1);
});

test("free-land availability outranks clan proximity", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "near-clan-open-land",
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 0.8,
      tribeReachScore: 0.8,
      tribeReachCount: 2,
      freeLandScore: 0.9,
      clanScore: 0,
    },
    {
      id: "near-clan-limited-land",
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 0.8,
      tribeReachScore: 0.8,
      tribeReachCount: 2,
      freeLandScore: 0.4,
      clanScore: 1,
    },
  ]);

  assert.equal(ranked[0].id, "near-clan-open-land");
  assert.equal(ranked[0].objective.freeLandScore, 0.9);
});

test("tribe and nation opportunity is part of the robust spawn objective", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "far-targets",
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 0.8,
      tribeScore: 0,
      nationScore: 0,
      resourceScore: 0,
    },
    {
      id: "near-targets",
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 0.8,
      tribeScore: 1,
      nationScore: 0.5,
      resourceScore: 0.8,
    },
  ]);

  assert.equal(ranked[0].id, "near-targets");
  assert.equal(ranked[0].objective.tribeScore, 1);
  assert.equal(ranked[0].objective.nationScore, 0.5);
  assert.equal(ranked[0].objective.resourceScore, 0.8);
});

test("inside-team spawn ranking prefers the densest tribe cluster", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "broad-reach",
      freeLandScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 1,
      teamPolyhedronScore: 1,
      tribeClusterScore: 0.2,
      tribeReachCount: 5,
      tribeReachScore: 0.8,
      resourceScore: 0.8,
    },
    {
      id: "dense-cluster",
      freeLandScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 1,
      teamPolyhedronScore: 1,
      tribeClusterScore: 0.9,
      tribeReachCount: 4,
      tribeReachScore: 0.8,
      resourceScore: 0.8,
    },
  ]);
  assert.equal(ranked[0].id, "dense-cluster");
});

test("inside the same tribe cluster, team-interior depth avoids the formation border", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "formation-edge",
      freeLandScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 1,
      teamPolyhedronScore: 1,
      teamInteriorScore: 0.05,
      tribeClusterScore: 0.9,
      tribeReachCount: 4,
      tribeReachScore: 0.8,
      resourceScore: 0.8,
    },
    {
      id: "formation-interior",
      freeLandScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 1,
      teamPolyhedronScore: 1,
      teamInteriorScore: 0.8,
      tribeClusterScore: 0.9,
      tribeReachCount: 4,
      tribeReachScore: 0.8,
      resourceScore: 0.8,
    },
  ]);
  assert.equal(ranked[0].id, "formation-interior");
});

test("inside-team tribe density outranks a modest free-land advantage", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "more-open-land",
      freeLandScore: 0.95,
      expansionScore: 0.95,
      safetyScore: 0.8,
      teamScore: 1,
      teamPolyhedronScore: 1,
      tribeClusterScore: 0.2,
      tribeReachCount: 5,
      tribeReachScore: 0.8,
      resourceScore: 0.8,
    },
    {
      id: "dense-tribe-core",
      freeLandScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 1,
      teamPolyhedronScore: 1,
      tribeClusterScore: 0.9,
      tribeReachCount: 4,
      tribeReachScore: 0.8,
      resourceScore: 0.8,
    },
  ]);
  assert.equal(ranked[0].id, "dense-tribe-core");
});

test("allied support beats an isolated richer frontier", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "open-frontier",
      startScore: 0.82,
      expansionScore: 0.92,
      safetyScore: 0.82,
      teamScore: 0.05,
      tribeReachScore: 0.9,
      tribeReachCount: 5,
      freeLandScore: 0.92,
      resourceScore: 0.9,
      tribeScore: 0.9,
      nationScore: 0.8,
      clanScore: 0,
    },
    {
      id: "teammate-cluster",
      startScore: 0.82,
      expansionScore: 0.72,
      safetyScore: 0.82,
      teamScore: 1,
      tribeReachScore: 0.5,
      tribeReachCount: 2,
      freeLandScore: 0.55,
      resourceScore: 0.7,
      tribeScore: 0.5,
      nationScore: 0.5,
      clanScore: 1,
    },
  ]);

  assert.equal(ranked[0].id, "teammate-cluster");
  assert.equal(ranked[0].objective.teamScore, 1);
});

test("reachable expansion cannot override the allied support floor", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "team-cluster",
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      freeLandScore: 0.8,
      resourceScore: 0.8,
      tribeReachScore: 0.2,
      tribeReachCount: 1,
      teamScore: 1,
    },
    {
      id: "reachable-frontier",
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      freeLandScore: 0.8,
      resourceScore: 0.8,
      tribeReachScore: 0.9,
      tribeReachCount: 4,
      teamScore: 0.1,
    },
  ]);

  assert.equal(ranked[0].id, "team-cluster");
});

test("inside the team polyhedron, terra nullius and reachable tribes lead the objective", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "safe-interior",
      startScore: 1,
      expansionScore: 0.6,
      safetyScore: 1,
      freeLandScore: 0.6,
      resourceScore: 0.6,
      tribeReachCount: 1,
      teamPolyhedronScore: 1,
    },
    {
      id: "open-interior",
      startScore: 0.8,
      expansionScore: 0.9,
      safetyScore: 0.8,
      freeLandScore: 0.9,
      resourceScore: 0.9,
      tribeReachCount: 3,
      teamPolyhedronScore: 1,
    },
  ]);

  assert.equal(ranked[0].id, "open-interior");
});

test("free land substitutes for tribes so empty expansible regions outrank crowded tribe-rich ones", () => {
  const ranked = api.rankModelCandidates([
    {
      id: "tribe-rich-crowded",
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.8,
      teamScore: 0.8,
      freeLandScore: 0.2,
      resourceScore: 0.9,
      tribeScore: 1,
      tribeReachScore: 0.9,
      tribeReachCount: 3,
    },
    {
      id: "empty-expansible",
      startScore: 0.8,
      expansionScore: 0.8,
      safetyScore: 0.9,
      teamScore: 0.8,
      freeLandScore: 1,
      resourceScore: 0.05,
      tribeScore: 0,
      tribeReachScore: 0,
      tribeReachCount: 0,
    },
  ]);

  assert.equal(ranked[0].id, "empty-expansible");
  assert.equal(
    ranked[0].objective.resourceScore,
    0.45,
    "an empty region keeps a lower fallback floor so reachable tribe richness wins when available",
  );
  assert.equal(ranked[0].objective.robustFloor, 0.45);
});

process.stdout.write("spawn-objective tests passed\n");
