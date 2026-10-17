      let best = null;
      let bestProjection = null;
      for (const finalist of finalists) {
        const inboundPortSources = legendaryPortCandidateInboundSources(
          finalist.profile.inboundSources,
        );
        if (candidateFleetSupply) {
          fleetProjection = yield* legendaryProjectEconomyFleetsSteps(
            inputs,
            config,
            horizon,
            {
              ...candidateFleetSupply,
              portRoutes: finalist.profile.routes,
              portInboundSources: inboundPortSources,
            },
          );
        }
        const gold = candidatePortIncome(finalist.profile);
        const preferred = best === null || gold > best.gold ||
          (gold === best.gold && (
            compareText(finalist.signature, best.signature) < 0 ||
            (finalist.signature === best.signature &&
              compareText(
                String(finalist.profile?.placementTile ?? ""),
                String(best.profile?.placementTile ?? ""),
              ) < 0)
          ));
        if (preferred) {
          best = { profile: finalist.profile, gold, signature: finalist.signature };
          bestProjection = fleetProjection;
        }
      }
      if (bestProjection) fleetProjection = bestProjection;
      if (best) portProjectionProfile = best.profile;
      return best ?? { profile: null, gold: -Infinity };
    };
    let totalTeamGold = 0;
    if (inputs.upgradeAction === true) {
      const portUpgradeProfiles = inputs.portUpgradeProfiles ?? {};
      const profile =
        inputs.portUpgradeProfile ??
          portUpgradeProfiles[String(inputs.upgradeStructureId ?? "")] ??
          inputs;
      totalTeamGold = routeIncome(
        profile,
        Math.max(1, Math.floor(Number(inputs.portUpgradeLevel ?? 1))),
        true,
      ) + incomingRouteIncome(profile);
    } else if (inputs.hasCompletedTradePartner === true) {
      const candidateProfiles = inputs.portCandidateProfiles ?? [];
      if (candidateProfiles.length > 0) {
        let selected = yield* selectPortCandidate(candidateProfiles);
        for (let pass = 0; pass < 2; pass++) {
          portPlacementTile = selected.profile?.placementTile;
          if (!selected.profile || selected.profile === portProjectionProfile || !candidateFleetSupply) {
            totalTeamGold = selected.gold;
            break;
          }
          const inboundPortSources = legendaryPortCandidateInboundSources(
            selected.profile.inboundSources,
          );
          fleetProjection = yield* legendaryProjectEconomyFleetsSteps(
            inputs,
            config,
            horizon,
            {
              ...candidateFleetSupply,
              portRoutes: selected.profile.routes,
              portInboundSources: inboundPortSources,
            },
          );
          portProjectionProfile = selected.profile;
          if (pass === 1) {
            totalTeamGold = candidatePortIncome(selected.profile);
            break;
          }
          const bestUnderProjection = yield* selectPortCandidate(candidateProfiles);
          if (bestUnderProjection.profile === selected.profile) {
            totalTeamGold = bestUnderProjection.gold;
            break;
          }
          selected = bestUnderProjection;
        }
      } else {
        if (candidateFleetSupply) {
          fleetProjection = yield* legendaryProjectEconomyFleetsSteps(
            inputs,
            config,
            horizon,
            candidateFleetSupply,
          );
        }
        totalTeamGold = candidatePortIncome(inputs);
      }
    } else {
      const seedSources = Array.isArray(inputs.portSeedSources)
        ? inputs.portSeedSources
        : [];
      if (seedSources.length > 0) {
        portPlacementTile = seedSources.find(
          (source) => source.portSeedStream === "own",
        )?.placementTile;
        // With no committed partner Port on the shared water,
        // PortExecution.tradingPorts() is empty: our port spawns no ships and
        // the candidate can only survive as a marked strategic seed. Once a
        // partner commits, neither stream pays until the slower Port completes.
        if (inputs.portSeedPartnerCommitted === true) {
          if (candidateFleetSupply) {
            fleetProjection = yield* legendaryProjectEconomyFleetsSteps(
              inputs,
              config,
              horizon,
              candidateFleetSupply,
            );
          }
          const pairReadyTicks = Math.max(
            constructionDelayTicks,
            ...seedSources.map((source) =>
              Math.max(
                0,
                Number(source.constructionDelayTicks ?? constructionDelayTicks) || 0,
              ),
            ),
          );
          totalTeamGold = seedSources.reduce(
            (total, source) => total + routeIncome(
              source,
              Math.max(1, Math.floor(Number(source.level) || 1)),
              false,
              pairReadyTicks,
            ),
            0,
          );
        }
      } else if (inputs.hasPendingTradePartner === true) {
        const candidateProfiles = inputs.portCandidateProfiles ?? [];
        if (candidateProfiles.length > 0) {
          const selected = yield* selectPortCandidate(candidateProfiles);
          totalTeamGold = selected.gold;
          portPlacementTile = selected.profile?.placementTile;
        } else {
          if (candidateFleetSupply) {
            fleetProjection = yield* legendaryProjectEconomyFleetsSteps(
              inputs,
              config,
              horizon,
              candidateFleetSupply,
            );
          }
          totalTeamGold = candidatePortIncome(inputs);
        }
      } else {
        return { refused: true };
      }
    }
    if (fleetProjection) {
      const targetId = String(inputs.upgradeStructureId ?? "");
      const ownPortGroups = new Map();
