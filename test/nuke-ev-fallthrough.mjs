import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/nukeBehavior.js"),
  "utf8",
);
const sharedUtilsSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/shared-utils.js"),
  "utf8",
);

const UNIT = { AtomBomb: "Atom Bomb", HydrogenBomb: "Hydrogen Bomb" };
const sandbox = {
  UNIT,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  Relation: { Hostile: "Hostile" },
  PlayerType: { Bot: "Bot" },
  state: { settings: { winFixes: true }, stats: { nukes: 0 }, recentMirvHits: [] },
  currentDifficulty: () => sandbox.Difficulty.Legendary,
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: (difficulty) => difficulty === "Legendary",
  console,
};
sandbox.globalThis = sandbox;
executeClassicScript(sharedUtilsSource, sandbox, { filename: "shared-utils.vm.js" });
executeClassicScript(
  `${source}\nglobalThis.__NukeBehavior = NukeBehavior;`,
  sandbox,
  { filename: "nuke-ev-fallthrough.vm.js" },
);

function makeBehavior({ clear, expectedValueMin }) {
  const behavior = Object.create(sandbox.__NukeBehavior.prototype);
  behavior.player = { gold: () => 10_000_000n };
  behavior.partitionCandidatesBySamCoverage = () => ({ clear });
  behavior.probeCanBuildNuke = async () => true;
  behavior.nukeHasPositiveExpectedValue = async (cand) =>
    cand.value >= expectedValueMin;
  const sent = [];
  behavior.sendNuke = async (...args) => sent.push(args);
  const tail = { sam: 0, hydrogen: 0 };
  behavior.maybeDestroyEnemySam = async () => {
    tail.sam += 1;
  };
  behavior.maybeFirePostSalvoHydrogen = async () => {
    tail.hydrogen += 1;
  };
  return { behavior, sent, tail };
}

const target = { smallID: () => 7 };
const richButEvFailing = { tile: 10, value: 125_000 };
const poorerButEvPassing = { tile: 20, value: 1_000_000 };

// 1. Legendary: the EV rejection of the top-scored candidate no longer masks
// the next ranked candidate.
{
  const { behavior, sent, tail } = makeBehavior({
    clear: [richButEvFailing, poorerButEvPassing],
    expectedValueMin: 1_000_000,
  });
  await behavior.fireNukeFromCandidates(
    [richButEvFailing, poorerButEvPassing],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Legendary",
  );
  assert.deepEqual(
    sent,
    [[20, UNIT.AtomBomb, target]],
    "Legendary walks past an EV-rejected top candidate to the EV-positive one",
  );
  assert.deepEqual(tail, { sam: 0, hydrogen: 0 });
}

// 2. The value <= -1 stop still terminates the walk before lower candidates.
{
  const { behavior, sent } = makeBehavior({
    clear: [{ tile: 1, value: -2 }, poorerButEvPassing],
    expectedValueMin: 1_000_000,
  });
  await behavior.fireNukeFromCandidates(
    [{ tile: 1, value: -2 }, poorerButEvPassing],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Legendary",
  );
  assert.deepEqual(sent, [], "a value <= -1 candidate stops the Legendary walk");
}

// 3. Total EV rejection still reaches the SAM/Hydrogen tail.
{
  const { behavior, sent, tail } = makeBehavior({
    clear: [richButEvFailing],
    expectedValueMin: 1_000_000,
  });
  await behavior.fireNukeFromCandidates(
    [richButEvFailing],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Legendary",
  );
  assert.deepEqual(sent, [], "a fully rejected list fires nothing");
  assert.equal(tail.sam, 1, "the anti-SAM tail still runs after total rejection");
}

// 4. Non-Legendary keeps the faithful single-pick path (no walk).
{
  const { behavior, sent } = makeBehavior({
    clear: [richButEvFailing, poorerButEvPassing],
    expectedValueMin: 1_000_000,
  });
  await behavior.fireNukeFromCandidates(
    [richButEvFailing, poorerButEvPassing],
    target,
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
    "Impossible",
  );
  assert.deepEqual(
    sent,
    [],
    "non-Legendary still fires nothing when its single pick fails EV",
  );
}

console.log("nuke-ev-fallthrough tests passed");
