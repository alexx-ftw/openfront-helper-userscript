
    legendaryEnemyMissileLaunchEntry(
      silo,
      targetTile,
      siloMetadataCache = null,
    ) {
      const cached = siloMetadataCache?.get(silo);
      const tile = cached?.tile ?? silo.tile();
      const id = cached?.id ?? Number(silo.id?.() ?? 0);
      const slots =
        cached?.slots?.slice() ?? this.legendarySiloSlotAvailability(silo);
      const readyShots = this.legendaryReadyShotCountFromSlots(
        slots,
        cached?.readyShots,
      );
      this.legendaryRememberSiloMetadata({
        siloMetadataCache,
        silo,
        cached,
        tile,
        id,
        slots,
        readyShots,
      });
      return {
        silo,
        tile,
        id,
        distance: this.game.manhattanDist(tile, targetTile),
        flightTicks: null,
        slots,
      };
    }

    legendaryEligibleEnemyMissileSilo(silo) {
      return Boolean(
        silo &&
        !silo.isUnderConstruction?.() &&
        (!silo.isActive || silo.isActive() !== false),
      );
    }

    legendaryEffectiveSiloLaunchTick(entry, nominalLaunchTick) {
      if (entry.lastNominalLaunchTick === nominalLaunchTick) {
        entry.sameTickLaunchCount++;
      } else {
        entry.lastNominalLaunchTick = nominalLaunchTick;
        entry.sameTickLaunchCount = 0;
      }
      return nominalLaunchTick + entry.sameTickLaunchCount;
    }

    legendaryEnemyMissileLaunchPlan(
      enemySilos,
      targetTile,
      shotCount,
      { siloMetadataCache = null } = {},
    ) {
      const entries = [];
      for (const silo of Array.isArray(enemySilos) ? enemySilos : []) {
        if (!this.legendaryEligibleEnemyMissileSilo(silo)) continue;
        entries.push(
          this.legendaryEnemyMissileLaunchEntry(
            silo,
            targetTile,
            siloMetadataCache,
          ),
        );
      }
      const launches = [];
      const cooldown = this.legendarySiloCooldownTicks();
      let nextLaunchTick = 0;
      const total = Math.max(0, Math.floor(Number(shotCount) || 0));

      const closestAvailableEntry = (launchTick) => {
        let selected = null;
        for (const entry of entries) {
          // Slots stay sorted after every assignment, so the first slot is
          // enough to decide whether this silo can launch at this tick.
          if (entry.slots.length === 0 || entry.slots[0] > launchTick) continue;
          if (
            selected === null ||
            entry.distance < selected.distance ||
            (entry.distance === selected.distance && entry.id < selected.id)
          ) {
            selected = entry;
          }
        }
        return selected;
      };

      for (let index = 0; index < total; index++) {
        let launchTick = nextLaunchTick;
        let selected = closestAvailableEntry(launchTick);
        if (selected === null) {
          let nextReadyTick = Infinity;
          for (const entry of entries) {
            nextReadyTick = Math.min(nextReadyTick, entry.slots[0] ?? Infinity);
          }
          if (!Number.isFinite(nextReadyTick)) break;
          launchTick = Math.max(launchTick, nextReadyTick);
          selected = closestAvailableEntry(launchTick);
        }
        if (selected === null) break;
        selected.slots[0] = launchTick + cooldown;
        selected.slots.sort((left, right) => left - right);
        const effectiveLaunchTick = this.legendaryEffectiveSiloLaunchTick(
          selected,
          launchTick,
        );
        const flightTicks = this.legendaryLaunchEntryFlightTicks(
          selected,
          targetTile,
        );
        launches.push({
          silo: selected.silo,
          fromTile: selected.tile,
          siloId: selected.id,
          launchTick: effectiveLaunchTick,
          nominalLaunchTick: launchTick,
          flightTicks,
          impactTick: effectiveLaunchTick + flightTicks,
        });
        nextLaunchTick = launchTick;
      }
      return launches;
    }

    // Returns the relative tick at which every missile slot can fire. Empty
    // slots are ready now (0); queue entries are fire timestamps, so they are
    // converted to a conservative remaining cooldown. This is more accurate
    // than treating `queue.length` as an all-or-nothing capacity number.
    // A hypothetical upgrade changes the SAM range immediately, but
    // UnitImpl.increaseLevel() also appends the current tick to the missile
    // queue for the newly added slot. Therefore only the old level's empty
    // slots are ready at completion; every newly added slot starts with one
    // full SAMCooldown reload.
    legendarySamSlotAvailability(sam, levelOverride = null) {
      if (!sam || sam.isUnderConstruction()) return [];
      const currentLevel = this.normalizedStructureLevel(sam.level());
      const targetLevel = this.normalizedStructureLevel(
        levelOverride,
        currentLevel,
      );
      // The live queue cannot contain more than the current level's slots.
      const queue = this.structureMissileQueue(sam, currentLevel);
      const now = Number(this.game.ticks?.() ?? 0);
      const cooldown = this.legendarySamCooldownTicks();
      const slots = Array(Math.max(0, currentLevel - queue.length)).fill(0);
      let previousReloadTick = -1;
      for (const queuedAt of queue) {
        const firedAt = Number(queuedAt);
        const ticksLeft = Number.isFinite(firedAt)
          ? cooldown - (now - firedAt)
          : Infinity;
        // SAMLauncherExecution reloads one expired queue entry before target
        // selection and can spend it during that same tick. Since it only
        // shifts the queue front once, equally expired entries become ready on
        // consecutive ticks instead of all exposing same-tick capacity.
        const nominalTick = Number.isFinite(ticksLeft)
