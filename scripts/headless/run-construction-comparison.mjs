import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(directory, "../..");
const matrixRunner = path.join(directory, "run-construction-matrix.mjs");
const comparisonSeed = process.env.OFH_COMPARISON_SEED ?? "construction-comparison-v1";
const baselineBundle = process.env.OFH_BASELINE_BUNDLE;
const candidateBundle = process.env.OFH_CANDIDATE_BUNDLE;
if (!baselineBundle || !candidateBundle) {
  throw new Error("OFH_BASELINE_BUNDLE and OFH_CANDIDATE_BUNDLE are required");
}
const outputRoot = path.resolve(
  projectRoot,
  process.env.OFH_COMPARISON_OUTPUT_DIR ??
    path.join(".artifacts", "construction-comparisons", comparisonSeed),
);
await mkdir(outputRoot, { recursive: true });

function runVariant(name, bundle) {
  return new Promise((resolve) => {
    const outputDirectory = path.join(outputRoot, name);
    const child = spawn(process.execPath, [matrixRunner], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OFH_BUNDLE_PATH: path.resolve(projectRoot, bundle),
        OFH_CAMPAIGN_SEED: comparisonSeed,
        OFH_MATRIX_OUTPUT_DIR: outputDirectory,
      },
      stdio: "inherit",
    });
    child.on("close", (code, signal) => resolve({ code, signal, outputDirectory }));
  });
}

const baselineRun = await runVariant("baseline", baselineBundle);
const candidateRun = await runVariant("candidate", candidateBundle);
if (baselineRun.code !== 0 || candidateRun.code !== 0) {
  throw new Error(
    `Construction comparison failed: baseline=${baselineRun.code}, candidate=${candidateRun.code}`,
  );
}
const baseline = JSON.parse(
  await readFile(path.join(baselineRun.outputDirectory, "matrix.json"), "utf8"),
);
const candidate = JSON.parse(
  await readFile(path.join(candidateRun.outputDirectory, "matrix.json"), "utf8"),
);

const finalTiles = (result) => result?.finalBotState?.tiles ?? 0;
const finalGold = (result) => Number(result?.finalBotState?.gold ?? 0);
const constructionActionCount = (result, action, unit = null) =>
  (result?.constructionEvents ?? []).filter(
    (event) => event.action === action && (unit === null || event.unit === unit),
  ).length;
const survived = (result) => finalTiles(result) > 0;
const recoveredComeback = (result) => result?.strategicTrajectory?.comebackRecovered === true;
const reachedCloseout = (result) => result?.strategicTrajectory?.closeoutReached === true;
const deepestDrawdown = (result) => Number(result?.strategicTrajectory?.deepestDrawdownRatio ?? 1);
const aggregate = (games) => {
  const sum = (value) => games.reduce((total, game) => total + value(game), 0);
  const count = games.length;
  return {
    matches: count,
    wins: sum((game) => (game?.won === true ? 1 : 0)),
    survived: sum((game) => (survived(game) ? 1 : 0)),
    comebackRecoveries: sum((game) => (recoveredComeback(game) ? 1 : 0)),
    closeouts: sum((game) => (reachedCloseout(game) ? 1 : 0)),
    averageDeepestDrawdownRatio:
      count === 0 ? null : Number((sum((game) => deepestDrawdown(game)) / count).toFixed(4)),
    averageTiles: count === 0 ? null : Math.round(sum(finalTiles) / count),
    averageGold: count === 0 ? null : Math.round(sum(finalGold) / count),
    averageRuntimeMs: count === 0 ? null : Math.round(sum((game) => game?.runtimeMs ?? 0) / count),
    constructionActions: {
      builds: sum((game) => constructionActionCount(game, "build")),
      upgrades: sum((game) => constructionActionCount(game, "upgrade")),
    },
    builds: Object.fromEntries(
      ["City", "Factory", "Port", "Defense Post", "SAM Launcher", "Missile Silo", "Warship"].map(
        (unit) => [unit, sum((game) => constructionActionCount(game, "build", unit))],
      ),
    ),
    upgrades: Object.fromEntries(
      ["City", "Factory", "Port", "Defense Post", "SAM Launcher", "Missile Silo"].map((unit) => [
        unit,
        sum((game) => constructionActionCount(game, "upgrade", unit)),
      ]),
    ),
  };
};
const numericDelta = (candidateValue, baselineValue) =>
  candidateValue === null || baselineValue === null ? null : candidateValue - baselineValue;

