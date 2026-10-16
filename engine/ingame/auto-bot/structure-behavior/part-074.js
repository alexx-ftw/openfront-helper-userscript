        const distance = bestWaterDistance;
        const manhattan = Number(this.game?.manhattanDist?.(sourceTile, tile));
        eligible.push({
          owner,
          tile,
          distance,
          manhattan: Number.isFinite(manhattan) ? manhattan : distance,
          waterComponents,
          level: destination?.unit?.isUnderConstruction?.() === true
            ? 1
            : Math.max(1, Math.floor(Number(destination?.unit?.level?.() ?? 1))),
        });
      }
      eligible.sort((left, right) => left.manhattan - right.manhattan);
      if (eligible.length === 0) return null;
      const proximityCount = Math.max(
        0,
        Number(config?.proximityBonusPortsNb?.(eligible.length) ?? 0),
      );
      const routes = eligible.map((destination, index) => {
        const tooClose = destination.manhattan < debuff;
        const closeBonus = !tooClose && index < proximityCount;
        const friendlyBonus =
          !tooClose && sourceOwner?.isFriendly?.(destination.owner) === true;
        const weight = destination.level * (1 + Number(closeBonus) + Number(friendlyBonus));
        const rawSource = sourceOwner?.__src ?? sourceOwner;
        const gold = Number(config.tradeShipGold(destination.distance, rawSource));
        const destinationIsTeam =
          String(destination.owner?.smallID?.() ?? "") === myId ||
          this.player?.isOnSameTeam?.(destination.owner) === true;
        const destinationIsAlly =
          !destinationIsTeam && this.player?.isAlliedWith?.(destination.owner) === true;
        const sourceIsAlly =
          !sourceIsTeam && this.player?.isAlliedWith?.(sourceOwner) === true;
        const allianceTicks = [];
        if (destinationIsAlly) {
          allianceTicks.push(
            this.legendaryAlliancePairTicks(this.player, destination.owner),
          );
        }
        if (sourceIsAlly) {
          allianceTicks.push(
            this.legendaryAlliancePairTicks(this.player, sourceOwner),
          );
        }
        const sameTeamRoute = sourceOwner?.isOnSameTeam?.(destination.owner) === true ||
          sourceIsTeam && destinationIsTeam;
        const friendlyAllianceTicks = sameTeamRoute
          ? Infinity
          : this.legendaryAlliancePairTicks(sourceOwner, destination.owner);
        return {
          weight,
          postAllianceWeight:
            weight - (friendlyBonus && Number.isFinite(friendlyAllianceTicks)
              ? destination.level
              : 0),
          distance: destination.distance,
          teamGoldPerArrival:
            (sourceIsTeam ? gold : 0) + (destinationIsTeam ? gold : 0),
          // TradeShipExecution keeps paying both endpoint owners after an
          // alliance expires (canTrade is embargo-only), so post-alliance
          // gold stays unchanged while the friendly route-selection weight ends.
          postAllianceGoldPerArrival:
            (sourceIsTeam ? gold : 0) + (destinationIsTeam ? gold : 0),
          allianceTicksRemaining: allianceTicks.length > 0
            ? Math.min(...allianceTicks)
            : Infinity,
        };
      });
      const totalWeight = routes.reduce((total, route) => total + route.weight, 0);
      const weighted = (key) =>
        routes.reduce((total, route) => total + route[key] * route.weight, 0) /
        Math.max(1, totalWeight);
      return {
        routes,
        waterComponents: [...new Set(eligible.flatMap(({ waterComponents }) => waterComponents))],
        teamGoldPerArrival: weighted("teamGoldPerArrival"),
        postAllianceGoldPerArrival: weighted("postAllianceGoldPerArrival"),
        routeDelayTicks: weighted("distance"),
      };
    }

    legendaryPortCandidateTilesForEconomy() {
      const tiles = [...new Set(this.oceanPortBorderTiles())];
      const limit = Math.max(1, Number(STRUCTURE_PLACEMENT_CANDIDATE_LIMIT) || 1);
      const sampled = tiles.length <= limit
        ? tiles
        : Array.from({ length: limit }, (_, index) =>
            tiles[Math.floor((index * tiles.length) / limit)],
          );
      return sampled.filter((tile) =>
        this.portTileHasOpenWaterAccess(tile) &&
        this.portCandidateHasTradeRoute(tile),
      );
    }

    // Seed economics follow the same canonical open-ocean placement contract.
    legendaryPortSeedWindowOpen(component) {
      const sharedWater = this.game?.sharedWaterComponents?.(this.player);
      if (!sharedWater || sharedWater.size === 0) return false;
      const ownId = String(this.player?.smallID?.() ?? "");
      const components = component === undefined ? [...sharedWater] : [component];
      return components.some((waterComponent) => {
        if (!sharedWater.has(waterComponent)) return false;
        const ids = this.legendaryPortSeedOwnerIds(waterComponent).map(String);
        if (ids.length !== 2 || !ids.includes(ownId)) return false;
        const partnerId = ids.find((id) => id !== ownId);
        const partner = (this.game?.players?.() ?? []).find(
          (owner) => String(owner?.smallID?.() ?? "") === partnerId,
        );
        if (!partner) return false;
        const ownState = this.portOwnerStateOnWater(this.player, waterComponent);
        const hasCompletedPartner = this.tradeableForeignPortOwners().some(
          (owner) => this.portOwnerStateOnWater(owner, waterComponent).completed,
        );
        return !ownState.completed && !ownState.inProgress && !hasCompletedPartner;
      });
    }

    legendaryPortSeedPartner(component) {
      const ownId = String(this.player?.smallID?.() ?? "");
      const sharedWater = this.game?.sharedWaterComponents?.(this.player);
      const components = component === undefined ? [...(sharedWater ?? [])] : [component];
      for (const waterComponent of components) {
        if (!this.legendaryPortSeedWindowOpen(waterComponent)) continue;
        const ids = this.legendaryPortSeedOwnerIds(waterComponent).map(String);
        if (ids.length !== 2 || !ids.includes(ownId)) continue;
        const partnerId = ids.find((id) => id !== ownId);
        return (this.game?.players?.() ?? []).find(
          (owner) => String(owner?.smallID?.() ?? "") === partnerId,
        ) ?? null;
      }
      return null;
    }

    legendaryCostFactor(cost) {
      const gold = this.player.gold();
      if (gold <= 0n || cost <= 0n) return 1;
      const costShare = Number(cost) / Math.max(1, Number(gold));
      return Math.max(0.25, 1 - Math.min(0.75, costShare * 0.75));
    }

    // The cheapest currently-known City upgrade under troop-cap pressure. The
    // authoritative upgrade cost comes from the buildable-unit probe (never the
    // count-scaled new-structure formula). Prices are cached only within the
    // current snapshot: building/upgrading another City also changes the price.
    legendaryCityUpgradeCandidateInfo() {
      return this._legendaryCityUpgradeProbe ?? null;
    }

    async refreshLegendaryCityUpgradeCandidate() {
      const tick = safeStructureGameTick(this.game);
      if (
        tick !== null &&
        this._legendaryCityUpgradeProbeTick === tick &&
        this._legendaryCityUpgradeProbe !== undefined
      ) {
        return;
      }
      const info = await this.probeLegendaryCityUpgradeCandidate();
