          targets.map(({ unit }) => unit),
          type,
          {
            concurrency: STRUCTURE_PROBE_CONCURRENCY,
            timeoutMs: STRUCTURE_PROBE_TIMEOUT_MS,
          },
        );
        for (let index = 0; index < targets.length; index++) {
          const { entry, unit } = targets[index];
          const buildable = buildables[index];
          const cost = this.legendaryCityUpgradeBuildableCost(buildable);
          if (cost <= 0n) continue;
          const evaluationInputs = { ...inputs, upgradeAction: true };
          if (type === UNIT.Factory) evaluationInputs.factoryUpgrade = entry;
          if (type === UNIT.Port) {
            evaluationInputs.upgradeStructureId = unit.id();
            evaluationInputs.portUpgradeLevel = Math.max(
              1,
              Math.floor(Number(unit.level?.() ?? 1)),
            );
            evaluationInputs.portUpgradeProfile =
              inputs?.portUpgradeProfiles?.[String(unit.id())];
          }
          const evaluation = legendaryEconomyNetGold(type, {
            cost: Number(cost),
            horizonTicks: strategicState.economyHorizonTicks,
            inputs: evaluationInputs,
            config,
          });
          if (!evaluation || evaluation.refused === true || evaluation.netTeamGold <= 0) {
            continue;
          }
          candidates.push({
            type,
            action: "upgrade",
            upgradeStructureId: unit.id(),
            upgradeCost: cost,
            netTeamGold: BigInt(Math.round(evaluation.netTeamGold)),
            mandatory: 0,
            safety: 0,
            capacity: 0,
            strategic: 0,
            deficit: 0,
            efficiency: 1,
          });
        }
      }
      if (tick !== null) {
        this._legendaryThroughputUpgradeProbeTick = tick;
        this._legendaryThroughputUpgradeProbe = candidates;
      }
      return candidates;
    }

    async maybeUpgradeLegendaryThroughput(candidate) {
      const type = candidate?.type;
      if (type !== UNIT.Factory && type !== UNIT.Port) return false;
      const targetId = String(candidate?.upgradeStructureId ?? "");
      const target = (this.player?.units?.(type) ?? []).find(
        (unit) => String(unit?.id?.()) === targetId,
      );
      if (!target || target.isUnderConstruction?.() === true) return false;
      const initialState = this.legendaryConstructionState({
        cityCount: (this.player.units(UNIT.City) ?? []).length,
        hasCoastalTiles: this.hasAnyShoreBorderTile(),
      });
      const initialInputs = initialState.economyInputs;
      const initiallyProductive = type === UNIT.Factory
        ? initialInputs.factoryUpgradeTargets.some(
            (entry) => String(entry.structureId) === targetId,
          )
        : initialInputs.portUpgradeTargetIds.some(
            (structureId) => String(structureId) === targetId,
          );
      if (!initiallyProductive) return false;
      const buildables = await this.buildableForUnits([target], type, {
        concurrency: 1,
        timeoutMs: STRUCTURE_PROBE_TIMEOUT_MS,
      });
      const buildable = buildables[0];
      if (!buildable || buildable.canUpgrade === false) return false;
      const currentTarget = (this.player?.units?.(type) ?? []).find(
        (unit) => String(unit?.id?.()) === targetId,
      );
      if (!currentTarget || currentTarget.isUnderConstruction?.() === true) return false;
      const strategicState = this.legendaryConstructionState({
        cityCount: (this.player?.units?.(UNIT.City) ?? []).length,
        hasCoastalTiles: this.hasAnyShoreBorderTile(),
      });
      const current = strategicState?.economyInputs;
      const stillProductive = type === UNIT.Factory
        ? current?.factoryUpgradeTargets?.some(
            (entry) => String(entry.structureId) === targetId,
          )
        : current?.portUpgradeTargetIds?.some(
            (structureId) => String(structureId) === targetId,
          );
      if (!stillProductive) return false;
      const cost = this.buildableCostOrFallback(
        buildable,
        legendaryBigInt(candidate.upgradeCost),
      );
      if (cost <= 0n || cost > this.availableGoldAfterReserve(type, { includeSam: true })) {
        return false;
      }
      const evaluationInputs = {
        ...current,
        upgradeAction: true,
        upgradeStructureId: currentTarget.id(),
      };
      if (type === UNIT.Factory) {
        evaluationInputs.factoryUpgrade = current.factoryUpgradeTargets.find(
          (entry) => String(entry.structureId) === String(currentTarget.id()),
        );
      } else {
        evaluationInputs.portUpgradeLevel = Math.max(
          1,
          Math.floor(Number(currentTarget.level?.() ?? 1)),
        );
        evaluationInputs.portUpgradeProfile =
          current.portUpgradeProfiles?.[String(currentTarget.id())];
      }
      const evaluation = legendaryEconomyNetGold(type, {
        cost: Number(cost),
        horizonTicks: strategicState.economyHorizonTicks,
        inputs: evaluationInputs,
        config: this.game?.config?.(),
      });
      if (!evaluation || evaluation.refused === true || evaluation.netTeamGold <= 0) {
        return false;
      }
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") return false;
      if (!sendAutoBotBuildOrUpgrade(buildMenu, buildable, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(tr("⬆️ Upgrade {type}", { type }), "build");
      return true;
    }

    async legendaryConstructionCandidates({
      config,
      citiesDisabled,
      cityCount,
      hasCoastalTiles,
      hasOceanPortTiles,
      missileSilosEnabled,
      nukesEnabled,
    }) {
      const strategicState = this.legendaryConstructionState({
        cityCount,
        hasCoastalTiles,
      });
      const throughputUpgrades = await this.probeLegendaryThroughputUpgradeCandidates(
        strategicState,
      );
      const economyCostQuotes = new Map();
      // PlayerImpl.buildableUnits computes cost without a tile; placement still needs its tile-scoped probe.
      const buildables = await withTimeout(
