          const integrateDelta = (keys, start, end, afterRates, beforeRates) =>
            legendaryIntegratePayoutTimeline(
              source,
              keys.after,
              start,
              end,
              afterRates,
            ) - legendaryIntegratePayoutTimeline(
              source,
              keys.before,
              start,
              end,
              beforeRates,
            );
          const beforePendingStops = integrateDelta(
            { after: "teamGoldPerStop", before: "beforeTeamGoldPerSpawn" },
            candidateReady,
            Math.min(horizon, pendingReady),
            { current: afterPerSpawn, post: afterPostPerSpawn },
            { current: beforePerSpawn, post: beforePostPerSpawn },
          );
          const afterPendingStops = integrateDelta(
            {
              after: "teamGoldAfterPendingPerSpawn",
              before: "beforeTeamGoldAfterPendingPerSpawn",
            },
            Math.max(candidateReady, pendingReady),
            horizon,
            { current: afterAfterPending, post: afterPostAfterPending },
            { current: beforeAfterPending, post: beforePostAfterPending },
          );
          return production * (beforePendingStops + afterPendingStops);
        };
        const sourceReadyTicks = Math.max(
          actionReadyTicks,
          Math.max(0, Number(source.factoryConstructionDelayTicks ?? 0)),
        );
        return total +
          goldFrom(completedProduction, actionReadyTicks) +
          goldFrom(pendingProduction, sourceReadyTicks);
      }, 0);
      incomePerTick /= productiveTicks;
    }
  } else if (type === "Port") {
    if (typeof config?.tradeShipSpawnRate !== "function") return null;
    if (
      inputs.hasCompletedTradePartner !== true &&
      inputs.portSeedWindowOpen !== true &&
      !(inputs.hasPendingTradePartner === true && portHasRouteProfiles)
    ) {
      // A first Port without any tradeable partner Port on the shared water
      // is a seed, not current trade income; the two-owner seed window is the
      // only no-route exception.
      return { refused: true };
    }
    const tradeShipCount = Math.max(
      0,
      Math.floor(Number(inputs.tradeShipCount ?? 0)),
    );
    const tradeRateAt = (level, countPath, tick) => legendaryExpectedTradeRateAtFleet(
      level,
      legendaryProjectedCountAt(countPath, tick, tradeShipCount),
      config,
      fleetProjection?.tradeRateCache,
    );
    const routeIncome = (
      profile,
      level,
      upgrade = false,
      startDelayTicks = constructionDelayTicks,
      scenario = "after",
    ) => {
      const scenarioPath = scenario === "before"
        ? fleetProjection?.before.tradeShipCounts
        : fleetProjection?.after.tradeShipCounts;
      const ratePath = upgrade
        ? fleetProjection?.after.tradeShipCounts
        : scenarioPath;
      const rateContext = fleetProjection
        ? {
            path: ratePath,
            beforePath: upgrade ? fleetProjection.before.tradeShipCounts : null,
            level,
            upgrade,
            fallback: tradeShipCount,
            config,
            rateCache: fleetProjection.tradeRateCache,
            prefixCache: fleetProjection.tradeRatePrefixes,
            deltaPrefixCache: fleetProjection.tradeRateDeltaPrefixes,
            prefix: null,
          }
        : null;
      const rateRangeSum = rateContext
        ? legendaryProjectedTradeRateRangeSum.bind(null, rateContext)
        : null;
      return legendaryPortExpectedGold(profile, {
        level,
        upgrade,
        tradeShipCount,
        config,
        fallbackDistance: inputs.portRouteDelayTicks ?? 0,
        startDelayTicks,
        horizon,
        rateRangeSum,
        ...(fleetProjection
          ? {
              rateAtTick: (tick) => upgrade
                ? Math.max(
                    0,
                    tradeRateAt(
                      level + 1,
                      fleetProjection.after.tradeShipCounts,
                      tick,
                    ) - tradeRateAt(
                      level,
                      fleetProjection.before.tradeShipCounts,
                      tick,
                    ),
                  )
                : tradeRateAt(level, scenarioPath, tick),
            }
          : {}),
      });
    };
    const incomingRouteIncome = (profile) =>
      (profile?.inboundSources ?? []).reduce((total, source) => {
        // A completed source Port already dispatches to a destination that is
        // still under construction (PortExecution.tradingPorts does not check
        // construction), so inbound value starts at the source's own delay.
        const sourceDelay = Math.max(
          0,
          Math.floor(Number(source.constructionDelayTicks) || 0),
        );
        const level = Math.max(1, Math.floor(Number(source.level) || 1));
        return total +
          routeIncome(source.afterProfile, level, false, sourceDelay, "after") -
          routeIncome(source.beforeProfile, level, false, sourceDelay, "before");
      }, 0);
    const candidatePortIncome = (profile) =>
      routeIncome(profile, 1) + incomingRouteIncome(profile);
    const selectPortCandidate = (profiles) => {
      const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
      const ranked = profiles.map((profile) => ({
        profile,
        gold: candidatePortIncome(profile),
        signature: legendaryPortCandidateProjectionSignature(profile),
      })).sort((left, right) => {
        if (left.gold !== right.gold) return right.gold > left.gold ? 1 : -1;
        return compareText(left.signature, right.signature) ||
          compareText(String(left.profile?.placementTile ?? ""), String(right.profile?.placementTile ?? ""));
      });
      const finalists = [];
      const seenSignatures = new Set();
      for (const candidate of ranked) {
        if (seenSignatures.has(candidate.signature)) continue;
        seenSignatures.add(candidate.signature);
        finalists.push(candidate);
      }
