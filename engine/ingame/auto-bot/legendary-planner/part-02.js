  );
  const railNeed = legendaryClamp(context.railNeed ?? 1, 0.25, 2.5);
  const tradeNeed = legendaryClamp(context.tradeNeed ?? 1, 0.25, 2.5);
  const trainSpawnMultiplier = Math.max(
    0,
    legendaryScoreValue(context.trainSpawnMultiplier ?? 1),
  );
  const tradeShipSpawnMultiplier = Math.max(
    0,
    legendaryScoreValue(context.tradeShipSpawnMultiplier ?? 1),
  );
  const destroyerNeed = legendaryClamp(
    context.destroyerNeed ?? 1,
    0.25,
    2.5,
  );
  const defenseGap = legendaryClamp(context.defenseGap ?? 1, 0.25, 2.5);
  const costFactor = legendaryClamp(context.costFactor ?? 1, 0.25, 1);
  const hasTradePartner = context.hasTradePartner !== false;
  const portSurvivability = legendaryClamp(
    context.portSurvivability ?? 1,
    0.35,
    1,
  );

  let vector;

  switch (type) {
    case "City":
      vector = {
        gold: (base.gold * cityRailConnection) / (1 + connectedCities),
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "Factory":
      vector = {
        gold: base.gold * railNeed * trainSpawnMultiplier,
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "Port":
      vector = {
        gold: hasTradePartner
          ? base.gold * tradeNeed * tradeShipSpawnMultiplier
          : 0,
        troops: base.troops * portSurvivability,
        defense: base.defense * destroyerNeed * portSurvivability,
      };
      break;
    case "Missile Silo":
      vector = {
        gold: base.gold,
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "SAM Launcher":
      vector = {
        gold: base.gold,
        troops: base.troops,
        defense: base.defense * defenseGap,
      };
      break;
    default:
      vector = { ...base };
  }

  return Object.fromEntries(
    LEGENDARY_OBJECTIVE_FIELDS.map((field) => [
      field,
      legendaryScoreValue(vector[field]) * costFactor,
    ]),
  );
}

function legendaryEconomySpawnMultipliers(
  config,
  factoryCount,
  trainCount,
  tradeShipCount,
) {
  // Config returns spawn denominators, so baseline/current is live odds relative
  // to a zero-fleet baseline.
  const ratio = (baseline, current) => {
    const baselineRate = Number(baseline);
    const currentRate = Number(current);
    return Number.isFinite(baselineRate) && baselineRate > 0 &&
        Number.isFinite(currentRate) && currentRate > 0
      ? baselineRate / currentRate
      : 1;
  };
  const factories = Math.max(0, Math.floor(legendaryScoreValue(factoryCount)));
  const trains = Math.max(0, Math.floor(legendaryScoreValue(trainCount)));
  const tradeShips = Math.max(0, Math.floor(legendaryScoreValue(tradeShipCount)));

  return {
    trainSpawnMultiplier:
      typeof config?.trainSpawnRate === "function"
        ? ratio(
            config.trainSpawnRate(factories + 1, 0),
            config.trainSpawnRate(factories + 1, trains),
          )
        : 1,
    // DIVERGENCE: the client cannot read PortExecution's private rejection
    // counter, so compare fresh-attempt odds from the live Config function.
    tradeShipSpawnMultiplier:
      typeof config?.tradeShipSpawnRate === "function"
        ? ratio(
            config.tradeShipSpawnRate(0, 0),
            config.tradeShipSpawnRate(0, tradeShips),
          )
        : 1,
  };
}

// Marginal expected-gold policy inputs. The engine pays trains at City/Port
// stops (Factory stops pay nothing), so an economic candidate is only as
// productive as the paid route it unlocks; saturation and the match timer are
// read live from Config instead of being hardcoded ROI constants.
function legendaryDoomsdayHorizonTicks(
  matchHorizonTicks,
  gameConfig,
  millisecondsPerTick,
  player,
) {
  const rotDeathSeconds = Number(gameConfig?.rotDeathSeconds);
  if (
    player?.inDoomsdayClock?.() !== true ||
    !Number.isFinite(rotDeathSeconds) ||
    rotDeathSeconds <= 0 ||
    typeof player?.doomsdayClockTicks !== "function"
  ) {
    return matchHorizonTicks;
  }
  // DIVERGENCE: the clock is a deterministic loss deadline; no general combat defeat ETA is exposed.
  const remainingDoomsdayTicks = Math.floor(
    (rotDeathSeconds * 1_000) / millisecondsPerTick -
      Math.max(0, Number(player.doomsdayClockTicks()) || 0),
  );
  return Math.min(matchHorizonTicks, Math.max(0, remainingDoomsdayTicks));
}

function legendaryStructureHorizonTicks(game, tick, player) {
  const config = game?.config?.();
  const gameConfig = config?.gameConfig?.();
  const timerMinutes = Number(gameConfig?.maxTimerValue);
  const millisecondsPerTick = Math.max(
    1,
    Number(config?.msPerTick?.() ?? 100),
  );
  // Client GameView exposes ticksSinceStart() (GameView.ts:1171-1177), which
  // already subtracts the spawn-phase startTick the raw tick includes. Fixtures
  // without that method keep the raw tick (equivalent for tick 0 fixtures).
  const currentTick = Math.max(
    0,
    typeof game?.ticksSinceStart === "function"
