      return route;
    }

    legendarySalvoRouteInterceptionCapacity(route, samProfiles) {
      if (
        !route ||
        !Array.isArray(route.samOptions) ||
        !Array.isArray(samProfiles) ||
        samProfiles.length === 0
      ) {
        return null;
      }
      let capacity = 0;
      for (const option of route.samOptions) {
        const profile = samProfiles[option.samIndex];
        const availableTicks = profile?.availableTicks;
        if (!Array.isArray(availableTicks)) continue;
        capacity += this.legendaryReadyShotCountFromSlots(
          availableTicks,
          profile.readySlots,
        );
      }
      return capacity;
    }

    legendarySalvoSourceMetrics({
      enemySilos,
      targetTile,
      launchFlightTimes,
      routes = null,
      samProfiles = null,
      siloMetadataCache = null,
    }) {
      const routesBySilo = new Map();
      if (Array.isArray(routes)) {
        for (const route of routes) {
          const silo = route?.silo;
          if (silo && !routesBySilo.has(silo)) {
            routesBySilo.set(silo, route);
          }
        }
      }
      const metrics = enemySilos.slice(0, 0);
      for (const silo of enemySilos) {
        const fromTile = siloMetadataCache?.get(silo)?.tile ?? silo.tile();
        const routeCapacity = this.legendarySalvoRouteInterceptionCapacity(
          routesBySilo.get(silo),
          samProfiles,
        );
        metrics.push({
          silo,
          fromTile,
          flightTimeTicks:
            launchFlightTimes.get(silo) ??
            this.legendaryNukeFlightTime(fromTile, targetTile),
          interceptionCapacity:
            routeCapacity ??
            this.legendarySamInterceptionCapacity(
              fromTile,
              targetTile,
              null,
              samProfiles,
            ),
        });
      }
      return metrics;
    }

    // Shared per-tick snapshot of the missile unit families. The overlay
    // prediction layers re-read the same families every tick, so ride their
    // cache when present; sandboxes without the global fall back to a direct
    // read with identical semantics.
    missileFamilyUnitsSnapshot(...types) {
      if (typeof getCachedGameUnits === "function") {
        return getCachedGameUnits(this.game, ...types);
      }
      return this.game.units(...types);
    }

    // Client-side approximation of the engine's global numMirvsLaunched
    // counter: every MIRV unit id we have SEEN in flight represents one
    // market-wide launch that raised the price by 15M. MIRVs fly for hundreds
    // of ticks, so a per-decision snapshot catches essentially all of them;
    // the set is retained for the behavior's lifetime because ids never
    // repeat. Never reads the live map beyond the shared snapshot.
    observedGlobalMirvLaunchCount() {
      if (this._observedMirvUnitIds === null ||
          this._observedMirvUnitIds === undefined) {
        this._observedMirvUnitIds = new Set();
      }
      if (typeof this.game?.units !== "function") return this._observedMirvUnitIds.size;
      for (const mirv of this.missileFamilyUnitsSnapshot(UNIT.MIRV)) {
        const id = typeof mirv?.id === "function" ? mirv.id() : mirv?.id;
        if (id !== null && id !== undefined) this._observedMirvUnitIds.add(id);
      }
      return this._observedMirvUnitIds.size;
    }

    legendaryActiveMissileThreats(context) {
      const threats = [];
      let activeNukes;
      {
        activeNukes = this.missileFamilyUnitsSnapshot(
          UNIT.AtomBomb,
          UNIT.HydrogenBomb,
        );
      }
      const mySid = this.player.smallID();
      const samProfiles =
        context.samProfiles || this.legendaryFriendlySamProfiles();
      for (const nuke of activeNukes) {
        {
          const threat = this.legendaryActiveMissileThreat(
            nuke,
            mySid,
            context,
            samProfiles,
          );
          if (threat !== null) threats.push(threat);
        }
      }
      return threats;
    }

    activeMirvDefenseDemands() {
      const demands = [];
      const mySid = this.player.smallID();
      const protectedStructures =
        this.player.units(
          UNIT.City,
          UNIT.Factory,
          UNIT.Port,
          UNIT.MissileSilo,
        ) || [];
      let protectedStructureSnapshots = null;
      const activeMissiles = this.missileFamilyUnitsSnapshot(
        UNIT.MIRV,
        UNIT.MIRVWarhead,
      );
      for (const missile of activeMissiles) {
        if (!isHostileActiveMissile(this.player, missile, mySid)) continue;
        const targetTile = missile.targetTile?.();
        if (targetTile === null || targetTile === undefined) continue;
        const fromTile = missile.tile?.();
        if (fromTile === null || fromTile === undefined) continue;
        const deadlineTick = this.activeMirvDeadlineTick(
          missile,
          fromTile,
          targetTile,
        );
        if (missile.type?.() === UNIT.MIRV) {
          protectedStructureSnapshots = this.mirvProtectedStructureSnapshots(
            protectedStructureSnapshots,
            protectedStructures,
          );
          this.appendMirvDefenseDemands(
            demands,
            missile,
            targetTile,
            deadlineTick,
