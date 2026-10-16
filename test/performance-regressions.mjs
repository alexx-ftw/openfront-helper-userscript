import {
  checkBuildTimerScanInterval,
  checkClusterPublisherSource,
  checkNationTickGuardSource,
  checkWarshipTraversalSource,
} from "./helpers/perf-regressions/source-inspections.mjs";
import { checkSharedUtilsUnitCache } from "./helpers/perf-regressions/shared-utils-cache.mjs";
import { setupGameApi } from "./helpers/perf-regressions/game-api-setup.mjs";
import { checkGameApiCacheViews } from "./helpers/perf-regressions/game-api-cache.mjs";
import {
  checkHelperWithTimeout,
  checkPerformanceProfiling,
} from "./helpers/perf-regressions/bot-runtime.mjs";
import {
  checkEngineTimerRetune,
  checkRuntimeSchedulerCadence,
} from "./helpers/perf-regressions/tick-schedulers.mjs";
import {
  checkHeatmapLifecycle,
  checkRoundLoggerLifecycle,
} from "./helpers/perf-regressions/game-loop.mjs";
import {
  checkOverlaySchedulerLifecycle,
  setupOverlayScheduler,
} from "./helpers/perf-regressions/overlay-scheduler.mjs";
import { checkContextMissCache } from "./helpers/perf-regressions/context-cache.mjs";

await checkWarshipTraversalSource();
await checkClusterPublisherSource();
await checkSharedUtilsUnitCache();
const gameApiContext = setupGameApi();
await checkGameApiCacheViews(gameApiContext);
await checkHelperWithTimeout();
await checkNationTickGuardSource();
await checkPerformanceProfiling();
await checkRuntimeSchedulerCadence();
await checkBuildTimerScanInterval();
await checkEngineTimerRetune();
await checkRoundLoggerLifecycle();
await checkHeatmapLifecycle();
const overlayScheduler = setupOverlayScheduler();
checkOverlaySchedulerLifecycle(overlayScheduler);
await checkContextMissCache();

process.stdout.write("performance regression tests passed\n");
