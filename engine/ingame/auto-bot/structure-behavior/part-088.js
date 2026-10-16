      // (the first build-only descriptor down the value-ranked list) instead of
      // a bare TileRef, folding the src `player.canBuild(type, tile)` check into
      // the probe. src: tile = structureSpawnTile(type); if null → return;
      // canBuild = player.canBuild(type, tile); if false → return;
      // addExecution(ConstructionExecution).
      // A prior bounded sample may have missed a legal economic site.  In that
      // case findEconomicPlacementOrExhaustion keeps an incremental exhaustive
      // scan specifically so the bot can resume it later.  Re-running another
      // 25 random worker probes first on every tick both delays that proof and
      // creates visible Auto-build stalls.  Resume the unchanged scan directly;
      // its fingerprint is invalidated below as soon as territory or structure
      // geometry changes.
      if (
        type === UNIT.Factory &&
        isLegendaryDifficulty() &&
        this.getOrBuildFactoryTradeDestinations().length === 0
      ) {
        return false;
      }
      let buildable = null;
      if (
        !economicType ||
        profiledLegendaryPort ||
        profiledLegendaryFactory ||
        profiledLegendaryCity ||
        !this.hasPendingEconomicPlacementScan(type)
      ) {
        buildable = await this.structureSpawnTile(type, options);
      }
      if (buildable === null) {
        if (
          !economicType ||
          profiledLegendaryPort ||
          profiledLegendaryFactory ||
          profiledLegendaryCity
        ) {
          return null;
        }
        const placement = await this.findEconomicPlacementOrExhaustion(
          type,
          options,
        );
        if (placement.status === "buildable") {
          buildable = placement.buildable;
        } else if (placement.status === "no-space") {
          return this.maybeUpgradeStructure(structures, {
            economicSpaceExhausted: true,
          });
        } else {
          return false;
        }
      }
      return buildable;
    }

    emitStructureBuildable(type, buildable, options = {}) {
      if (!this.structureSpawnEligible(type, options)) return false;
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      return this.emitStructureBuild(
        buildMenu,
        buildable,
        buildable.canBuild,
        tr("🏗️ Build {type}", { type }),
      );
    }

    constructionCostForOptions(type, options = {}) {
      if (options.useActualCost === true) {
        if (
          ECONOMIC_STRUCTURE_TYPES.includes(type) &&
          typeof options.legendaryEconomyCostQuote === "bigint"
        ) {
          return options.legendaryEconomyCostQuote;
        }
        return this.cost(type);
      }
      return this.getConstructionCost(type);
    }

    emitStructureBuild(buildMenu, buildable, tile, action) {
      // BuildMenu intentionally prioritizes canUpgrade whenever a descriptor
      // exposes both operations. A placement probe can legally expose that
      // hybrid state when its requested tile is an existing structure while a
      // nearby snapped construction tile also exists. This method is the final
      // construction-only boundary: never let such a descriptor turn a planned
      // new City/Factory/Port/SAM into an upgrade.
      if (!this.isUsableStructureBuildable(buildable, tile, buildable?.type)) {
        return false;
      }
      if (!sendAutoBotBuildOrUpgrade(buildMenu, buildable, tile, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(action, "build");
      return true;
    }

    structureSpawnEligible(type, options = {}) {
      if (!autoBotBuildAllowed(type)) return false;
      if (
        type === UNIT.SAMLauncher &&
        options.allowPreemptiveSam !== true &&
        !this.hasObservedHostileMissileLaunch()
      ) {
        return false;
      }
      return (
        options.ignoreEconomicReserve === true ||
        !this.shouldReserveEconomicGrowthForOffense(type)
      );
    }

    async structureUpgradeBeforeSpawn(type, structures, options) {
      if (options.forceNewStructure) return null;
      const legendaryEmergency =
        isLegendaryDifficulty() &&
        this.legendaryMissileDefenseNeedsAction(
          this.getMissileDefenseContext(),
        );
      if (legendaryEmergency) return null;
      if (this.getTotalStructureDensity() <= UPGRADE_DENSITY_THRESHOLD) {
        return null;
      }
      if (!this.game.config().unitInfo(type).upgradable) return null;
      if (await this.maybeUpgradeStructure(structures)) return true;
      // Only an in-flight structure should block a new ratio-needed placement.
      return this.hasStructureUnderConstruction(structures) ? false : null;
    }

    hasStructureUnderConstruction(structures) {
      if (!Array.isArray(structures)) return false;
      return structures.some((structure) => {
        {
          return structure?.isUnderConstruction?.() === true;
        }
      });
    }

    // getPerceivedCost — NationStructureBehavior.ts:627.
    getPerceivedCost(type) {
      const realCost = this.cost(type);

      // Productive structures use their real next-build cost. Keep the
      // perceived-cost multiplier for offensive/defensive structures because
      // the explicit silo reserve below still needs to protect the next
      // economic and SAM actions without freezing the whole build planner.
      if (
        state.settings.winFixes &&
        ECONOMIC_STRUCTURE_TYPES.includes(type)
      ) {
        return realCost;
      }

      const saveUpTarget = this.getSaveUpTarget();
      if (saveUpTarget === 0n || this.player.gold() >= saveUpTarget) {
        return realCost;
      }
