          const beforePerSpawn = source.beforeTeamGoldPerSpawn === undefined
            ? stopShare(source.teamGoldPerStop)
            : Math.max(0, Number(source.beforeTeamGoldPerSpawn) || 0);
          const afterPerSpawn = Math.max(0, Number(source.teamGoldPerStop ?? 0));
          const beforePostPerSpawn = source.beforePostAllianceTeamGoldPerSpawn === undefined
            ? stopShare(
                source.postAllianceTeamGoldPerStop ?? source.teamGoldPerStop ?? 0,
              )
            : Math.max(0, Number(source.beforePostAllianceTeamGoldPerSpawn) || 0);
          const afterPostPerSpawn = Math.max(
            0,
            Number(source.postAllianceTeamGoldPerStop ?? source.teamGoldPerStop ?? 0),
          );
          const beforeAfterPending = Math.max(
            0,
            Number(source.beforeTeamGoldAfterPendingPerSpawn ?? beforePerSpawn) || 0,
          );
          const afterAfterPending = Math.max(
            0,
            Number(source.teamGoldAfterPendingPerSpawn ?? afterPerSpawn) || 0,
          );
          const beforePostAfterPending = Math.max(
            0,
            Number(
              source.beforePostAllianceTeamGoldAfterPendingPerSpawn ?? beforePostPerSpawn,
            ) || 0,
          );
          const afterPostAfterPending = Math.max(
            0,
            Number(source.postAllianceTeamGoldAfterPendingPerSpawn ?? afterPostPerSpawn) || 0,
          );
          const pendingStopsReadyTicks = Math.max(
            0,
            Number(source.pendingStopDelayTicks ?? 0),
          );
          const rateAt = (levelsAtTick, tick) => levelsAtTick.reduce(
            (sum, level) => sum + projectedTrainRate(
              level,
              factoryCount,
              fleetProjection.after.trainCounts,
              tick,
            ),
            0,
          );
          const integrateDelta = (keys, start, end, afterRates, beforeRates, levelsAtTick) => {
            const rate = (tick) => rateAt(levelsAtTick, tick);
            return legendaryIntegrateProjectedPayout(
              source,
              keys.after,
              start,
              end,
              afterRates,
              rate,
            ) - legendaryIntegrateProjectedPayout(
              source,
              keys.before,
              start,
              end,
              beforeRates,
              rate,
            );
          };
          const goldFrom = (levelsAtTick, readyAt) => {
            const candidateReady = Math.max(readyAt, actionReadyTicks);
            const pendingReady = Math.max(readyAt, pendingStopsReadyTicks);
            const beforePendingStops = integrateDelta(
              { after: "teamGoldPerStop", before: "beforeTeamGoldPerSpawn" },
              candidateReady,
              Math.min(horizon, pendingReady),
              { current: afterPerSpawn, post: afterPostPerSpawn },
              { current: beforePerSpawn, post: beforePostPerSpawn },
              levelsAtTick,
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
              levelsAtTick,
            );
            return beforePendingStops + afterPendingStops;
          };
          const sourceReadyTicks = Math.max(
            actionReadyTicks,
            Math.max(0, Number(source.factoryConstructionDelayTicks ?? 0)),
          );
          return total + goldFrom(levels, actionReadyTicks) +
            goldFrom(pendingLevels, sourceReadyTicks);
        }
        const denominator = Math.max(
          1,
          Number(config.trainSpawnRate(factoryCount, trainCount)) || 1,
        );
        const stopShare = (value) => {
          const destinations = Math.max(
            1,
            Math.floor(Number(source.paidStopsAfterBuild ?? 1)),
          );
          return Math.max(0, Number(value) || 0) * (destinations - 1) / destinations;
        };
        const beforePerSpawn = source.beforeTeamGoldPerSpawn === undefined
          ? stopShare(source.teamGoldPerStop)
          : Math.max(0, Number(source.beforeTeamGoldPerSpawn) || 0);
        const afterPerSpawn = Math.max(
          0,
          Number(source.teamGoldPerStop ?? 0),
        );
        const beforePostPerSpawn = source.beforePostAllianceTeamGoldPerSpawn === undefined
          ? stopShare(
              source.postAllianceTeamGoldPerStop ?? source.teamGoldPerStop ?? 0,
            )
          : Math.max(0, Number(source.beforePostAllianceTeamGoldPerSpawn) || 0);
        const afterPostPerSpawn = Math.max(
          0,
          Number(
            source.postAllianceTeamGoldPerStop ?? source.teamGoldPerStop ?? 0,
          ),
        );
        const beforeAfterPending = Math.max(
          0,
          Number(source.beforeTeamGoldAfterPendingPerSpawn ?? beforePerSpawn) || 0,
        );
        const afterAfterPending = Math.max(
          0,
          Number(source.teamGoldAfterPendingPerSpawn ?? afterPerSpawn) || 0,
        );
        const beforePostAfterPending = Math.max(
          0,
          Number(
            source.beforePostAllianceTeamGoldAfterPendingPerSpawn ?? beforePostPerSpawn,
          ) || 0,
        );
        const afterPostAfterPending = Math.max(
          0,
          Number(
            source.postAllianceTeamGoldAfterPendingPerSpawn ?? afterPostPerSpawn,
          ) || 0,
        );
        const pendingStopsReadyTicks = Math.max(
          0,
          Number(source.pendingStopDelayTicks ?? 0),
        );
        const completedProduction = levels.reduce(
          (sum, level) =>
            sum + legendaryExpectedTrainRatePerTick(level, denominator),
          0,
        );
        const pendingProduction = pendingLevels.reduce(
          (sum, level) =>
            sum + legendaryExpectedTrainRatePerTick(level, denominator),
          0,
        );
        const goldFrom = (production, readyAt) => {
          const candidateReady = Math.max(readyAt, actionReadyTicks);
          const pendingReady = Math.max(readyAt, pendingStopsReadyTicks);
