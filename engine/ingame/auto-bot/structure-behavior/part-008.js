      // Building the first SAM is not enough once a hostile Silo is live: a
      // level-one launcher must immediately be upgraded to the minimum H-bomb
      // ready level. A failed/temporarily unaffordable upgrade reserves this
      // same top-priority slot rather than funding an unrelated structure.
      const hydrogenPlan = this.hydrogenSamProtectionPlan?.();
      if (hydrogenPlan === null || hydrogenPlan === undefined) return null;
      if (hydrogenPlan.targetLevel <= hydrogenPlan.currentLevel) return null;
      return (await this.maybeUpgradePlannedSam(hydrogenPlan, {
        maximumNuclearPriority: true,
      })) ? true : false;
    }

    async maybeUpgradeHostileSiloSam() {
      const hydrogenPlan = this.hydrogenSamProtectionPlan?.();
      if (hydrogenPlan === null || hydrogenPlan === undefined) return false;
      if (hydrogenPlan.targetLevel <= hydrogenPlan.currentLevel) return false;
      return this.maybeUpgradePlannedSam(hydrogenPlan, {
        maximumNuclearPriority: true,
      });
    }

    shouldReserveTriggeredHostileSiloSamBudget(placedSilo) {
      return (
        placedSilo &&
        this.shouldReserveHostileSiloSamBudget()
      );
    }

    async handleImmediateStructureDefense(legendaryDifficulty) {
      if (!state.settings.winFixes) return false;
      if (await this.prioritizeMaritimeInvasionDefense()) return true;
      // Before ordinary pacing, upgrade an existing SAM when one level is
      // enough to intercept an incoming missile. Legendary retains its own
      // adaptive defense phase.
      return (
        !legendaryDifficulty && (await this.maybeUpgradeMissileDefenseSam())
      );
    }

    async handleDefensePostPriority(legendaryMissileEmergency) {
      // Active land defense comes before routine SAM coverage/parity and
      // offensive silo work. A concrete missile emergency still wins.
      // Live incoming land attacks remain the primary authorization with their
      // ratio-derived budget; the capped strategic-border rule inside
      // defensePostThreat adds the quiet dogpile pre-condition (a bordering
      // army-sized Nation/Human) without opening the live-attack ratio gates.
      // The active threat object is reused for placement and coverage demand.
      const difficulty = currentDifficulty();
      const activeThreat = this.defensePostThreat(difficulty);
      if (activeThreat === null) return null;
      if (this.game.config().isUnitDisabled(UNIT.DefensePost)) return null;
      const hardReserve = this.shouldHardReserveFailedDefensePost(activeThreat);
      // Active missiles already own the earlier SAM phase. A prospective
      // nuclear threat must not release an overwhelming land-invasion reserve
      // to the offensive/economic planner after its SAM work fails.
      if (legendaryMissileEmergency && !hardReserve) return null;
      if (hardReserve && this.shouldDeferHardDefensePostRetry()) {
        // The SAM-demand lane already preserves economic and defensive reserves.
        return this.maybeUpgradeSiloForNukeDemand();
      }
      if (await this.tryBuildDefensePost(activeThreat)) return true;

      // Save the slot only while gold is the missing requirement. If the post
      // is affordable but no legal tile was found, a mild attack may continue
      // into productive construction. An army-sized Nation/Human invasion keeps
      // the hard reserve so a Port or other unrelated build cannot consume the
      // next bounded placement retry.
      if (!this.canAffordDefensePost() || hardReserve) {
        return hardReserve ? this.maybeUpgradeSiloForNukeDemand() : false;
      }
      return null;
    }

    shouldHardReserveFailedDefensePost(threat) {
      return (
        Number(threat?.ratio) >= DEFENSE_POST_HARD_RESERVE_THREAT_RATIO &&
        threat.landAttacks.some((attack) => this.isStrategicLandAttack(attack))
      );
    }

    shouldDeferHardDefensePostRetry() {
      const tick = Number(this.game.ticks?.());
      if (!Number.isFinite(tick)) return false;
      const lastFailure = Number(this._lastHardDefensePostPlacementFailureTick);
      if (
        Number.isFinite(lastFailure) &&
        tick >= lastFailure &&
        tick - lastFailure < DEFENSE_POST_FAILED_RETRY_TICKS
      ) return true;
      this._lastHardDefensePostPlacementFailureTick = tick;
      return false;
    }

    async handleWinFixStructurePriorities(legendaryDifficulty) {
      if (!state.settings.winFixes) return false;
      if (await this.maybeSpawnPeaceWindowSam()) return true;
      if (await this.maybeSpawnPlateauCity()) return true;
      // The coverage plan upgrades an existing useful SAM whenever increased
      // range can cover the structure set. It asks for another physical site
      // only when geometry proves that leveling cannot close the gap.
      if (await this.maybeEnsureHydrogenStructureCoverage()) return true;
      if (await this.maybeUpgradeHydrogenProtectionSam()) return true;
      if (await this.maybeUpgradeSiloForNukeDemand()) return true;
      if (legendaryDifficulty) return false;
      if (await this.maybeSpawnHostileSiloSam()) return true;
      if (await this.maybeUpgradeSamForSiloParity()) return true;
      if (!this.shouldSpawnSamForParity()) return false;
      return this.maybeSpawnStructure(
        UNIT.SAMLauncher,
        this.shouldBuildHostileSiloSam()
          ? this.hostileSiloSamPlacementOptions()
          : {},
      );
    }

    shouldSpawnSamForParity() {
      if (this.samLevelParityGap() <= 0) return false;
      if (!this.shouldBuildHostileSiloSam()) return true;
      return (
        !this.hostileSiloSamAttemptedThisTick() &&
        !this.hostileSiloSamActionBlocked()
      );
    }

    hasPriorStructureForDefensePost() {
      if (this.placementsCount > 0) return true;
      {
        return STRUCTURES_TYPES.some(
          (type) =>
            type !== UNIT.DefensePost &&
            (this.player.units(type) || []).length > 0,
        );
      }
    }

    // tryBuildDefensePost — NationStructureBehavior.ts:181 (now async).
    async tryBuildDefensePost(precomputedThreat = null) {
      if (!autoBotBuildAllowed(UNIT.DefensePost)) return false; // user disallowed
      // src reads gameConfig().difficulty → REPLICATED difficulty.
      const difficulty = currentDifficulty();
      if (difficulty === Difficulty.Easy) return false;
      if (difficulty === Difficulty.Medium && !this.random.chance(2)) {
        return false;
      }
      const threat = precomputedThreat || this.defensePostThreat(difficulty);
      if (threat === null) return false;
      const frontTiles = threat.frontTiles ||
        this.getAttackFrontTiles(threat.landAttacks);
      const uncoveredFrontTiles = this.defensePostFrontDemand(threat, frontTiles);
      if (uncoveredFrontTiles === null) return false;
      const cost = this.cost(UNIT.DefensePost);
      // Budget through the shared reserve so the first-Silo gold survives a
      // sustained DP pressure lane (Baikal 2026-10-10: DP spam starved the
      // nuclear opening, siloMissing=197).
      if (this.availableGoldAfterReserve(UNIT.DefensePost) < cost) return false;

      // src samples tiles (canBuild checked inside the sampler) and builds the
      // first valid one. Client: sample WITHOUT canBuild (it's async), then probe
      // buildables down the sampled list and build the first canBuild !== false.
      // DIVERGENCE: src filters by sync canBuild during sampling, so it may sample
