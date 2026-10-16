          ? Math.max(0, Math.ceil(ticksLeft))
          : Infinity;
        const reloadTick = Number.isFinite(nominalTick)
          ? Math.max(nominalTick, previousReloadTick + 1)
          : Infinity;
        slots.push(reloadTick);
        if (Number.isFinite(reloadTick)) previousReloadTick = reloadTick;
      }
      for (let index = currentLevel; index < targetLevel; index++) {
        // increaseLevel() pushes the upgrade tick into the queue. The SAM
        // execution reloads it when this cooldown expires and can then fire
        // in that same tick. Multiple projected queue entries still reload
        // one per tick, preserving FIFO spacing after the live queue.
        const reloadTick = Math.max(cooldown, previousReloadTick + 1);
        slots.push(reloadTick);
        previousReloadTick = reloadTick;
      }
      return slots.sort((left, right) => left - right);
    }

    legendaryConstructionDuration(type) {
      {
        const duration = Number(
          this.game.config().unitInfo(type).constructionDuration,
        );
        if (Number.isFinite(duration) && duration >= 0) return duration;
      }
      if (type === UNIT.SAMLauncher) return 300;
      if (type === UNIT.MissileSilo) return 100;
      if (type === UNIT.City || type === UNIT.Factory || type === UNIT.Port) {
        return 20;
      }
      return 0;
    }

    legendaryFriendlySamProfilesCacheHit(tick, config, samUnits) {
      if (
        !Number.isFinite(tick) ||
        this._legendaryFriendlySamProfilesTick !== tick ||
        this._legendaryFriendlySamProfilesConfig !== config ||
        this._legendaryFriendlySamProfilesUnits !== samUnits
      ) {
        return null;
      }
      return this._legendaryFriendlySamProfilesCache ?? null;
    }

    rememberLegendaryFriendlySamProfiles(tick, config, samUnits, profiles) {
      if (!Number.isFinite(tick)) return;
      this._legendaryFriendlySamProfilesTick = tick;
      this._legendaryFriendlySamProfilesConfig = config;
      this._legendaryFriendlySamProfilesUnits = samUnits;
      this._legendaryFriendlySamProfilesCache = profiles;
    }

    legendaryFriendlySamProfiles(levelOverrides = null, extraSam = null) {
      const cacheable = levelOverrides === null && extraSam === null;
      const tick = safeStructureGameTick(this.game);
      const samUnits = this.legendaryFriendlySamUnits();
      const config =
        cacheable && Number.isFinite(tick) ? this.game.config() : null;
      const cached = this.legendaryFriendlySamProfilesCacheHit(
        tick,
        config,
        samUnits,
      );
      if (cacheable && cached !== null) return cached;
      const profiles = this.buildLegendaryFriendlySamProfiles(
        samUnits,
        levelOverrides,
        extraSam,
      );
      if (cacheable) {
        this.rememberLegendaryFriendlySamProfiles(
          tick,
          config,
          samUnits,
          profiles,
        );
      }
      return profiles;
    }

    buildLegendaryFriendlySamProfiles(samUnits, levelOverrides, extraSam) {
      const profiles = [];
      for (const sam of samUnits) {
        const id = sam.id();
        const override =
          levelOverrides && levelOverrides.has(id)
            ? levelOverrides.get(id)
            : null;
        // The override is deliberately passed to both sides of the model:
        // profile.level expands the trajectory range immediately, while
        // slot availability keeps the newly added missile in SAMCooldown.
        const level = Math.max(1, Number(override ?? sam.level() ?? 1));
        const availableTicks = this.legendarySamSlotAvailability(sam, override);
        profiles.push({
          id,
          tile: sam.tile(),
          level,
          range: this.legendarySamRange(level),
          availableTicks,
          readySlots: this.legendaryReadyShotCountFromSlots(availableTicks),
          cooldownTicks: this.legendarySamCooldownTicks(),
        });
      }
      if (extraSam && extraSam.tile !== null && extraSam.tile !== undefined) {
        const level = Math.max(1, Number(extraSam.level ?? 1));
        const availableTicks = Array.isArray(extraSam.availableTicks)
          ? extraSam.availableTicks.slice()
          : Array(level).fill(
              Math.max(0, Number(extraSam.completionTick ?? 0)),
            );
        profiles.push({
          id: extraSam.id ?? "legendary-candidate-sam",
          tile: extraSam.tile,
          level,
          range: this.legendarySamRange(level),
          availableTicks,
          readySlots: this.legendaryReadyShotCountFromSlots(availableTicks),
          cooldownTicks: this.legendarySamCooldownTicks(),
        });
      }
      return profiles;
    }

    legendaryTrajectoryTargetableRange() {
      return Number(this.game.config().defaultNukeTargetableRange());
    }

    legendaryTrajectoryTargetableIndexesCache() {
      const game = this.game;
      if (!game) return null;
      if (
        game !== this._legendaryTrajectoryTargetableCacheGame ||
        !(this._legendaryTrajectoryTargetableCache instanceof WeakMap)
      ) {
        this._legendaryTrajectoryTargetableCacheGame = game;
        this._legendaryTrajectoryTargetableCache = new WeakMap();
      }
      return this._legendaryTrajectoryTargetableCache;
    }

    legendaryCachedTrajectoryTargetableIndexes(
      path,
      fromTile,
      targetTile,
    ) {
      if (!Array.isArray(path)) {
        return this.legendaryTrajectoryTargetableIndexes(
          path,
          fromTile,
          targetTile,
        );
      }
      if (typeof this.game?.config !== "function") {
        return this.legendaryTrajectoryTargetableIndexes(
          path,
          fromTile,
          targetTile,
