            safeStructureGameTick(this.game),
            this.player,
          );
      for (const other of otherOwners) {
        const isTeam = ownPlayer?.isOnSameTeam?.(other) === true;
        const isAlly = !isTeam && ownPlayer?.isAlliedWith?.(other) === true;
        if (isTeam) {
          teamFactoryLevels += levelSum(other?.units?.(UNIT.Factory));
          teamCityStops += levelSum(other?.units?.(UNIT.City));
        } else if (isAlly) {
          allyFactoryLevels += levelSum(other?.units?.(UNIT.Factory));
          allyCityStops += levelSum(other?.units?.(UNIT.City));
        }
        for (const port of other?.units?.(UNIT.Port) ?? []) {
          if (!this.portIsUsable(port)) continue;
          const onSharedWater = [...this.portWaterComponents(port?.tile?.())].some(
            (component) => sharedWater?.has?.(component),
          );
          if (!onSharedWater) continue;
          if (port?.isUnderConstruction?.() === true) {
            pendingPartnerConstructionTicks = Math.max(
              pendingPartnerConstructionTicks,
              this.legendaryConstructionRemainingTicks(UNIT.Port, port),
            );
          }
        }
      }
      const foreignPorts = otherOwners.flatMap((owner) =>
        (owner?.units?.(UNIT.Port) ?? [])
          .filter((port) => this.portIsUsable(port))
          .map((unit) => ({ owner, unit })),
      );
      const completedOwnPorts = ownPortUnits.filter(
        (port) =>
          port?.isUnderConstruction?.() !== true &&
          this.portIsUsable(port),
      );
      const portUpgradeProfiles = {};
      for (const port of hasTradePartner ? completedOwnPorts : []) {
        const id = port?.id?.();
        if (id === null || id === undefined) continue;
        const profile = this.legendaryPortRouteProfile(
          port.tile(),
          ownPlayer,
          foreignPorts,
        );
        if (profile) {
          profile.inboundSources = this.legendaryPortInboundSources(
            port.tile(),
            port,
            levelOf(port) + 1,
          );
          portUpgradeProfiles[String(id)] = profile;
        }
      }
      const portUpgradeTargetIds = Object.keys(portUpgradeProfiles);
      const portSeedWindowOpen = this.legendaryPortSeedWindowOpen();
      const candidateTiles =
        hasTradePartner || portSeedWindowOpen
          ? this.legendaryPortCandidateTilesForEconomy()
          : [];
      let portTradeProfile = null;
      const portCandidateProfiles = [];
      for (const tile of candidateTiles) {
        const profile = this.legendaryPortRouteProfile(tile, ownPlayer, foreignPorts);
        if (profile) {
          profile.inboundSources = this.legendaryPortInboundSources(tile);
          profile.placementTile = tile;
          portCandidateProfiles.push(profile);
        }
        if (
          profile &&
          (portTradeProfile === null ||
            profile.teamGoldPerArrival > portTradeProfile.teamGoldPerArrival ||
            (profile.teamGoldPerArrival === portTradeProfile.teamGoldPerArrival &&
              profile.routeDelayTicks < portTradeProfile.routeDelayTicks))
        ) {
          portTradeProfile = profile;
        }
      }
      let portSeedSources = [];
      let seedPartnerCommitted = false;
      if (
        portSeedWindowOpen &&
        hasCompletedTradePartner !== true &&
        candidateTiles.length > 0
      ) {
        let bestSeed = null;
        for (const ownTile of candidateTiles) {
          for (const component of this.portWaterComponents(ownTile)) {
            if (
              !sharedWater?.has?.(component) ||
              !this.legendaryPortSeedWindowOpen(component)
            ) continue;
            const selectedIds = this.legendaryPortSeedOwnerIds(component).map(String);
            const ownId = String(ownPlayer?.smallID?.() ?? "");
            const partnerId = selectedIds.find((id) => id !== ownId);
            if (!partnerId || !selectedIds.includes(ownId)) continue;
            const partner = otherOwners.find(
              (owner) => String(owner?.smallID?.() ?? "") === partnerId,
            );
            if (!partner) continue;
            const inProgress = (partner.units?.(UNIT.Port) ?? []).filter(
              (port) =>
                this.portIsUsable(port) &&
                port?.isUnderConstruction?.() === true &&
                this.portWaterComponents(port?.tile?.()).has(component),
            );
            let partnerTargets = inProgress.map((unit) => ({ owner: partner, unit }));
            if (partnerTargets.length === 0) {
              let border = partner.oceanShoreBorderTiles?.() ?? [];
              if (border.length === 0) {
                border = Array.from(partner.borderTiles?.() ?? []).filter((tile) =>
                  this.isShoreBorderTile(tile),
                );
              }
              const limit = Math.max(
                1,
                Number(STRUCTURE_PLACEMENT_CANDIDATE_LIMIT) || 1,
              );
              const uniqueBorder = [...new Set(border)];
              const sampledBorder = uniqueBorder.length <= limit
                ? uniqueBorder
                : Array.from({ length: limit }, (_, index) =>
                    uniqueBorder[Math.floor((index * uniqueBorder.length) / limit)],
                  );
              const partnerTiles = sampledBorder.filter(
                (tile) =>
                  this.portWaterComponents(tile).has(component) &&
                  this.portTileHasOpenWaterAccess(tile),
              );
              partnerTargets = partnerTiles.map((tile) => ({ owner: partner, tile }));
            }
            for (const partnerTarget of partnerTargets) {
              const partnerTile = partnerTarget.tile ?? partnerTarget.unit?.tile?.();
              if (partnerTile === null || partnerTile === undefined) continue;
              const ownProfile = this.legendaryPortRouteProfile(ownTile, ownPlayer, [
                { owner: partner, tile: partnerTile, unit: partnerTarget.unit },
              ]);
              const partnerProfile = this.legendaryPortRouteProfile(
                partnerTile,
                partner,
                [{ owner: ownPlayer, tile: ownTile }],
              );
              if (!ownProfile || !partnerProfile) continue;
              const sources = [
                {
                  ...ownProfile,
                  level: 1,
                  portSeedStream: "own",
                  portSeedWaterComponent: component,
                  placementTile: ownTile,
                },
                {
                  ...partnerProfile,
                  level: 1,
                  portSeedStream: "partner",
                  portSeedWaterComponent: component,
                  placementTile: partnerTile,
                  constructionDelayTicks: partnerTarget.unit
