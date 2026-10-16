import assert from "node:assert/strict";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";

const plannerSandbox = {};
executeClassicScript(
  readLegendaryPlannerSource(),
  plannerSandbox,
  { filename: "legendaryPlanner.js" },
);

const beats = plannerSandbox.legendarySeedCandidateBeats;

assert.equal(
  beats(
    { value: 1, routeDelay: 50, expectedNetTeamGold: 101 },
    { value: 999, routeDelay: 1, expectedNetTeamGold: 100 },
  ),
  true,
  "higher expected net team gold wins when both estimates are finite",
);
assert.equal(
  beats(
    {
      committed: false,
      ownInProgress: false,
      value: 999,
      routeDelay: 1,
      expectedNetTeamGold: 999,
    },
    {
      committed: true,
      ownInProgress: false,
      value: 1,
      routeDelay: 50,
      expectedNetTeamGold: 1,
    },
  ),
  false,
  "a committed seed remains preferred over a higher-value uncommitted candidate",
);
assert.equal(
  beats(
    {
      committed: true,
      ownInProgress: true,
      value: 1,
      routeDelay: 50,
      expectedNetTeamGold: 1,
    },
    {
      committed: true,
      ownInProgress: false,
      value: 999,
      routeDelay: 1,
      expectedNetTeamGold: 999,
    },
  ),
  true,
  "an own in-progress seed remains preferred over a higher-value partner-only commitment",
);
assert.equal(
  beats(
    { value: 10, routeDelay: 1, expectedNetTeamGold: 500 },
    { value: 20, routeDelay: 50, expectedNetTeamGold: Infinity },
  ),
  false,
  "nonfinite net estimates fall back to the current value ranking",
);
assert.equal(
  beats(
    { value: 20, routeDelay: 1, expectedNetTeamGold: 500 },
    { value: 20, routeDelay: 2, expectedNetTeamGold: NaN },
  ),
  true,
  "equal fallback values keep the shorter route-delay preference",
);
