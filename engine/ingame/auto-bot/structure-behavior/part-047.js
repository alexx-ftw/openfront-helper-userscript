        completionTick,
      });
      if (!plan.forecastComplete) {
        schedule.fullyDefended = false;
        schedule.inconclusive = true;
      }
      return schedule;
    }

    hasLegendaryLevelOverrides(levelOverrides) {
      if (!levelOverrides) return false;
      if (typeof levelOverrides.size === "number") return levelOverrides.size > 0;
      return true;
    }

    getMissileDefenseEvaluation(context) {
      if (
        context &&
        this._missileDefenseEvaluationContext === context &&
        this._missileDefenseEvaluationCache !== null
      ) {
        return this._missileDefenseEvaluationCache;
      }

      const evaluation = this.legendaryDefenseEvaluation(context);
      this._missileDefenseEvaluationTick =
        typeof this.game?.ticks === "function"
          ? Number(this.game.ticks())
          : null;
      this._missileDefenseEvaluationContext = context;
      this._missileDefenseEvaluationCache = evaluation;
      return evaluation;
    }

    legendaryDefenseEvaluation(context, options = {}) {
      if (!context || !Array.isArray(context.threats)) {
        return this.emptyLegendaryDefenseEvaluation();
      }
      const cacheable =
        !this.hasLegendaryLevelOverrides(options.levelOverrides) &&
        !options.extraSam &&
        Number(options.completionTick ?? 0) === 0;
      if (cacheable && context._legendaryDefenseEvaluationCache) {
        return context._legendaryDefenseEvaluationCache;
      }
      const samProfiles = this.legendaryDefenseSamProfiles(context, options);
      const { routes, groups } = this.legendaryDefenseRouteGroups(
        context.threats,
        options,
        samProfiles,
      );
      const globalSchedule = legendaryMissileDefenseSchedule({
        routes,
        samProfiles,
        samCooldownTicks: this.legendarySamCooldownTicks(),
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        completionTick: options.completionTick ?? 0,
      });
      if (groups.some((group) => !group.forecastComplete)) {
        globalSchedule.fullyDefended = false;
        globalSchedule.inconclusive = true;
      }
      const schedules = groups.map((group) =>
        this.legendaryGroupDefenseSchedule(group, globalSchedule),
      );
      if (schedules.length === 0) {
        const evaluation = {
          hasThreats: false,
          fullyDefended: true,
          completionMarginTicks: Infinity,
          minimumInterceptMarginTicks: Infinity,
          firstImpactTick: Infinity,
          uninterceptedCount: 0,
          schedules,
          globalSchedule,
        };
        if (cacheable) context._legendaryDefenseEvaluationCache = evaluation;
        return evaluation;
      }
      const evaluation = {
        hasThreats: true,
        fullyDefended: globalSchedule.fullyDefended,
        completionMarginTicks: globalSchedule.completionMarginTicks,
        minimumInterceptMarginTicks:
          globalSchedule.minimumInterceptMarginTicks,
        firstImpactTick: globalSchedule.firstImpactTick,
        uninterceptedCount: globalSchedule.uninterceptedCount,
        schedules,
        globalSchedule,
      };
      if (cacheable) context._legendaryDefenseEvaluationCache = evaluation;
      return evaluation;
    }

    legendaryDefenseSamProfiles(context, options = {}) {
      if (
        this.hasLegendaryLevelOverrides(options.levelOverrides) ||
        options.extraSam
      ) {
        return this.legendaryFriendlySamProfiles(
          options.levelOverrides ?? null,
          options.extraSam ?? null,
        );
      }
      return context.samProfiles || this.legendaryFriendlySamProfiles();
    }

    emptyLegendaryDefenseEvaluation() {
      return {
        hasThreats: false,
        fullyDefended: true,
        completionMarginTicks: Infinity,
        minimumInterceptMarginTicks: Infinity,
        firstImpactTick: Infinity,
        uninterceptedCount: 0,
        schedules: [],
      };
    }

    legendaryDefenseRouteGroups(threats, options, samProfiles) {
      const routes = [];
      const groups = [];
      for (let threatIndex = 0; threatIndex < threats.length; threatIndex++) {
        const threat = threats[threatIndex];
        const plan = this.legendaryReusableOrRebuiltDefensePlan(
          threat,
          options,
          samProfiles,
        );
        if (!plan || !Array.isArray(plan.routes) || plan.routes.length === 0) {
          continue;
        }
        const routeIds = new Set();
        for (let routeIndex = 0; routeIndex < plan.routes.length; routeIndex++) {
          const route = plan.routes[routeIndex];
          const id = `${String(threatIndex)}:${String(route.id ?? routeIndex)}`;
          routeIds.add(id);
          routes.push({ ...route, id, threatIndex });
        }
        groups.push({
          threat,
          threatIndex,
          routeIds,
          forecastComplete: plan.forecastComplete !== false,
        });
      }
      return { routes, groups };
    }

    legendaryReusableOrRebuiltDefensePlan(threat, options, samProfiles) {
      const canReuseRoutes =
        !this.hasLegendaryLevelOverrides(options.levelOverrides) &&
        !options.extraSam &&
        Number(options.completionTick ?? 0) === 0 &&
        Array.isArray(threat?.salvoPlan?.routes);
      if (canReuseRoutes) {
        return {
          routes: threat.salvoPlan.routes,
          samProfiles,
          forecastComplete: threat.salvoPlan.forecastComplete !== false,
