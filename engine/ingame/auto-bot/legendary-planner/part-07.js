        trains = Math.max(0, trains - trainArrivals[tick]);
      }
      if (includeTradeShips && tick > 0) {
        tradeShips = Math.max(0, tradeShips - tradeShipArrivals[tick]);
      }
      if (includeTrains) trainCounts[tick] = trains;
      if (includeTradeShips) tradeShipCounts[tick] = tradeShips;
      if (tick === ticks) break;
      if (includeTrains) {
        refreshTrainRates(trains);
        const trainStockFraction = trains - Math.floor(trains);
        let trainBirths = 0;
        for (const factory of trainProducers) {
          if (tick >= factory.readyAtTicks) {
            const rateIndex = includeCandidate &&
                candidate?.factoryCountReadyAt !== undefined &&
                factory.isBuilder && tick >= candidate.factoryCountReadyAt
              ? factory.addedRateIndex
              : factory.baseRateIndex;
            const lowerRate = trainRateLower[rateIndex];
            trainBirths += factory.count * (
              lowerRate + trainStockFraction * (trainRateUpper[rateIndex] - lowerRate)
            );
          }
        }
        if (
          includeCandidate &&
          candidate?.factoryReadyAt !== undefined &&
          hasBuilderTrainOwner &&
          tick >= candidate.factoryReadyAt
        ) {
          const rateOffset = includeCandidate &&
              candidate.factoryCountReadyAt !== undefined &&
              tick >= candidate.factoryCountReadyAt
            ? candidateFactoryRateIndices.added - candidateFactoryRateIndices.base
            : 0;
          if (candidateUpgradeRateIndices) {
            const beforeIndex = candidateUpgradeRateIndices.before + rateOffset;
            const afterIndex = candidateUpgradeRateIndices.after + rateOffset;
            const beforeLower = trainRateLower[beforeIndex];
            const beforeUpper = trainRateUpper[beforeIndex];
            const afterLower = trainRateLower[afterIndex];
            const afterUpper = trainRateUpper[afterIndex];
            trainBirths += Math.max(
              0,
              afterLower + trainStockFraction * (afterUpper - afterLower) -
                beforeLower - trainStockFraction * (beforeUpper - beforeLower),
            );
          } else {
            const rateIndex = candidateFactoryRateIndex + rateOffset;
            const lowerRate = trainRateLower[rateIndex];
            trainBirths += lowerRate + trainStockFraction * (
              trainRateUpper[rateIndex] - lowerRate
            );
          }
        }
        if (
          includeCandidate &&
          candidate?.factoryReadyAt !== undefined &&
          !hasBuilderTrainOwner &&
          tick >= candidate.factoryReadyAt
        ) {
          const rateOffset = candidate.factoryCountReadyAt !== undefined &&
              tick >= candidate.factoryCountReadyAt
            ? candidateFactoryRateIndices.added - candidateFactoryRateIndices.base
            : 0;
          if (candidateUpgradeRateIndices) {
            const beforeIndex = candidateUpgradeRateIndices.before + rateOffset;
            const afterIndex = candidateUpgradeRateIndices.after + rateOffset;
            const beforeLower = trainRateLower[beforeIndex];
            const beforeUpper = trainRateUpper[beforeIndex];
            const afterLower = trainRateLower[afterIndex];
            const afterUpper = trainRateUpper[afterIndex];
            trainBirths += Math.max(
              0,
              afterLower + trainStockFraction * (afterUpper - afterLower) -
                beforeLower - trainStockFraction * (beforeUpper - beforeLower),
            );
          } else {
            const rateIndex = candidateFactoryRateIndex + rateOffset;
            const lowerRate = trainRateLower[rateIndex];
            trainBirths += lowerRate + trainStockFraction * (
              trainRateUpper[rateIndex] - lowerRate
            );
          }
        }
        const trainUnitsBorn = trainBirths * LEGENDARY_TRAIN_UNITS_PER_CONSIST;
        trains += trainUnitsBorn;
        if (trainArrivals !== null && trainBirths > 0) {
          const arrivalTick = tick + trainLifetime;
          if (arrivalTick <= ticks) trainArrivals[arrivalTick] += trainUnitsBorn;
        }
      }

      if (includeTradeShips) {
        refreshTradeRates(tradeShips);
        const tradeShipStockFraction = tradeShips - Math.floor(tradeShips);
        for (const level of tradeRateLevels) {
          const lowerRate = tradeRateLower[level];
          const rate = lowerRate + tradeShipStockFraction * (
            tradeRateUpper[level] - lowerRate
          );
          tradeRateAtLevel[level] = rate;
          const prefix = tradeRatePrefixes.get(level);
          prefix[tick + 1] = prefix[tick] + rate;
        }
        let tradeShipBirths = 0;
        for (const port of normalizedTradeProducerCohorts) {
          if (tick >= port.readyAtTicks) {
            const birthsPerPort = tradeRateAtLevel[port.level];
            tradeShipBirths += birthsPerPort * port.count;
            scheduleTradeShipArrivals(birthsPerPort, port.routes, tick);
          }
        }
        if (
          includeCandidate &&
          candidate?.portReadyAt !== undefined &&
          tick >= candidate.portReadyAt
        ) {
          const candidateBirths = Number.isFinite(candidateUpgradeLevel) &&
              candidateUpgradeLevel > 0
            ? Math.max(
                0,
                tradeRateAtLevel[Math.floor(candidateUpgradeLevel + 1)] -
                  tradeRateAtLevel[Math.floor(candidateUpgradeLevel)],
              )
            : tradeRateAtLevel[1];
          tradeShipBirths += candidateBirths;
          scheduleTradeShipArrivals(candidateBirths, candidatePortRoutes, tick);
        }
        tradeShips += tradeShipBirths;
      }
    }
    if (tradeShipCounts !== null && tradeRatePrefixes.size > 0) {
      rateCaches.tradePrefixes.set(tradeShipCounts, tradeRatePrefixes);
    }
    return { trainCounts, tradeShipCounts };
  };
  const baselineKey = [
    ticks,
    Number(inputs.trainCount) || 0,
    Number(inputs.tradeShipCount) || 0,
    trainLifetime,
  ].join(":");
  let before = rateCaches.baseline.get(baselineKey);
  if (!before) {
    before = project(false);
    rateCaches.baseline.set(baselineKey, before);
  }
  const hasCandidateProducer = candidate?.factoryReadyAt !== undefined ||
    candidate?.portReadyAt !== undefined;
  let after = before;
  if (hasCandidateProducer) {
    const routeKey = (candidate.portRoutes ?? []).map((route) =>
      `${Number(route?.weight)}:${Number(route?.distance)}`,
    ).join(",");
    const inboundRouteKey = (candidate.portInboundSources ?? []).map((source) =>