const baselineByScenario = new Map(baseline.results.map((entry) => [entry.scenario.id, entry]));
const scenarios = candidate.results.map((candidateEntry) => {
  const baselineEntry = baselineByScenario.get(candidateEntry.scenario.id);
  if (!baselineEntry) {
    throw new Error(`Baseline is missing scenario ${candidateEntry.scenario.id}`);
  }
  const baselineGames = baselineEntry.result.results.map((entry) => entry.result);
  const candidateGames = candidateEntry.result.results.map((entry) => entry.result);
  if (baselineGames.length !== candidateGames.length) {
    throw new Error(`Unpaired result count for ${candidateEntry.scenario.id}`);
  }
  const pairs = candidateGames.map((candidateGame, index) => {
    const baselineGame = baselineGames[index];
    return {
      index,
      baselineSeed: baselineGame?.seed ?? null,
      candidateSeed: candidateGame?.seed ?? null,
      delta: {
        won: Number(candidateGame?.won === true) - Number(baselineGame?.won === true),
        survived: Number(survived(candidateGame)) - Number(survived(baselineGame)),
        comebackRecovered:
          Number(recoveredComeback(candidateGame)) - Number(recoveredComeback(baselineGame)),
        closeoutReached:
          Number(reachedCloseout(candidateGame)) - Number(reachedCloseout(baselineGame)),
        deepestDrawdownRatio: Number(
          (deepestDrawdown(candidateGame) - deepestDrawdown(baselineGame)).toFixed(4),
        ),
        tiles: finalTiles(candidateGame) - finalTiles(baselineGame),
        gold: finalGold(candidateGame) - finalGold(baselineGame),
        defensePosts:
          constructionActionCount(candidateGame, "build", "Defense Post") -
          constructionActionCount(baselineGame, "build", "Defense Post"),
        upgrades:
          constructionActionCount(candidateGame, "upgrade") -
          constructionActionCount(baselineGame, "upgrade"),
      },
    };
  });
  const baselineAggregate = aggregate(baselineGames);
  const candidateAggregate = aggregate(candidateGames);
  return {
    id: candidateEntry.scenario.id,
    role: candidateEntry.scenario.role,
    baseline: baselineAggregate,
    candidate: candidateAggregate,
    delta: {
      wins: candidateAggregate.wins - baselineAggregate.wins,
      survived: candidateAggregate.survived - baselineAggregate.survived,
      comebackRecoveries:
        candidateAggregate.comebackRecoveries - baselineAggregate.comebackRecoveries,
      closeouts: candidateAggregate.closeouts - baselineAggregate.closeouts,
      averageDeepestDrawdownRatio: numericDelta(
        candidateAggregate.averageDeepestDrawdownRatio,
        baselineAggregate.averageDeepestDrawdownRatio,
      ),
      averageTiles: numericDelta(candidateAggregate.averageTiles, baselineAggregate.averageTiles),
      averageGold: numericDelta(candidateAggregate.averageGold, baselineAggregate.averageGold),
      averageRuntimeMs: numericDelta(
        candidateAggregate.averageRuntimeMs,
        baselineAggregate.averageRuntimeMs,
      ),
      constructionActions: {
        builds:
          candidateAggregate.constructionActions.builds -
          baselineAggregate.constructionActions.builds,
        upgrades:
          candidateAggregate.constructionActions.upgrades -
          baselineAggregate.constructionActions.upgrades,
      },
      builds: Object.fromEntries(
        Object.keys(candidateAggregate.builds).map((unit) => [
          unit,
          candidateAggregate.builds[unit] - baselineAggregate.builds[unit],
        ]),
      ),
      upgrades: Object.fromEntries(
        Object.keys(candidateAggregate.upgrades).map((unit) => [
          unit,
          candidateAggregate.upgrades[unit] - baselineAggregate.upgrades[unit],
        ]),
      ),
    },
    pairs,
  };
});
const comparison = {
  comparisonSeed,
  baselineBundle: path.resolve(projectRoot, baselineBundle),
  candidateBundle: path.resolve(projectRoot, candidateBundle),
  scenarios,
};
await writeFile(
  path.join(outputRoot, "comparison.json"),
  `${JSON.stringify(comparison, null, 2)}\n`,
  { flag: "wx" },
);
process.stdout.write(`${JSON.stringify(comparison)}\n`);
