            ? await this.maybeUpgradeLegendaryCityCapacity(candidate)
            : await this.maybeUpgradeLegendaryThroughput(candidate);
          if (upgraded) {
            return "built";
          }
          continue;
        }
        if (candidate.type === UNIT.Port) {
          if (
            candidate.portPlacementTile === null ||
            candidate.portPlacementTile === undefined
          ) {
            continue;
          }
          if (
            await this.maybeSpawnStructure(UNIT.Port, {
              useActualCost: true,
              legendaryEconomyCostQuote: candidate.cost,
              legendaryEconomyPortTile: candidate.portPlacementTile,
            })
          ) {
            return "built";
          }
          continue;
        }
        if (candidate.type === UNIT.Factory) {
          if (
            candidate.factoryPlacementTile === null ||
            candidate.factoryPlacementTile === undefined
          ) {
            continue;
          }
          if (
            await this.maybeSpawnStructure(UNIT.Factory, {
              useActualCost: true,
              legendaryEconomyCostQuote: candidate.cost,
              legendaryEconomyFactoryTile: candidate.factoryPlacementTile,
              ...(Array.isArray(candidate.factorySeedStopTiles)
                ? {
                    legendaryEconomyFactorySeedStopTiles:
                      candidate.factorySeedStopTiles,
                  }
                : {}),
              ...(Array.isArray(candidate.factorySeedStops)
                ? {
                    legendaryEconomyFactorySeedStops:
                      candidate.factorySeedStops,
                  }
                : {}),
            })
          ) {
            return "built";
          }
          continue;
        }
        if (candidate.type === UNIT.City) {
          if (
            await this.maybeSpawnStructure(UNIT.City, {
              useActualCost: true,
              legendaryEconomyCostQuote: candidate.cost,
              legendaryEconomyCityTile: candidate.cityPlacementTile,
              legendaryEconomyCityCapRelief: Number(candidate.capacity) > 0,
            })
          ) {
            return "built";
          }
          continue;
        }
        if (ECONOMIC_STRUCTURE_TYPES.includes(candidate.type)) {
          if (
            await this.maybeSpawnStructure(candidate.type, {
              useActualCost: true,
              legendaryEconomyCostQuote: candidate.cost,
            })
          ) {
            return "built";
          }
          continue;
        }
        if (await this.maybeSpawnStructure(candidate.type)) return "built";
      }
      return "skip";
    }

    legendaryWaitYieldsToSafetyAction(actionGroups, currentGroupIndex) {
      const gold = legendaryBigInt(this.player.gold());
      for (
        let groupIndex = currentGroupIndex + 1;
        groupIndex < actionGroups.length;
        groupIndex++
      ) {
        for (const candidate of actionGroups[groupIndex]) {
          if (
            !candidate ||
            candidate.action === "wait" ||
            candidate.legal === false ||
            candidate.affordable === false ||
            legendaryBigInt(candidate.cost) > gold
          ) {
            continue;
          }
          if (
            Number(candidate.mandatory ?? 0) > 0 ||
            Number(candidate.safety ?? 0) > 0
          ) {
            return true;
          }
        }
      }
      return false;
    }

    legendaryConstructionActionGroups(candidates, economyGrowthPriority) {
      const candidateGroups = economyGrowthPriority
        ? [
            candidates.filter((candidate) =>
              ECONOMIC_STRUCTURE_TYPES.includes(candidate.type),
            ),
            candidates.filter(
              (candidate) => !ECONOMIC_STRUCTURE_TYPES.includes(candidate.type),
            ),
          ]
        : [candidates];
      return candidateGroups.map((group) =>
        rankLegendaryConstructionActions(group, {
          gold: this.player.gold(),
          // The MIRV war chest is only an offensive goal. Productive and
          // defensive candidates must remain rankable while the bot saves it.
          reserve: 0n,
        }),
      );
    }

    legendaryReserveGold() {
      if (!state.settings.winFixes || !state.nukeReserveGold) return 0n;
      {
        const reserve = BigInt(state.nukeReserveGold || 0);
        return reserve >= 15_000_000n ? reserve : 0n;
      }
    }

    // Once a Silo is live the nuclear strategy is part of the economy: an
    // idle launcher that can never afford its next Atom is gold the enemy
    // never has to fear. Reserve the next Atom's price ahead of ordinary
    // economic construction so the war chest actually accumulates. The
    // reserve recurs after every launch — the ≥5MM destroyed-value goal is
    // a sustained bombardment, not one shot — but only while a hostile
    // player still owns nuke-eligible structures to spend it on.
    legendaryAtomWarChest() {
      if (
        !state.settings.winFixes ||
        !isLegendaryDifficulty() ||
        this.game.config().isUnitDisabled(UNIT.AtomBomb) ||
        this.game.config().isUnitDisabled(UNIT.MissileSilo)
      ) {
        return 0n;
      }
      const silos = (this.player?.units?.(UNIT.MissileSilo) || []).filter(
        (silo) => silo?.isUnderConstruction?.() !== true,
      );
