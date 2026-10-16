
      // A trajectory-local placement failure must not hide the broader Silo
      // capacity response. In particular, an already-built level-one SAM may
      // be unable to improve this missile's geometry but still needs to reach
      // the external-Silo target before the next launch. Previously this path
      // returned false here, which starved the level-five upgrade behind every
      // active missile that could not be solved by a new launcher.
      const capacityPlan = this.hydrogenSamProtectionPlan?.();
      if (
        capacityPlan !== null &&
        capacityPlan !== undefined &&
        capacityPlan.targetLevel > capacityPlan.currentLevel &&
        (await this.maybeUpgradePlannedSam(capacityPlan))
      ) {
        return true;
      }
      return false;
    }

    activeMissilePendingSamImproves(
      context,
      currentEvaluation,
      uncoveredMirvDemands = [],
    ) {
      const pendingSams = (this.player.units(UNIT.SAMLauncher) || []).filter(
        (sam) => sam?.isUnderConstruction?.() === true,
      );
      if (pendingSams.length === 0) return false;
      for (const sam of pendingSams) {
        const completionTick = this.pendingSamRemainingConstructionTicks(sam);
        if (
          uncoveredMirvDemands.some((demand) =>
            this.samTileCoversMirvDemand(
              sam.tile?.(),
              demand,
              completionTick,
            ),
          )
        ) return true;
        const nextEvaluation = this.legendaryDefenseEvaluation(context, {
          extraSam: {
            id: `pending:${String(sam.id?.() ?? "sam")}`,
            tile: sam.tile?.(),
            level: Math.max(1, Number(sam.level?.() ?? 1)),
            completionTick,
          },
          completionTick,
        });
        if (
          legendaryDefenseActionImproves(
            currentEvaluation,
            nextEvaluation,
            0,
            0,
          )
        ) {
          return true;
        }
      }
      return false;
    }

    pendingSamRemainingConstructionTicks(sam) {
      return this.legendaryConstructionRemainingTicks(UNIT.SAMLauncher, sam);
    }

    // DIVERGENCE: client timestamps begin at first observation; unseen elapsed work keeps full duration.
    legendaryConstructionRemainingTicks(type, unit) {
      const duration = this.legendaryConstructionDuration(type);
      const raw = unit?.__src;
      const startTickValue =
        raw?.state?.constructionStartTick ??
        raw?.constructionStartTick ??
        unit?.state?.constructionStartTick ??
        unit?.constructionStartTick;
      const startTick = Number(startTickValue);
      const now = safeStructureGameTick(this.game);
      if (now === null || !Number.isFinite(startTick) || startTick < 0 || startTick > now) {
        return duration;
      }
      return Math.max(0, duration - now + startTick);
    }

    activeMissileDefenseContext() {
      // An incoming missile has a fixed trajectory and deadline.  Do not first
      // build the full prospective-silo forecast and then discard it: on a
      // mature board that evaluates every hostile silo/target pair every tick
      // while an active missile needs only its observed trajectory.
      const context = this.legendaryActiveMissileDefenseContext();
      return {
        ...context,
        mirvDemands: this.activeMirvDefenseDemands(),
      };
    }

    async handleHostileSiloSamMaximumPriority() {
      if (!state.settings.winFixes) return null;
      if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return null;
      // A Silo becomes a strategic threat as soon as its construction starts:
      // waiting for it to finish wastes the only reliable SAM construction
      // window.  The placement count intentionally includes structures under
      // construction, while the later capacity/coverage planner still uses
      // completed structures where their actual level matters.
      // A hostile player with the silo trigger gold can place a launcher and
      // fire before a newly-started SAM finishes. The first interceptor must
      // therefore start during that funding window, not only after a Silo is
      // visible on the board. A placed nuclear-hostile Silo remains the
      // anticipatory global trigger below; only a completed launcher may hard-
      // reserve all unrelated construction spending.
      const placedSilo = this.hasPlacedSiloOnMap();
      const builtHostileSilo = this.hasBuiltHostileSiloThreat();
      const preemptiveHostileSiloRisk = this.shouldBuildHostileSiloSam();
      if (!placedSilo && !preemptiveHostileSiloRisk) return null;

      if (this.shouldBuildSiloTriggeredSam() || preemptiveHostileSiloRisk) {
        const mode = String(
          this.game.config()?.gameConfig?.()?.gameMode ?? "",
        );
        // Unknown/legacy configs keep the team contract: only an explicit
        // free-for-all mode hoards during the forecast window.
        const ffaMode = mode !== "" && mode !== "Team";
        return this.handleTriggeredHostileSiloSam(
          builtHostileSilo,
          ffaMode && preemptiveHostileSiloRisk,
        );
      }
      return this.handleBuiltHostileSiloSamUpgrade();
    }

    async handleTriggeredHostileSiloSam(
      builtHostileSilo,
      ffaPreemptiveHostileSiloRisk = false,
    ) {
      // Try to preempt a soon-affordable hostile launcher, but only a completed
      // hostile Silo may reserve every construction slot. A forecast or
      // launcher still under construction cannot freeze a poor one-City
      // economy below the first SAM price; it still gets the normal economy
      // action after the failed preemptive SAM attempt.
      if (await this.maybeSpawnHostileSiloSam()) return true;
        // A first launcher may already be built while this trigger remains
        // true.  Do not reserve the entire construction turn for another
        // placement attempt before considering its required interceptor level:
        // that made a completed external Silo strand our only SAM at level 1
        // indefinitely.  An unaffordable upgrade still falls through to the
        // same reserve below, so missile defense keeps its priority.
      if (await this.maybeUpgradeHostileSiloSam()) return true;
        // Preserve the one-income-site bootstrap, then reserve every partial
        // fund for the first SAM. Spending repeatedly on cheaper structures
        // after a Silo appears resets the launcher runway indefinitely.
      // In FFA, reserve the first interceptor during the existing half-silo
      // gold warning window. Teams retain the completed-silo reserve because
      // third-party launches already provide an earlier defense signal.
      return this.shouldReserveTriggeredHostileSiloSamBudget(
        builtHostileSilo || ffaPreemptiveHostileSiloRisk,
      )
        ? false
        : null;
    }

    async handleBuiltHostileSiloSamUpgrade() {
