// Native facts only. Website constants and interception promises are not inputs.
"use strict";
(function installHybridNativeKnowledge(root) {
  const version = "ofh-native-knowledge-v1";
  const nuclearTypes = new Set(["Atom Bomb", "Hydrogen Bomb", "MIRV"]);

  function fact(context, status, evidence) {
    return { version, sourceTick: context.game?.ticks?.() ?? null, status, evidence };
  }

  function quoteNuclearPurchase(context, type) {
    const config = context.game?.config?.();
    if (!nuclearTypes.has(type) || typeof config?.unitInfo !== "function") return fact(context, "unknown", "native-cost-unavailable");
    if (type === "MIRV" && typeof context.game.mirvsLaunched !== "function") return fact(context, "unknown", "native-counter-unavailable");
    const cost = config.unitInfo(type)?.cost;
    if (typeof cost !== "function" || !context.player) return fact(context, "unknown", "native-cost-unavailable");
    if (!validNativeCostCounters(context, type)) return fact(context, "unknown", "native-counter-unavailable");
    const value = cost(context.game, context.player);
    if (typeof value !== "bigint" || value < 0n) return fact(context, "unknown", "invalid-native-cost");
    return { ...fact(context, "known", "Config.unitInfo(type).cost(game,player)"), type, cost: value, costDecimal: String(value) };
  }

  function validNativeCostCounters(context, type) {
    const player = context.player;
    if (!["type", "unitsOwned", "unitsConstructed"].every(key => typeof player[key] === "function")) return false;
    if (![player.unitsOwned(type), player.unitsConstructed(type)].every(validNativeCount)) return false;
    return type !== "MIRV" || validNativeCount(context.game.mirvsLaunched());
  }

  function validNativeCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function slots(context, unit, type, cooldownName) {
    const config = context.game?.config?.();
    if (!["type", "missileTimerQueue", "level", "id", "isActive", "isUnderConstruction"].every(key => typeof unit?.[key] === "function") || unit.type() !== type
      || typeof config?.[cooldownName] !== "function") return fact(context, "unknown", "native-slots-unavailable");
    const level = unit.level();
    const queue = unit.missileTimerQueue();
    const cooldown = config[cooldownName]();
    const active = unit.isActive();
    const building = unit.isUnderConstruction();
    if (!validSlotState(level, queue) || !validNativeCount(cooldown)
      || typeof active !== "boolean" || typeof building !== "boolean") return fact(context, "unknown", "invalid-native-slots");
    const ready = active && !building;
    return { ...fact(context, "known", "native-level-queue-and-Config-cooldown"), unitId: unit.id(), level,
      queued: queue.length, readySlots: ready ? Math.max(0, level - queue.length) : 0,
      nextReloadTick: queue.length ? queue[0] + cooldown : null, cooldownTicks: cooldown };
  }

  function validSlotState(level, queue) {
    return Number.isSafeInteger(level) && level >= 1 && Array.isArray(queue)
      && queue.every(validNativeCount);
  }

  function describeSilo(context, silo) {
    return slots(context, silo?.__src ?? silo, "Missile Silo", "SiloCooldown");
  }

  function describeSam(context, sam) {
    sam = sam?.__src ?? sam;
    const facts = slots(context, sam, "SAM Launcher", "SAMCooldown");
    const config = context.game?.config?.();
    if (facts.status !== "known" || typeof config?.dynamicSamRange !== "function") return fact(context, "unknown", "native-range-unavailable");
    const range = config.dynamicSamRange(sam, context.game.ticks());
    if (!Number.isFinite(range) || range < 0) return fact(context, "unknown", "invalid-native-range");
    return { ...facts, range, guaranteedInterception: false,
      priorityEvidence: "Native SAM scheduler considers type, distance and arrival urgency; slots/range alone do not guarantee interception." };
  }

  root.__OFH_hybridNativeKnowledge = { version, quoteNuclearPurchase, describeSilo, describeSam };
})(window);
