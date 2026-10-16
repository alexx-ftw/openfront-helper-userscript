import assert from "node:assert/strict";
import fs from "node:fs";
import { executeClassicScript } from "./helpers/classic-script.mjs";
const sandbox = {};
executeClassicScript(
  fs.readFileSync(new URL("../engine/ingame/nuke-suggestions.js", import.meta.url), "utf8"),
  sandbox,
);
executeClassicScript(
  "globalThis.api = { cloneAutoNukePlanState, getAutoNukePopulationMarginalScore, selectAutoNukeAtomAlternatives };",
  sandbox,
);
const { api } = sandbox;
const state = api.cloneAutoNukePlanState();
const territory = { x: 0, y: 0, magnitude: { outer: 10 }, populationLoss: 100 };
assert.equal(
  api.getAutoNukePopulationMarginalScore(territory, state),
  100,
  "an enemy with no cities still has a population target",
);
state.selectedCandidates.push(territory);
assert.equal(
  api.getAutoNukePopulationMarginalScore(territory, state),
  0,
  "territory population is not credited twice in the same blast area",
);
const hydrogenCovered = api.cloneAutoNukePlanState();
hydrogenCovered.selectedCandidates.push({ x: 0, y: 0, magnitude: { outer: 100 } });
assert.equal(
  api.getAutoNukePopulationMarginalScore({ ...territory, x: 50 }, hydrogenCovered),
  0,
  "an atom footprint fully contained by a hydrogen footprint has no new population objective",
);
assert.ok(
  api.getAutoNukePopulationMarginalScore({ ...territory, x: 120 }, hydrogenCovered) > 0,
  "territory outside the previous hydrogen footprint remains available",
);
const pristine = api.cloneAutoNukePlanState();
const city = { ...territory, hitCityPopulationWeights: new Map([["city", 1000]]) };
pristine.hitCityPopulationKeys.add("city");
assert.equal(
  api.getAutoNukePopulationMarginalScore(city, pristine),
  0,
  "an already covered named objective does not justify another shot",
);
const alternatives = [
  { score: 100, cost: 6, shots: 1 },
  { score: 90, cost: 6, shots: 1 },
  { score: 80, cost: 4, shots: 1 },
];
const budget = api.selectAutoNukeAtomAlternatives(alternatives, {
  remainingGold: 10,
  remainingSiloSlots: 5,
});
assert.equal(budget.cost, 10);
assert.equal(
  budget.score,
  180,
  "atom portfolio obeys aggregate gold and can skip an unaffordable shot",
);
assert.equal(
  api.selectAutoNukeAtomAlternatives(alternatives, { remainingGold: 100, remainingSiloSlots: 1 })
    .shots,
  1,
);
const portfolioState = api.cloneAutoNukePlanState();
const economic = { ...territory, hitEconomicStructureWeights: new Map([["factory", 100]]) };
const duplicate = { ...economic, x: 100 };
const portfolio = api.selectAutoNukeAtomAlternatives(
  [
    { candidate: economic, score: 100, cost: 1, shots: 1 },
    { candidate: duplicate, score: 100, cost: 1, shots: 1 },
  ],
  { mode: "economic", state: portfolioState, remainingGold: 10, remainingSiloSlots: 5 },
);
assert.equal(portfolio.score, 100, "overlapping objective sets cannot inflate the atom comparison");
assert.equal(portfolio.shots, 1);
assert.equal(
  portfolioState.hitEconomicStructureKeys.size,
  0,
  "hypothetical atoms do not mutate live reservations",
);
assert.equal(portfolioState.selectedCandidates.length, 0);
console.warn("nuke target portfolio tests passed");
