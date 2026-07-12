// Auto-Bot — Early Game policy helpers.
//
// The source Nation AI has no separate Early Game controller. These helpers keep
// the improvement as a small policy layer around the existing attack order:
// claim safe land first, eat reachable tribes next, and only use a boat when an
// exact route ETA proves it is inside the 30-second opening window.

"use strict";

  // OpenFront advances one game tick every 100 ms, so 30 seconds is 300 ticks.
  const EARLY_GAME_MAX_BOAT_TICKS = 300;

  function isEarlyGameBoatEta(etaTicks) {
    return (
      Number.isFinite(etaTicks) &&
      etaTicks >= 0 &&
      etaTicks <= EARLY_GAME_MAX_BOAT_TICKS
    );
  }

  // Transport motion plans include their source tile, therefore movement time is
  // the number of edges, not the number of path entries.
  function transportRouteTicks(path) {
    const route = path && path.fullPath ? path.fullPath : path;
    if (route == null || typeof route.length !== "number" || route.length === 0) {
      return null;
    }
    const length = Number(route.length);
    return Number.isFinite(length) ? Math.max(0, length - 1) : null;
  }

  function isEarlyGameTribeTarget(target) {
    if (!target || target.alive === false || target.friendly === true) return false;
    return target.landBorder === true || isEarlyGameBoatEta(target.boatEtaTicks);
  }

  function createEarlyGameSnapshot(input = {}) {
    const tribes = Array.isArray(input.tribes) ? input.tribes : [];
    const actionableTribes = tribes.filter(isEarlyGameTribeTarget);
    const hasFreeLand = input.hasFreeLand === true;
    const hasTribeTarget = actionableTribes.length > 0;
    const postSpawn = input.postSpawn === true;

    return {
      active: postSpawn && (hasFreeLand || hasTribeTarget),
      postSpawn,
      hasFreeLand,
      hasTribeTarget,
      actionableTribes,
      boatRouteAvailable: input.boatRouteAvailable === true,
    };
  }

  function chooseEarlyGameAction({ landTarget = false, tribeTarget = false, boatTarget = false } = {}) {
    if (landTarget) return "land";
    if (tribeTarget) return "tribe";
    if (boatTarget) return "boat";
    return null;
  }
