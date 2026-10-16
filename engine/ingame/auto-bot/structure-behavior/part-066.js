      return {
        cityCount: this.legendaryConstructionCityCount(cityCount, cities),
        connectedCities: rail.connectedCities,
        cityRailConnection: rail.cityRailConnection,
        railNeed: rail.railNeed,
        // Misclassified enclosed lakes (Baikal) read hasCoastalTiles=false and
        // see few rail-reachable trade stations. When an ocean trade partner
        // exists, keep Port value at the strategic threshold rather than the
        // waterless floor; without a reachable partner, Port has no trade value.
        tradeNeed:
          hasTradePartner &&
          (hasCoastalTiles || this.hasAnyShoreBorderTile())
            ? Math.max(1.3, rail.tradeNeed)
            : 0.25,
        ...spawnMultipliers,
        hasTradePartner,
        destroyerNeed: Math.min(
          2.5,
          Math.max(0.25, 1 + (enemyWarships - this.player.units(UNIT.Warship).length) / 5),
        ),
        targetPressure: this.legendaryEnemyTargetPressure(),
        defenseGap: this.legendaryConstructionDefenseGap(
          protectableStructures, enemySilos, missileThreat,
        ),
        missileThreat,
        portSurvivability: this.legendaryPortSurvivability(ports, enemyWarships),
        economyHorizonTicks,
        economyInputs,
        enemySilos,
        ownSams: this.ownSamCapacity(),
        ownSilos: ownSiloLevels,
        siloParityTarget,
        siloParityGap,
        samLevelParityTarget,
        samLevelParityGap,
      };
    }

    legendaryEconomyOwnerContext() {
      const config = this.game?.config?.();
      const ownPlayer = this.player;
      const otherOwners = (this.game?.players?.() ?? []).filter(
        (owner) =>
          owner &&
          String(owner?.smallID?.() ?? "") !==
            String(ownPlayer?.smallID?.() ?? "") &&
          owner?.isAlive?.() !== false &&
          shimCanTrade(ownPlayer, owner),
      );
      const owners = [ownPlayer, ...otherOwners];
      const idOf = (owner) => String(owner?.smallID?.() ?? "");
      const sameOwner = (left, right) =>
        idOf(left) !== "" && idOf(left) === idOf(right);
      const sameTeam = (owner) =>
        sameOwner(owner, ownPlayer) || ownPlayer?.isOnSameTeam?.(owner) === true;
      const allied = (owner) =>
        !sameTeam(owner) && ownPlayer?.isAlliedWith?.(owner) === true;
      const relationship = (source, destination) => {
        if (sameOwner(source, destination)) return "self";
        if (source?.isOnSameTeam?.(destination) === true) return "team";
        return source?.isAlliedWith?.(destination) === true ? "ally" : "other";
      };
      // DIVERGENCE: the server-only cumulative stop count is unavailable; use Config's 10-stop rate.
      const trainGold = (relation, source, citiesVisited = 10) => {
        const player = source?.__src ?? source;
        return typeof config?.trainGold === "function" &&
            typeof player?.isLobbyCreator === "function"
          ? Number(config.trainGold(relation, citiesVisited, player))
          : Number(this.trainGoldBase(relation, citiesVisited));
      };
      const allianceTicksRemaining = (owner) =>
        this.legendaryAllianceTicksRemaining(owner, ownPlayer);
      const eligibleTicksFor = (source, destinations) => {
        const expirations = [];
        if (allied(source)) expirations.push(allianceTicksRemaining(source));
        for (const { owner } of destinations) {
          if (allied(owner)) expirations.push(allianceTicksRemaining(owner));
          if (source?.isAlliedWith?.(owner) === true) {
            expirations.push(this.legendaryAllianceTicksRemaining(source, owner));
          }
        }
        return expirations.length > 0 ? Math.min(...expirations) : Infinity;
      };
      const levelOf = (unit) => {
        if (unit?.isUnderConstruction?.() === true) return 1;
        return Math.max(1, Math.floor(Number(unit?.level?.() ?? 1)));
      };
      const levelSum = (units) =>
        (units ?? []).reduce((total, unit) => total + levelOf(unit), 0);
      return {
        config,
        ownPlayer,
        owners,
        otherOwners,
        idOf,
        sameOwner,
        sameTeam,
        allied,
        relationship,
        trainGold,
        allianceTicksRemaining,
        eligibleTicksFor,
        levelOf,
        levelSum,
      };
    }

    legendaryFactorySeedStops(ownerContext = this.legendaryEconomyOwnerContext()) {
      return ownerContext.owners.flatMap((owner) =>
        this.legendaryFactorySeedStopsForOwner(owner, ownerContext),
      );
    }

    legendaryFactorySeedStopsForOwner(owner, ownerContext) {
      const {
        config,
        ownPlayer,
        sameOwner,
        sameTeam,
        allied,
        relationship,
        trainGold,
        allianceTicksRemaining,
      } = ownerContext;
      const ownStop = sameOwner(ownPlayer, owner);
      const teamStop = sameTeam(owner);
      const teamRecipients =
        Number(sameTeam(ownPlayer)) + Number(!ownStop && teamStop);
      const payout =
        trainGold(relationship(ownPlayer, owner), ownPlayer) * teamRecipients;
      const allianceTicksRemainingForStop = allied(owner)
        ? allianceTicksRemaining(owner)
        : Infinity;
      return [UNIT.City, UNIT.Port].flatMap((type) =>
        (owner?.units?.(type) ?? []).flatMap((unit) =>
          this.legendaryFactorySeedStopUnit(unit, type, {
            config,
            payout,
            teamStop,
            allianceTicksRemaining: allianceTicksRemainingForStop,
          }),
        ),
      );
    }

    legendaryFactorySeedStopUnit(unit, type, stopContext) {
      const tile = unit?.tile?.();
      if (
        tile === null ||
        tile === undefined ||
        !this.legendaryFactorySeedStopUnitEligible(unit)
      ) {
        return [];
      }
      const pending = unit?.isUnderConstruction?.() === true;
      const constructionDelayTicks = pending
        ? Math.max(
            0,
            Number(stopContext.config?.unitInfo?.(type)?.constructionDuration ?? 0),
          )
