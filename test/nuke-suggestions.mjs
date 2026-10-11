import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NUKE_IMPACT_SOURCE = fs.readFileSync(path.join(ROOT, "engine/ingame/nuke-impact.js"), "utf8");
const SHARED_UTILS_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/shared-utils.js"),
  "utf8",
);
const NUKE_SUGGESTIONS_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/nuke-suggestions.js"),
  "utf8",
);

const sandbox = {
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  console,
  document: {},
  window: { setTimeout, clearTimeout },
  performance: { now: () => 0 },
  toFiniteNumber: (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback,
  getPlayerSmallId: () => NaN,
  getUnitLevel: (unit) => Number(unit?.level?.() || 1),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  autoNukeOriginalRootSubMenus: new Map(),
  autoNukeOriginalAttackSubMenus: new Map(),
  UniversalPathFinding: {
    Parabola: () => ({
      findPath: () => [0, 1, 2, 3, 4],
    }),
  },
};
sandbox.globalThis = sandbox;
executeClassicScript(SHARED_UTILS_SOURCE, sandbox, {
  filename: "shared-utils.js",
});
executeClassicScript(NUKE_IMPACT_SOURCE, sandbox, {
  filename: "nuke-impact.js",
});
executeClassicScript(NUKE_SUGGESTIONS_SOURCE, sandbox, {
  filename: "nuke-suggestions.js",
});
executeClassicScript(
  "globalThis.__isEnemyNukeSuggestionTarget = isEnemyNukeSuggestionTarget;" +
    "globalThis.__isNukeSuggestionSamOwnerHostileToLauncher = isNukeSuggestionSamOwnerHostileToLauncher;" +
    "globalThis.__collectAllHostileSams = collectAllHostileSams;" +
    "globalThis.__isNukeScoreTileAllowed = isNukeScoreTileAllowed;" +
    "globalThis.__collectAlliedPlayerSmallIds = collectAlliedPlayerSmallIds;" +
    "globalThis.__collectAutoNukeTargetSamScores = collectAutoNukeTargetSamScores;" +
    "globalThis.__launchAutoNukePlan = launchAutoNukePlan;",
  sandbox,
  { filename: "nuke-suggestions-test-exports.js" },
);

// Destruction SAM bonus must be capped by our deliverable ready silo slots:
// an un-overwhelmable stack may not outrank a reachable target.
{
  const collectScores = sandbox.__collectAutoNukeTargetSamScores;
  const targetPlayer = { isPlayer: () => true, smallID: () => 7 };
  const owner = { isPlayer: () => true, smallID: () => 7 };
  const reachableSam = {
    id: () => "reachable",
    level: () => 2,
    tile: () => 100,
    owner: () => owner,
  };
  const fortressSam = {
    id: () => "fortress",
    level: () => 12,
    tile: () => 200,
    owner: () => owner,
  };
  const myPlayer = {
    isPlayer: () => true,
    smallID: () => 1,
    units: (type) =>
      type === "Missile Silo"
        ? [
            {
              level: () => 2,
              missileTimerQueue: () => [],
              isActive: () => true,
              isUnderConstruction: () => false,
            },
            {
              level: () => 1,
              missileTimerQueue: () => [],
              isActive: () => true,
              isUnderConstruction: () => false,
            },
          ]
        : [],
  };
  const baseContext = {
    myPlayer,
    targetPlayer,
    targetSams: [reachableSam, fortressSam],
    pendingTargetSams: [],
  };
  const scoreState = {
    samsByKey: new Map(),
    samUnlockScores: new Map(),
  };
  collectScores({}, baseContext, scoreState);
  assert.equal(
    scoreState.samUnlockScores.get("reachable"),
    3_500_000 * 2,
    "a reachable stack keeps its full capacity bonus",
  );
  assert.equal(
    scoreState.samUnlockScores.get("fortress"),
    3_500_000 * 3,
    "an un-overwhelmable stack is capped by the ready silo slots (3), not its raw level (12)",
  );
}

const suggestionMe = {
  isPlayer: () => true,
  isAlive: () => true,
  smallID: () => 1,
  team: () => "blue",
  isFriendly: () => true,
  isAlliedWith: () => true,
  allies: () => [],
};
const breakableSuggestionAlly = {
  isPlayer: () => true,
  isAlive: () => true,
  smallID: () => 2,
  team: () => null,
  isFriendly: () => true,
  isAlliedWith: () => true,
  units: () => [],
};
const permanentSuggestionTeammate = {
  isPlayer: () => true,
  isAlive: () => true,
  smallID: () => 3,
  team: () => "blue",
  isFriendly: () => true,
  isAlliedWith: () => false,
  units: () => [],
};
const suggestionGame = {
  myPlayer: () => suggestionMe,
  playerViews: () => [suggestionMe, breakableSuggestionAlly, permanentSuggestionTeammate],
  units: () => [],
};
assert.equal(
  sandbox.__isEnemyNukeSuggestionTarget(suggestionGame, breakableSuggestionAlly),
  true,
  "nuke suggestions treat a breakable diplomatic ally as an enemy target",
);
assert.equal(
  sandbox.__isEnemyNukeSuggestionTarget(suggestionGame, permanentSuggestionTeammate),
  false,
  "nuke suggestions do not treat a permanent teammate as an enemy target",
);
assert.equal(
  sandbox.__isNukeSuggestionSamOwnerHostileToLauncher(suggestionMe, breakableSuggestionAlly),
  true,
  "nuke suggestions search a breakable diplomatic ally's SAM as hostile",
);
assert.equal(
  sandbox.__isNukeSuggestionSamOwnerHostileToLauncher(suggestionMe, permanentSuggestionTeammate),
  false,
  "nuke suggestions exclude a permanent teammate's SAM from hostile search",
);
assert.deepEqual(
  Array.from(sandbox.__collectAlliedPlayerSmallIds(suggestionGame, suggestionMe)),
  [3],
  "nuke collateral protection includes only permanent teammates",
);

// A SAM appearing after the first launch invalidates the still-unfired shot.
{
  const world = { samActive: false };
  const changingSam = {
    id: () => "late-sam",
    tile: () => 30,
    owner: () => breakableSuggestionAlly,
    level: () => 1,
  };
  const sourceSilo = { tile: () => 10 };
  const context = {
    myPlayer: suggestionMe,
    targetPlayer: breakableSuggestionAlly,
    readySilos: [sourceSilo],
    targetSams: [],
    pendingTargetSams: [],
    pendingSamReadyTicks: new Map(),
    teamStructures: [],
  };
  const functionNames = [
    "buildNukeSuggestionBaseContext",
    "collectAllHostileSams",
    "collectPendingHostileSams",
    "getNukeSuggestionMagnitude",
    "isNukeScoreTileAllowed",
    "scoreNukeSuggestionTile",
    "findClosestReadySilo",
    "chooseBestNukeRocketDirection",
    "getAutoNukeInterceptionPlan",
    "getAutoNukeBuildableUnit",
    "estimateAutoNukePlanLandingDelayMs",
    "renderAutoNukePlanSteps",
  ];
  const originals = new Map(functionNames.map((name) => [name, sandbox[name]]));
  const originalWindow = sandbox.window;
  const emissions = [];
  Object.assign(sandbox, {
    buildNukeSuggestionBaseContext: () => context,
    collectAllHostileSams: () => (world.samActive ? [changingSam] : []),
    collectPendingHostileSams: () => [],
    getNukeSuggestionMagnitude: () => ({ inner: 1, outer: 2 }),
    isNukeScoreTileAllowed: () => true,
    scoreNukeSuggestionTile: (_game, _scoreContext, tile) => ({ tile, totalScore: 1 }),
    findClosestReadySilo: () => sourceSilo,
    chooseBestNukeRocketDirection: () => ({
      rocketDirectionUp: true,
      interceptingSams: world.samActive ? [changingSam] : [],
    }),
    getAutoNukeInterceptionPlan: () => ({
      shotsNeededBeforeLanding: world.samActive ? 1 : 0,
      shotSamKeys: world.samActive ? [{ key: "late-sam" }] : [],
    }),
    getAutoNukeBuildableUnit: async () => ({ type: "Atom Bomb", canBuild: true }),
    estimateAutoNukePlanLandingDelayMs: () => 0,
    renderAutoNukePlanSteps: () => null,
  });
  sandbox.window = {
    setTimeout: (callback) => {
      callback();
      return 0;
    },
    clearTimeout: () => {},
  };

  const shot = (tile) => ({
    tile,
    sourceTile: 10,
    rocketDirectionUp: true,
    spec: { id: "economic-atom", type: "Atom Bomb", scoreMode: "economic" },
    reason: "impact",
  });
  const plan = { shots: [shot(20), shot(21)], score: 2 };
  const params = {
    game: {},
    selected: breakableSuggestionAlly,
    myPlayer: suggestionMe,
    autoNukePlans: { "economic:default": plan },
    buildMenu: {
      sendBuildOrUpgrade: (_buildable, tile) => {
        emissions.push(tile);
        if (emissions.length === 1) world.samActive = true;
      },
    },
  };
  try {
    const launched = await sandbox.__launchAutoNukePlan(params, plan);
    assert.equal(launched, 1, "only the first shot launches before the new SAM is observed");
    assert.deepEqual(emissions, [20], "the second shot is not emitted through the new SAM");
    assert.equal(plan.stale, true, "the remaining sequential plan is marked stale");
    assert.equal(Object.keys(params.autoNukePlans).length, 0, "the stale cached plan is discarded");
  } finally {
    sandbox.window = originalWindow;
    for (const [name, original] of originals) sandbox[name] = original;
  }
}

const game = {
  ticks: () => 0,
  config: () => ({
    defaultNukeSpeed: () => 1,
    defaultNukeTargetableRange: () => 100,
    defaultSamMissileSpeed: () => 1,
    maxSamRange: () => 100,
    samRange: () => 0.1,
    SAMCooldown: () => 90,
  }),
  x: (tile) => tile,
  y: () => 0,
  ref: (x) => x,
  isValidCoord: () => true,
  euclideanDistSquared: (a, b) => (a - b) ** 2,
  manhattanDist: (a, b) => Math.abs(a - b),
};

assert.equal(
  sandbox.chooseMaxNukeBuildingImpactTile(
    game,
    0,
    [{ tile: 0 }, { tile: 3 }, { tile: 6 }],
    3,
    true,
  ),
  1,
  "blast optimization follows the engine's strict structure-deletion radius boundary",
);

const buildingImpactCandidate = { tile: 1, totalScore: 10 };
const buildingImpactStructures = [{ tile: 1 }, { tile: 2 }, { tile: 3 }];
const buildingImpactCoords = new Map([
  [1, { x: 0, y: 0 }],
  [2, { x: 29, y: 0 }],
  [3, { x: 29, y: 10 }],
]);
const buildingImpactGame = {
  ...game,
  x: (tile) => buildingImpactCoords.get(tile)?.x ?? Number(tile),
  y: (tile) => buildingImpactCoords.get(tile)?.y ?? 0,
  euclideanDistSquared: (a, b) => {
    const from = buildingImpactCoords.get(a) ?? { x: Number(a), y: 0 };
    const to = buildingImpactCoords.get(b) ?? { x: Number(b), y: 0 };
    return (from.x - to.x) ** 2 + (from.y - to.y) ** 2;
  },
};
const scoreCalls = [];
sandbox.scoreNukeSuggestionTile = (_game, _context, tile) => {
  scoreCalls.push(tile);
  return { ...buildingImpactCandidate, tile, totalScore: tile === 2 ? 12 : 10 };
};
const optimizedBuildingImpactCandidate = sandbox.optimizeNukeSuggestionCandidateForBuildingImpact(
  buildingImpactGame,
  {
    scoreMode: "economic",
    magnitude: { outer: 30 },
    structures: buildingImpactStructures,
  },
  buildingImpactCandidate,
);
assert.equal(
  optimizedBuildingImpactCandidate.tile,
  2,
  "high-value nuke candidates should move onto the maximum-building-impact tile",
);
assert.deepEqual(
  scoreCalls,
  [2],
  "high-value nuke optimization should rescore the adjusted impact tile",
);
const lowerScoreBuildingImpactCandidate = sandbox.optimizeNukeSuggestionCandidateForBuildingImpact(
  buildingImpactGame,
  {
    scoreMode: "economic",
    magnitude: { outer: 30 },
    structures: buildingImpactStructures,
  },
  { ...buildingImpactCandidate, totalScore: 20 },
);
assert.equal(
  lowerScoreBuildingImpactCandidate.tile,
  1,
  "building-count geometry must not replace a refined target with a lower-score impact",
);

const intermediateBuildingImpactCandidate = { tile: 0, totalScore: 10 };
const intermediateBuildingImpactStructures = [{ tile: 1200 }, { tile: 12 }];
const intermediateBuildingImpactGame = {
  ...game,
  x: (tile) => Math.floor(tile / 100),
  y: (tile) => tile % 100,
  ref: (x, y) => x * 100 + y,
  euclideanDistSquared: (a, b) => {
    const dx = Math.floor(a / 100) - Math.floor(b / 100);
    const dy = (a % 100) - (b % 100);
    return dx ** 2 + dy ** 2;
  },
};
const originalBuildingImpactScore = sandbox.scoreNukeSuggestionTile;
const intermediateScoreCalls = [];
sandbox.scoreNukeSuggestionTile = (_game, _context, tile) => {
  intermediateScoreCalls.push(tile);
  return {
    ...intermediateBuildingImpactCandidate,
    tile,
    totalScore: tile === 606 ? 12 : 10,
  };
};
try {
  const optimizedIntermediateBuildingImpactCandidate =
    sandbox.optimizeNukeSuggestionCandidateForBuildingImpact(
      intermediateBuildingImpactGame,
      {
        scoreMode: "economic",
        magnitude: { outer: 10 },
        structures: intermediateBuildingImpactStructures,
      },
      intermediateBuildingImpactCandidate,
    );
  assert.equal(
    optimizedIntermediateBuildingImpactCandidate.tile,
    606,
    "high-value nuke candidates should consider a midpoint between separated buildings",
  );
  assert.deepEqual(
    intermediateScoreCalls,
    [606],
    "midpoint optimization should rescore the actual shifted impact coordinate",
  );
} finally {
  sandbox.scoreNukeSuggestionTile = originalBuildingImpactScore;
}

function pendingSam(id) {
  return {
    id: () => id,
    tile: () => 2,
    level: () => 1,
    missileTimerQueue: () => [],
    isActive: () => true,
    isUnderConstruction: () => true,
  };
}

const readyAtPass = pendingSam("ready-at-pass");
const readyAtPassResult = sandbox.findInterceptingSams(game, {
  sourceTile: 0,
  targetTile: 4,
  sams: [],
  rocketDirectionUp: true,
  pendingSams: [readyAtPass],
  pendingSamReadyTicks: new Map([["ready-at-pass", 2]]),
});
assert.deepEqual(
  Array.from(readyAtPassResult, (sam) => sam.id()),
  ["ready-at-pass"],
  "a SAM that completes when the missile reaches its influence area must be predicted",
);
const directionPlan = sandbox.chooseBestNukeRocketDirection(game, {
  sourceTile: 0,
  targetTile: 4,
  sams: [],
  pendingSams: [readyAtPass],
  pendingSamReadyTicks: new Map([["ready-at-pass", 2]]),
});
assert.equal(
  directionPlan.interceptingSams.length,
  1,
  "rocket-direction selection must use the pending-SAM trajectory result",
);

const readyTooLate = pendingSam("ready-too-late");
const readyTooLateResult = sandbox.findInterceptingSams(game, {
  sourceTile: 0,
  targetTile: 4,
  sams: [],
  rocketDirectionUp: true,
  pendingSams: [readyTooLate],
  pendingSamReadyTicks: new Map([["ready-too-late", 3]]),
});
assert.deepEqual(
  readyTooLateResult.length,
  0,
  "a SAM that completes after the missile passes its influence area must not be predicted",
);

const stateReadySam = pendingSam("state-ready");
stateReadySam.state = { constructionStartTick: 98 };
const stateReadyGame = {
  ...game,
  ticks: () => 100,
  config: () => ({
    ...game.config(),
    unitInfo: () => ({ constructionDuration: 2 }),
  }),
};
const stateReadyResult = sandbox.findInterceptingSams(stateReadyGame, {
  sourceTile: 0,
  targetTile: 4,
  sams: [],
  rocketDirectionUp: true,
  pendingSams: [stateReadySam],
});
assert.deepEqual(
  Array.from(stateReadyResult, (sam) => sam.id()),
  ["state-ready"],
  "the predictor must use an exposed construction start tick when available",
);

const candidatePipelineFunctions = [
  "getNukeSuggestionMagnitude",
  "buildNukeSuggestionSeeds",
  "scoreNukeSuggestionTile",
  "refineNukeSuggestionCandidate",
  "findClosestReadySilo",
  "getUnitTile",
  "chooseBestNukeRocketDirection",
];
const candidatePipelineOriginals = new Map(
  candidatePipelineFunctions.map((name) => [name, sandbox[name]]),
);
const candidatePipelineScoreCalls = [];
Object.assign(sandbox, {
  getNukeSuggestionMagnitude: () => ({ inner: 10, outer: 30 }),
  buildNukeSuggestionSeeds: () => [1],
  scoreNukeSuggestionTile: (_game, context, tile) => {
    candidatePipelineScoreCalls.push(tile);
    return {
      id: context.spec.id,
      spec: context.spec,
      type: context.spec.type,
      tile,
      x: buildingImpactGame.x(tile),
      y: buildingImpactGame.y(tile),
      magnitude: context.magnitude,
      totalScore: tile === 2 ? 12 : 10,
    };
  },
  refineNukeSuggestionCandidate: (_game, _context, candidate) => candidate,
  findClosestReadySilo: () => ({ id: () => "silo" }),
  getUnitTile: () => 0,
  chooseBestNukeRocketDirection: () => ({
    rocketDirectionUp: true,
    interceptingSams: [],
  }),
});
try {
  const pipelineCandidates = sandbox.computeNukeCandidatesForType(
    buildingImpactGame,
    {
      structures: buildingImpactStructures,
      readySilos: [{}],
      targetSams: [],
      pendingTargetSams: [],
      pendingSamReadyTicks: new Map(),
    },
    {
      id: "destruction-atom",
      type: "Atom Bomb",
      scoreMode: "destruction",
      maxRawSeeds: 1,
      maxRefineSeeds: 1,
    },
    5,
  );
  assert.equal(
    pipelineCandidates[0].tile,
    2,
    "the high-value candidate pipeline should fire the adjusted building-cluster tile",
  );
  assert.equal(
    pipelineCandidates[0].buildingImpactAnchorTile,
    1,
    "the pipeline should retain the original high-value target as the optimization anchor",
  );
  assert.equal(
    candidatePipelineScoreCalls.includes(2),
    true,
    "the pipeline should re-score the adjusted tile before recalculating trajectory",
  );
} finally {
  for (const [name, original] of candidatePipelineOriginals) {
    sandbox[name] = original;
  }
}

let trajectoryOptions = null;
const trajectorySandbox = {
  registerMapOverlayLayer: () => {},
  UniversalPathFinding: {
    Parabola: (_game, options) => {
      trajectoryOptions = options;
      return { findPath: (from, to) => [from, to] };
    },
  },
};
executeClassicScript(
  `${fs.readFileSync(
    path.join(ROOT, "engine/ingame/nuke-trajectory.js"),
    "utf8",
  )}\nglobalThis.computeNukeTrajectoryPath = computeNukeTrajectoryPath;`,
  trajectorySandbox,
  { filename: "nuke-trajectory.vm.js" },
);
assert.deepEqual(
  trajectorySandbox.computeNukeTrajectoryPath(
    { config: () => ({ defaultNukeSpeed: () => 12 }) },
    10,
    20,
  ),
  [10, 20],
  "the trajectory overlay computes a path without an undeclared direction variable",
);
assert.equal(
  trajectoryOptions.directionUp,
  true,
  "the trajectory overlay defaults to the standard upward arc",
);
assert.equal(trajectoryOptions.increment, 12, "the overlay uses the live nuke speed");

const originalNukeSuggestionDocument = sandbox.document;
const originalNukeSuggestionWindow = sandbox.window;
const originalGetPlayerSmallId = sandbox.getPlayerSmallId;
const originalRootSubMenu = () => [];
const radialRootMenu = { subMenu: originalRootSubMenu };
const radialMenuElement = { radialMenu: { rootMenu: radialRootMenu } };
const contextMenuListeners = new Map();
sandbox.runtimeState = {
  autoNukeEnabled: false,
  autoNukePatchTimeout: null,
};
sandbox.document = {
  addEventListener: (type, listener) => contextMenuListeners.set(type, listener),
  removeEventListener: (type) => contextMenuListeners.delete(type),
  getElementById: () => null,
  querySelector: (selector) => (selector === "main-radial-menu" ? radialMenuElement : null),
};
sandbox.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  clearTimeout,
  setTimeout,
};
sandbox.getPlayerSmallId = (player) => player.smallID();
const radialMe = {
  isAlive: () => true,
  isFriendly: () => false,
  isPlayer: () => true,
  smallID: () => 1,
};
const radialEnemy = {
  isAlive: () => true,
  isFriendly: () => false,
  isPlayer: () => true,
  smallID: () => 2,
};
try {
  sandbox.setAutoNukeEnabled(true, false);
  assert.notEqual(
    radialRootMenu.subMenu,
    originalRootSubMenu,
    "enabling Auto Nukes immediately patches the enemy right-click menu",
  );
  const enemyMenuItems = radialRootMenu.subMenu({
    game: { myPlayer: () => radialMe },
    myPlayer: radialMe,
    selected: radialEnemy,
  });
  assert.equal(
    enemyMenuItems.filter((item) => item.id?.startsWith("openfront-helper-auto-nuke-root-")).length,
    4,
    "the enemy right-click menu exposes every Auto Nukes action",
  );
  sandbox.setAutoNukeEnabled(false, false);
  assert.equal(
    radialRootMenu.subMenu,
    originalRootSubMenu,
    "disabling Auto Nukes restores the original right-click menu",
  );
} finally {
  sandbox.setAutoNukeEnabled(false, false);
  sandbox.document = originalNukeSuggestionDocument;
  sandbox.window = originalNukeSuggestionWindow;
  sandbox.getPlayerSmallId = originalGetPlayerSmallId;
}

// Impact tiles are launch targets: the engine rejects nukes on impassable
// terrain (nukeSpawn), so scoring must reject those tiles for both the
// original candidates and the impact-optimized re-score.
{
  const terrainGame = {
    isSpawnImmunityActive: () => false,
    owner: () => null,
    isImpassable: (tile) => tile === 9,
  };
  const scoreContext = {
    myPlayer: suggestionMe,
    magnitude: { inner: 1, outer: 2 },
    teamStructures: [],
  };
  assert.equal(
    sandbox.__isNukeScoreTileAllowed(terrainGame, scoreContext, 5),
    true,
    "normal land tiles stay nuke-suggestion eligible",
  );
  assert.equal(
    sandbox.__isNukeScoreTileAllowed(terrainGame, scoreContext, 9),
    false,
    "impassable terrain cannot be a nuke suggestion impact",
  );
  assert.equal(
    sandbox.__isNukeScoreTileAllowed(
      { isSpawnImmunityActive: () => false, owner: () => null },
      scoreContext,
      5,
    ),
    true,
    "stubs without terrain info keep the previous eligibility",
  );
}

process.stdout.write("nuke suggestion construction tests passed\n");
