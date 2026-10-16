import assert from "node:assert/strict";
import { readEngineSource } from "./context.mjs";

export function checkWarshipTraversalSource() {
  const safeWaypointSource = readEngineSource("engine/ingame/auto-bot/warshipBehavior.js").match(
    /findSafeWaypoint\(start, baseTarget, enemies\) \{([\s\S]*?)\n {4}\}/,
  )?.[1];
  assert.ok(safeWaypointSource, "safe-waypoint traversal must remain inspectable");
  assert.doesNotMatch(
    safeWaypointSource,
    /\.shift\s*\(/,
    "safe-waypoint BFS must not repeatedly shift its traversal queue",
  );
  assert.match(
    safeWaypointSource,
    /queueHead\s*<\s*queue\.length/,
    "safe-waypoint BFS must consume its queue through a constant-time cursor",
  );
}

export function checkClusterPublisherSource() {
  const clusterPublisherSource = readEngineSource("engine/ingame/auto-bot/attackBehavior.js").match(
    /publishPreferredEarlyGameCluster\(candidates, futureFoodById\) \{([\s\S]*?)\n {4}\}/,
  )?.[1];
  assert.ok(clusterPublisherSource, "early-game cluster publication must remain inspectable");
  assert.doesNotMatch(
    clusterPublisherSource,
    /\.sort\s*\(/,
    "publishing one preferred tribe cluster must not sort every candidate",
  );
  assert.match(
    clusterPublisherSource,
    /for \(const candidate of candidates\)/,
    "preferred tribe cluster selection must remain a single linear scan",
  );
}

export function checkNationTickGuardSource() {
  assert.match(
    readEngineSource("engine/ingame/auto-bot/nationExecution.js"),
    /lastProcessedGameTick/,
    "NationBot must guard duplicate real-time polls for one game tick",
  );
}

export function checkBuildTimerScanInterval() {
  assert.match(
    readEngineSource("engine/ingame/build-timer.js"),
    /scanIntervalMs:\s*1000/,
    "build timers should not rescan every structure more than once per second",
  );
}
