
          const samRange = this.game.config().samRange(samLevel);
          const distToSam = Math.sqrt(
            this.game.euclideanDistSquared(tile, sam.unit.tile()),
          );

          // Check if we can outrange this SAM
          if (distToSam > samRange) {
            // Add significant value for destroying a SAM that we can outrange
            tileValue += 100_000 * samLevel;
          }
        }
      }

      // Prefer tiles that are closer to a silo (but preserve structure value).
      // Distance is weighted by tubes that can actually shoot this window —
      // cooling tubes would flatter far targets our ready tubes cannot reach.
      // With no ready tube the ranking is moot, so keep the live unit order.
      const siloTiles = this.rankableSiloTiles(silos);
      const result = closestTwoTiles(this.game, siloTiles, [tile]);
      if (result === null) throw new Error("Missing result");
      const closestSilo = result.x;
      const distanceSquared = this.game.euclideanDistSquared(tile, closestSilo);
      const distanceToClosestSilo = Math.sqrt(distanceSquared);
      const distancePenalty = distanceToClosestSilo * 30;
      const baseTileValue = tileValue;
      tileValue = Math.max(baseTileValue * 0.2, tileValue - distancePenalty); // Keep at least 20% of structure value

      // Don't target near recent targets (see recentStrikePenalty).
      tileValue -= this.recentStrikePenalty(tile, nukeType, survival);

      // Don't blast our own (or a permanent teammate's) structures: the src
      // scorer only rewards enemy value, so without this a border/hydro tile
      // that also erases our silo/SAM/city cluster can win the sweep.
      tileValue -= this.friendlyFirePenalty(tile, magnitude);

      return tileValue;
    }

    // DIVERGENCE (trade cohesion): preserve only revenue we can observe
    // directly — an active own TradeShip/Train whose exposed final target is
    // this paid stop. The API does not expose intermediate train stops.
    // Trade eligibility alone is merely possible traffic, and factories do
    // not pay when a train stops there. The half-value reduction is a coarse
    // relative-scoring heuristic, not an estimate of route gold; payouts vary
    // by distance and train stop count.
    activeTradeDestinationValue(unit, faceValue) {
      const type = unit?.type?.();
      if (type !== UNIT.Port && type !== UNIT.City) return faceValue;
      const unitId = unit?.id?.();
      if (
        unitId === null ||
        unitId === undefined ||
        !this.activeOwnedTradeDestinationIds().has(String(unitId))
      ) {
        return faceValue;
      }
      const owner = unit.owner?.();
      if (
        !owner ||
        typeof this.player?.hasEmbargoAgainst !== "function" ||
        typeof owner.hasEmbargoAgainst !== "function"
      ) {
        return faceValue;
      }
      const mutualTrade =
        !this.player.hasEmbargoAgainst(owner) &&
        !owner.hasEmbargoAgainst(this.player);
      return mutualTrade ? faceValue / 2 : faceValue;
    }

    // Snapshot the bot's in-flight trade destinations once per game tick.
    // PlayerView.units is already tick-cached by gameApi; restricting this
    // pass to our own ships/trains keeps candidate scoring independent of the
    // total lobby's traffic volume.
    activeOwnedTradeDestinationIds() {
      const tick = this.game?.ticks?.();
      if (!Number.isFinite(tick)) return new Set();
      if (tick === this._activeTradeDestinationTick) {
        return this._activeTradeDestinationIds;
      }
      const destinations = new Set();
      if (typeof this.player?.units === "function") {
        for (const carrier of this.player.units(UNIT.TradeShip, UNIT.Train) || []) {
          if (carrier?.isActive?.() !== true) continue;
          const target = carrier?.targetUnit?.();
          const targetType = target?.type?.();
          const targetId = target?.id?.();
          if (
            (targetType === UNIT.Port || targetType === UNIT.City) &&
            targetId !== null &&
            targetId !== undefined
          ) {
            destinations.add(String(targetId));
          }
        }
      }
      this._activeTradeDestinationTick = tick;
      this._activeTradeDestinationIds = destinations;
      return destinations;
    }

    // Don't target near recent targets
    // Legendary divergence: the adaptive tier's nuclear strategy is a
    // sustained bombardment funded by the recurring war chest. The faithful
    // 1M penalty made one strike poison its own cluster until the 600-tick
    // memory expired, capping throughput at roughly one launch per window;
    // a lighter penalty keeps re-strikes on damaged-but-valuable clusters
    // scorable while still preferring fresh ground. Survival bypass: an
    // active invasion must keep re-striking the same cratered aggressor land
    // instead of waiting out the memory window while territory falls.
    recentStrikePenalty(tile, nukeType, survival = false) {
      if (survival === true) return 0;
      const recentPenalty = isLegendaryDifficulty(currentDifficulty())
        ? 250_000
        : 1_000_000;
      return this.recentlySentNukes
        .filter(([_tick, recentTile, recentNukeType]) => {
          const recentInnerRadius = this.game
            .config()
            .nukeMagnitudes(recentNukeType).inner;
          const distSquared = this.game.euclideanDistSquared(tile, recentTile);
          return distSquared <= recentInnerRadius * recentInnerRadius;
        })
        .map((_) => recentPenalty)
        .reduce((prev, cur) => prev + cur, 0);
    }

    // ── sendNuke — NationNukeBehavior.ts:750 (now async; addExecution → build menu)
    // DIVERGENCE G1: the client build intent cannot carry NukeExecution's
    // `waitTicks`. Delayed salvo entries are therefore retained locally and the
    // same intent is emitted on its due game tick by processPendingNukeLaunches.
    // This preserves arrival staggering without blocking the bot or depending
    // on real-time timers, which would drift when game speed changes.
    async sendNuke(tile, nukeType, targetPlayer, waitTicks = 0, salvo = null) {
      const finalLaunchCheck = typeof salvo === "function" ? salvo : null;
      const salvoMetadata = finalLaunchCheck ? null : salvo;
      const delay = Math.max(0, Math.ceil(Number(waitTicks) || 0));
      this.observeHostileNukeThreats();
      if (delay > 0) {
        if (this._hostileNukeThreats?.size > 0) {
          const perceivedCost = await this.getPerceivedNukeCost(nukeType);
          if (
            await this.shouldHoldCounterforceNuke(
              tile,
              nukeType,
              targetPlayer,
              perceivedCost,
            )
          ) {
            return false;
          }
        }
        return this.queueDelayedNukeLaunch(
          tile,
          nukeType,
          targetPlayer,
          delay,
          salvoMetadata,
        );
      }
      return this.sendImmediateNuke(
        tile,
        nukeType,
        targetPlayer,
        salvoMetadata,
        finalLaunchCheck,
      );
    }
