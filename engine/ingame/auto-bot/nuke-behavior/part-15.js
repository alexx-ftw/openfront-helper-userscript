
    async sendImmediateNuke(tile, nukeType, targetPlayer, salvoMetadata, finalLaunchCheck) {
      if (
        !this.isEligibleNukeTarget(targetPlayer, false) ||
        !this.isValidNukeDestination(tile, false, targetPlayer)
      ) return false;
      const buildable = await this.probeNukeBuildable(tile, nukeType);
      if (!this.nukeBuildableCanLaunch(buildable)) return false;
      this.observeHostileNukeThreats();
      if (
        await this.shouldHoldCounterforceNuke(
          tile,
          nukeType,
          targetPlayer,
          buildable.cost,
        )
      ) {
        return false;
      }
      if (!this.nukeLaunchStillSafe(tile, nukeType, targetPlayer, salvoMetadata)) {
        return false;
      }
      if (!(await nukeFinalLaunchCheckPasses(finalLaunchCheck, buildable))) return false;
      // DIVERGENCE: the source can change while the worker prices this shot.
      if (!this.emitNukeWithSalvoFlight(buildable, tile, salvoMetadata)) return false;
      await this.rememberSuccessfulNukeLaunch(tile, nukeType, targetPlayer);
      return true;
    }

    nukeLaunchStillSafe(tile, nukeType, targetPlayer, salvoMetadata) {
      // Keep the target-selection policy stable while refreshing launch safety
      // after the async buildability and counterforce checks.
      return this.isEligibleNukeTarget(targetPlayer, false) &&
        this.isValidNukeDestination(tile, false, targetPlayer) &&
        !this.blastHitsFriendlyLand(tile, nukeType) &&
        this.nukeLaunchRouteViable(tile, nukeType, targetPlayer, salvoMetadata);
    }

    queueDelayedNukeLaunch(tile, nukeType, targetPlayer, delay, salvo = null) {
      if (!this.isEligibleNukeTarget(targetPlayer) || !this.isValidNukeDestination(tile)) return false;
      this._pendingNukeLaunches.push({
        dueTick: Number(this.game.ticks()) + delay,
        tile,
        nukeType,
        targetPlayer,
        // Null for ordinary waitTicks launches (behavior unchanged); fireSamSalvo
        // attaches its plan metadata so the salvo can be re-validated before
        // each due bomb fires (see samSalvoStillViable).
        salvo:
          salvo === null || salvo === undefined ? null : {
            ...salvo,
            // Copy the covering exemption so later mutations of the plan
            // metadata cannot rewrite what this entry was validated against.
            coveringSamIds: salvo.coveringSamIds == null
              ? salvo.coveringSamIds
              : [...salvo.coveringSamIds],
          },
      });
      return true;
    }

    async probeNukeBuildable(tile, nukeType) {
      const buildables = await withTimeout(
        this.player.buildables(tile, [nukeType]),
        WORKER_TIMEOUT_MS,
        null,
      );
      return Array.isArray(buildables)
        ? buildables.find((buildable) => buildable.type === nukeType) ?? null
        : null;
    }

    nukeBuildableCanLaunch(buildable) {
      return Boolean(
        buildable &&
        buildable.canBuild !== false &&
        this.player.gold() >= buildable.cost,
      );
    }

    emitNukeBuildable(buildable, tile, salvo = null) {
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") return false;
      // The bot's trajectory forecasts use directionUp: true. BuildMenu reads
      // the shared manual toggle synchronously when constructing the intent.
      const uiState = buildMenu.uiState;
      const previousDirection = uiState?.rocketDirectionUp;
      if (uiState) uiState.rocketDirectionUp = true;
      try {
        return sendAutoBotBuildOrUpgrade(
          buildMenu,
          buildable,
          tile,
          this.game,
          this.player,
          salvo ?? true,
        );
      } finally {
        if (uiState) uiState.rocketDirectionUp = previousDirection;
      }
    }

    async rememberSuccessfulNukeLaunch(tile, nukeType, targetPlayer) {
      // Mirror src state updates only AFTER a successful fire (src does these
      // unconditionally because addExecution can't "fail"; on the client the build
      // can be rejected, so we gate them on the successful probe+emit above).
      this.recentlySentNukes.push([this.game.ticks(), tile, nukeType]);
      await this.updateNukePerceivedCost(nukeType);
      // Releases the structure planner's first-Atom war chest: the reserve
      // exists only so the launcher's first shot can actually be funded.
      state.nukeFirstLaunchDone = true;
      state.stats.nukes++;
      setLastAction(tr("☢️ Launch") + " " + nukeType, "nuke");
      this.emojiBehavior.maybeSendEmoji(targetPlayer, EMOJI_NUKE);
    }

    async updateNukePerceivedCost(nukeType) {
      if (nukeType === UNIT.AtomBomb) {
        this.atomBombsLaunched++;
        // Increase perceived cost by 50% each time to simulate saving up for a MIRV
        // (higher than hydro to make atom bombs less attractive for the lategame)
        if (this.atomBombPerceivedCost === null) {
          this.atomBombPerceivedCost = await this.cost(UNIT.AtomBomb);
        }
        this.atomBombPerceivedCost =
          (this.atomBombPerceivedCost * 150n) / 100n;
      } else if (nukeType === UNIT.HydrogenBomb) {
        this.hydrogenBombsLaunched++;
        // Increase perceived cost by 25% each time to simulate saving up for a MIRV
        if (this.hydrogenBombPerceivedCost === null) {
          this.hydrogenBombPerceivedCost = await this.cost(UNIT.HydrogenBomb);
        }
        this.hydrogenBombPerceivedCost =
          (this.hydrogenBombPerceivedCost * 125n) / 100n;
      }
    }

    hasPendingNukeLaunches() {
      return this._pendingNukeLaunches.length > 0;
    }

    salvoAwaitingNativeReceipts(salvo) {
      return salvo?.salvoId != null && typeof autoBotBuildPendingNukes === "function" &&
        autoBotBuildPendingNukes(this.game, this.player).some((record) => record.salvoId === salvo.salvoId);
    }

    async processPendingNukeLaunches() {
      if (!this.hasPendingNukeLaunches()) return false;
      const now = Number(this.game.ticks());
      // DIVERGENCE: only a prior-pass prefix blocks today's validated batch.
      const awaitingSalvoIds = new Set(typeof autoBotBuildPendingNukes === "function"
        ? autoBotBuildPendingNukes(this.game, this.player).map((record) => record.salvoId).filter((id) => id != null)
        : []);
      // Before firing a due SAM-overwhelm bomb, re-validate the whole salvo
      // against the live enemy SAM layout (see samSalvoStillViable): a salvo
      // that can no longer penetrate — or whose target SAM is already rubble —
      // drops its entire remaining chain (due + future entries) instead of
      // wasting gold one intercepted atom at a time.
      const abortedSalvoIds = this.getAbortedSalvoIds(now, awaitingSalvoIds);
      const remaining = [];
      const droppedAbortedEntries = [];
      // DIVERGENCE: a queued head still owns the next closest-silo slot.
      const blockedSalvoIds = new Set();
      let launched = false;
      let sendsThisTick = 0;
      for (const pending of this._pendingNukeLaunches) {
