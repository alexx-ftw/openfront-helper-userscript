        tr("⬆️ Upgrade {type}", { type: result.structure.type() }),
        "build",
      );
      return true;
    }

    async finishNukeDemandSiloUpgrade({
      pendingRequest, request, candidates, buildables, minimumCost, reservation,
    }) {
      if (state.nukeWantSlots !== pendingRequest || this.validNukeSiloUpgradeRequest() === null) return false;
      const currentPlanStillMissing = this.samOverwhelmPlanStillMissing(request);
      if (currentPlanStillMissing === false) {
        state.nukeWantSlots = null;
        return false;
      }
      const currentGold = this.availableGoldAfterReserve(UNIT.MissileSilo);
      if (!this.nukeSiloUpgradeBudgetAvailable(currentGold, minimumCost)) return false;
      const currentRoutes = this.routeEligibleSilosForDemand(request);
      if (Array.isArray(currentRoutes)) {
        const currentCandidates = this.nukeDemandSiloUpgradeCandidates(
          request,
          this.nukeDemandScopedSilos(request, currentRoutes),
          currentPlanStillMissing,
        );
        if (currentCandidates === null) return false;
        const probedSiloIds = new Set(candidates.map((silo) => String(silo.id())));
        const unprobed = currentCandidates.filter(
          (silo) => !probedSiloIds.has(String(silo.id())),
        );
        if (unprobed.length > 0) {
          const additionalBuildables = await this.buildableForUnits(
            unprobed,
            UNIT.MissileSilo,
            {
              concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
              timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
            },
          );
          // Routes can change again during this quote; each pass adds only
          // previously unprobed, route-eligible Silos before deciding to spawn.
          return await this.finishNukeDemandSiloUpgrade({
            pendingRequest,
            request,
            candidates: [...candidates, ...unprobed],
            buildables: [...(buildables || []), ...(additionalBuildables || [])],
            minimumCost,
            reservation,
          });
        }
      }
      if (
        currentRoutes !== undefined && currentRoutes !== null &&
        !this.nukeBehavior.hasUsefulSiloUpgradeCapacity(
          this.nukeDemandScopedSilos(request, currentRoutes),
          { totalBombs: request.requiredCapacity },
          currentPlanStillMissing === true,
        )
      ) return this.maybeSpawnNukeDemandSilo(pendingRequest);
      const ranked = this.rankNukeDemandSiloUpgrades({
        candidates,
        buildables,
        availableGold: currentGold,
        minimumCost,
        preferredSiloIds: request.unblockedSiloIds,
      }).filter((candidate) => currentRoutes === undefined || currentRoutes === null ||
        currentRoutes.some((silo) => silo.id() === candidate.silo.id()));
      if (ranked.length === 0) {
        return this.nukeDemandSiloUpgradeFallback(
          pendingRequest,
          candidates,
          buildables,
          currentRoutes,
        );
      }
      const selected = ranked[0];
      const selectedLevel = Number(selected.silo.level?.() ?? 1);
      const upgraded = this.executeStructureUpgradeCandidate(selected, UNIT.MissileSilo);
      if (upgraded && reservation) {
        reservation.siloId = selected.silo.id();
        reservation.level = selectedLevel;
        const rawTick = Number(this.game?.ticks?.());
        const tick = Number.isFinite(rawTick) ? rawTick : null;
        if (tick !== null) reservation.tick = tick;
        reservation.inFlight = false;
      }
      return upgraded;
    }

    nukeDemandSiloUpgradeFallback(pendingRequest, candidates, buildables, currentRoutes) {
      const upgradeProbeUnknown = candidates.some((silo, index) =>
        buildables?.[index] == null &&
        (currentRoutes === undefined || currentRoutes === null ||
          currentRoutes.some((route) => route.id() === silo.id())));
      if (upgradeProbeUnknown) return false;
      // Demand-driven leveling must outrank another level-one silo when a
      // route-eligible upgrade exists but outprices this tick's gold.
      const upgradeStillPossible = candidates.some((silo, index) =>
        buildables[index] &&
        buildables[index].canUpgrade !== false &&
        (currentRoutes === undefined || currentRoutes === null ||
          currentRoutes.some((route) => route.id() === silo.id())));
      if (upgradeStillPossible) return false;
      return this.maybeSpawnNukeDemandSilo(pendingRequest);
    }

    nukeSiloRequestTargetInvalid(request) {
      const targetSam = this.game.units(UNIT.SAMLauncher)
        .find((sam) => sam.id() === request.targetSamId);
      const owner = targetSam?.owner?.();
      return !targetSam || targetSam.isActive?.() === false || !owner ||
        this.nukeSiloRequestOwnerInvalid(owner, request);
    }

    nukeSiloRequestOwnerInvalid(owner, request) {
      const nukeTargetInvalid = this.nukeBehavior &&
        (typeof this.nukeBehavior.isEligibleNukeTarget === "function"
          ? !this.nukeBehavior.isEligibleNukeTarget(owner)
          : !this.nukeBehavior.isValidNukeTarget(owner));
      return owner.smallID() === this.player.smallID() ||
        this.player.isFriendly?.(owner) === true || this.player.isOnSameTeam?.(owner) === true ||
        (this.nukeBehavior && (nukeTargetInvalid ||
          !this.nukeBehavior.isValidNukeDestination(request.targetTile)));
    }

    nukeDemandSiloSpawnTiles(tiles, request) {
      const coveringSams = this.nukeBehavior?.findEnemySamsCoveringTile?.(
        request.targetTile,
      );
      if (
        !Array.isArray(coveringSams) ||
        !coveringSams.some(
          (sam) => String(sam.id()) === String(request.targetSamId),
        )
      ) {
        return [];
      }
      const coveringSamIds = new Set(coveringSams.map((sam) => sam.id()));
      tiles = tiles.filter((tile) =>
        this.nukeDemandSiloRouteClear(tile, request, coveringSamIds),
      );
      return tiles;
    }

    legendaryConstructionCityCount(cityCount, cities) {
      return Math.max(0, Number(cityCount || cities.length));
    }

    legendaryConstructionDefenseGap(protectableStructures, enemySilos, missileThreat) {
      return Math.max(
        this.legendaryDefenseGap(protectableStructures, enemySilos),
        missileThreat.critical ? 1.5 : 0.25,
      );
    }

    economicStructureSpawnPending(economicType, structures) {
      return economicType && this.hasStructureUnderConstruction(structures);
    }

    navalOpeningHasCompletedPort() {
      const ports = this.player?.units?.(UNIT.Port) || [];
