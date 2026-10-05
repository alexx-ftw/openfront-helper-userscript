// Quiet-Post pure-surplus guard: the treasury predicate must be LIVE for the
// Legendary policy tier in FFA basket runs (the raw Legendary-equality gate
// was silently dead there: 22/23 FFA Post events through t=3000 fell below
// the surplus floor), and must stay OFF for team rows and non-Legendary
// tiers. Bisect variant (1): the FIRST quiet Post stays unguarded; the floor
// applies only to ADDITIONAL quiet Posts.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

// Portutil-faithful bridge: Impossible and Legendary are the same policy tier.
const isLegendaryDifficulty = (difficulty) =>
  difficulty === "Legendary" || difficulty === "Impossible";

function makeSandbox() {
  const sandbox = {
    UNIT: { City: "City", DefensePost: "Defense Post" },
    Difficulty: { Medium: "Medium", Hard: "Hard", Impossible: "Impossible", Legendary: "Legendary" },
    PlayerType: { Nation: "Nation", Human: "Human", Bot: "Bot" },
    state: { settings: { winFixes: true } },
    currentDifficulty: () => "Impossible",
    isLegendaryDifficulty,
    isAtLeastHardDifficulty: () => true,
    autoBotBuildAllowed: () => true,
    runtimeDebugLog: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(
    read("engine/ingame/auto-bot/legendaryPlanner.js") +
      "\n" +
      read("engine/ingame/auto-bot/structureBehavior.js") +
      "\nglobalThis.__StructureBehavior = StructureBehavior;",
    sandbox,
    { filename: "quiet-post-economy-guard.vm.js" },
  );
  return sandbox;
}

function makeBehavior(sandbox, { gold, gameMode, posts = 0 }) {
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  behavior.player = {
    troops: () => 1_320_451,
    gold: () => BigInt(gold),
    units: (type) =>
      type === sandbox.UNIT.City
        ? [{ isUnderConstruction: () => false }]
        : type === sandbox.UNIT.DefensePost
          ? Array.from({ length: posts }, () => ({}))
          : [],
  };
  behavior.game = {
    config: () => ({ gameConfig: () => ({ gameMode }) }),
  };
  behavior.strongestQuietStrategicBorderOpponent = () => ({
    opponentSid: 7,
    troops: 2_000_000,
  });
  behavior.liveHostilePlayers = () => [{ sid: 7, troops: () => 2_000_000, type: () => "Nation" }];
  behavior.borderingLandOwnerIds = () => new Set([7]);
  behavior.readPlayerSmallId = (p) => p.sid;
  behavior.getOpponentFrontTiles = (sid) => (sid === 7 ? ["t1", "t2"] : []);
  behavior.getConstructionCost = (type) =>
    type === sandbox.UNIT.DefensePost ? 100_000n : 500_000n;
  return behavior;
}

// 1. The FIRST quiet Post stays unguarded (kill-axis coverage).
{
  const sandbox = makeSandbox();
  const behavior = makeBehavior(sandbox, { gold: 100_700, gameMode: "Free For All", posts: 0 });
  const threat = behavior.computeStrategicBorderDefensePostThreat("Impossible");
  assert.equal(threat.strategicBorder, true, "first quiet Post is free");
}

// 2. FFA + Legendary policy tier + sub-surplus treasury: an ADDITIONAL quiet
// Post is blocked.
{
  const sandbox = makeSandbox();
  const behavior = makeBehavior(sandbox, { gold: 100_700, gameMode: "Free For All", posts: 1 });
  assert.equal(
    behavior.computeStrategicBorderDefensePostThreat("Impossible"),
    null,
    "sub-surplus ADDITIONAL quiet Post must be blocked once the guard is live",
  );
}

// 3. FFA + treasury above the surplus floor: the lane stays open.
{
  const sandbox = makeSandbox();
  const behavior = makeBehavior(sandbox, { gold: 600_001, gameMode: "Free For All", posts: 1 });
  const threat = behavior.computeStrategicBorderDefensePostThreat("Impossible");
  assert.equal(threat.strategicBorder, true);
  assert.deepEqual([...threat.frontTiles], ["t1", "t2"]);
}

// 4. Team rows: guard stays OFF (byte-preserving), sub-surplus Post still allowed.
{
  const sandbox = makeSandbox();
  const behavior = makeBehavior(sandbox, { gold: 100_700, gameMode: "Team", posts: 1 });
  const threat = behavior.computeStrategicBorderDefensePostThreat("Impossible");
  assert.equal(threat.strategicBorder, true, "team rows keep the pre-candidate behavior");
}

// 5. Non-Legendary tiers: guard OFF (threshold gates still govern the lane).
{
  const sandbox = makeSandbox();
  const behavior = makeBehavior(sandbox, { gold: 100_700, gameMode: "Free For All", posts: 1 });
  assert.equal(
    behavior.computeStrategicBorderDefensePostThreat("Hard").strategicBorder,
    true,
    "hard tier keeps the pre-candidate lane (guard is tier-scoped)",
  );
}

console.log("quiet-post-economy-guard OK");
