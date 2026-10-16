      const otherFactoryStreams = [];
      const factoryUpgradeTargets = [];
      const factoryRouteProfiles = [];
      const cityRouteProfiles = [];
      const globalTrainCount = Math.max(0, Number(trainCount) || 0);
      for (const [cluster, data] of clusterData.entries()) {
        const completedDestinations = data.destinations.filter(
          ({ pending, unit }) =>
            pending !== true && (
              unit?.isUnderConstruction?.() !== true ||
              unit?.hasTrainStation?.() === true
            ),
        );
        const pendingDestinations = data.destinations.filter(
          ({ pending, unit }) =>
            pending === true || (
              unit?.isUnderConstruction?.() === true &&
              unit?.hasTrainStation?.() !== true
            ),
        );
        const futureDestinations = completedDestinations.concat(pendingDestinations);
        // Only stations with a completed TrainStation join the cluster's
        // uniform sampling pool; pending stops never pay until construction.
        const payingDestinations = completedDestinations;
        const pendingStopDelayTicks = Math.max(
          0,
          ...pendingDestinations.map(({ type }) =>
            Number(config?.unitInfo?.(type)?.constructionDuration ?? 0),
          ),
        );
        const poolMean = (
          sourceOwner,
          includeCandidate,
          postAlliance,
          includePending = false,
          atTicks = null,
        ) => {
          const stops = includePending ? futureDestinations : payingDestinations;
          const pool = includeCandidate
            ? stops.concat([{ owner: ownPlayer }])
            : stops;
          const eligible = pool.filter(({ owner }) =>
            sameOwner(sourceOwner, owner) || shimCanTrade(sourceOwner, owner),
          );
          if (eligible.length === 0) return 0;
          const values = eligible.map(({ owner }) => {
            const same = sameOwner(sourceOwner, owner);
            const alliedPair = !same && sourceOwner?.isAlliedWith?.(owner) === true;
            const allianceExpired =
              atTicks !== null &&
              alliedPair &&
              atTicks >= this.legendaryAllianceTicksRemaining(sourceOwner, owner);
            const payoutRelation = alliedPair && (postAlliance || allianceExpired)
              ? "other"
              : relationship(sourceOwner, owner);
            const teamRecipients =
              Number(sameTeam(sourceOwner)) + Number(!same && sameTeam(owner));
            return trainGold(payoutRelation, sourceOwner) * teamRecipients;
          });
          return values.reduce((sum, value) => sum + value, 0) / values.length;
        };
        const alliancePayoutTicks = (sourceOwner) => {
          const expirations = new Set([0]);
          for (const { owner } of futureDestinations.concat([{ owner: ownPlayer }])) {
            if (
              sameOwner(sourceOwner, owner) ||
              sourceOwner?.isAlliedWith?.(owner) !== true
            ) {
              continue;
            }
            const expiresIn = Number(
              this.legendaryAllianceTicksRemaining(sourceOwner, owner),
            );
            if (Number.isFinite(expiresIn) && expiresIn >= 0) {
              expirations.add(expiresIn);
            }
          }
          return [...expirations].sort((left, right) => left - right);
        };
        const sourcePayoutTimeline = (sourceOwner) =>
          alliancePayoutTicks(sourceOwner).map((atTicks) => ({
            atTicks,
            beforeTeamGoldPerSpawn: poolMean(
              sourceOwner,
              false,
              false,
              false,
              atTicks,
            ),
            teamGoldPerStop: poolMean(
              sourceOwner,
              true,
              false,
              false,
              atTicks,
            ),
            beforeTeamGoldAfterPendingPerSpawn: poolMean(
              sourceOwner,
              false,
              false,
              true,
              atTicks,
            ),
            teamGoldAfterPendingPerSpawn: poolMean(
              sourceOwner,
              true,
              false,
              true,
              atTicks,
            ),
          }));
        const sources = [...data.factories.values()].map((source) => {
          const hasPaidRoute = payingDestinations.some(({ owner: destinationOwner }) =>
            sameOwner(source.owner, destinationOwner) ||
            shimCanTrade(source.owner, destinationOwner),
          );
          const pendingRouteDelays = pendingDestinations
            .filter(({ owner: destinationOwner }) =>
              sameOwner(source.owner, destinationOwner) ||
              shimCanTrade(source.owner, destinationOwner),
            )
            .map(({ type }) => Math.max(
              0,
              Number(config?.unitInfo?.(type)?.constructionDuration ?? 0),
            ));
          const routeReadyTicks = hasPaidRoute
            ? 0
            : pendingRouteDelays.length > 0
              ? Math.min(...pendingRouteDelays)
              : Infinity;
          return {
            ownerId: idOf(source.owner),
            isBuilder: sameOwner(source.owner, ownPlayer),
            factoryCount: levelSum(source.owner?.units?.(UNIT.Factory)),
            productiveFactoryLevels: source.productiveFactoryLevels,
            pendingFactoryLevels: source.pendingFactoryLevels,
            factoryConstructionDelayTicks: source.factoryConstructionDelayTicks,
            routeReadyTicks,
            hasPaidRoute,
            beforeTeamGoldPerSpawn: poolMean(source.owner, false, false),
            teamGoldPerStop: poolMean(source.owner, true, false),
            beforePostAllianceTeamGoldPerSpawn:
              poolMean(source.owner, false, true),
            postAllianceTeamGoldPerStop: poolMean(source.owner, true, true),
            beforeTeamGoldAfterPendingPerSpawn:
              poolMean(source.owner, false, false, true),
            teamGoldAfterPendingPerSpawn:
              poolMean(source.owner, true, false, true),
            beforePostAllianceTeamGoldAfterPendingPerSpawn:
              poolMean(source.owner, false, true, true),
            postAllianceTeamGoldAfterPendingPerSpawn:
              poolMean(source.owner, true, true, true),
            payoutTimeline: sourcePayoutTimeline(source.owner),
            eligibleTicks: eligibleTicksFor(source.owner, futureDestinations),
            pendingStopDelayTicks,
          };
        });
        for (const source of sources) {
          if (source.isBuilder || !Number.isFinite(source.routeReadyTicks)) continue;
          otherFactoryStreams.push({
