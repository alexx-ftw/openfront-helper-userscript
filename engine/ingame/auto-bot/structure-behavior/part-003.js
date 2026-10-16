  // The Nation execution loop asks for defensive structure work between the
  // main attack decisions as well as on the main decision itself.  Those
  // interstitial calls must keep missile/SAM/land-defense reactions live, but
  // retrying a full ordinary economy placement (and its async buildables
  // probes) every ~16 ticks creates visible Auto-build stalls without gaining
  // a new construction opportunity.  A short, tick-based cooldown keeps the
  // expensive ordinary lane bounded while never delaying the emergency lanes.
  const ORDINARY_STRUCTURE_DECISION_INTERVAL_TICKS = 20;

  /**
   * Do not repeat a failed hostile-Silo SAM placement probe more than once per
   * second of game time. The placement path can otherwise perform 25 sequential
   * async worker probes on every structure decision.
   */
  const HOSTILE_SILO_SAM_RETRY_TICKS = 10;
  const NUKE_DEMAND_SILO_INTENT_GRACE_TICKS = 10;

  /**
   * Minimum time from emergency SAM completion/upgrade to the first incoming
   * missile impact: 0.5 seconds at the engine's 10 ticks per second.
   */
  const LEGENDARY_SAM_IMPACT_MARGIN_TICKS = 5;

  /** Bound authoritative trajectory stepping before using the geometric fallback. */
  const LEGENDARY_MAX_NUKE_FLIGHT_TICKS = 100_000;

  /**
   * Safety guard for pathological gold reserves. A forecast that reaches this
   * cap is marked incomplete and therefore cannot be accepted as defended.
   */
  const LEGENDARY_MAX_FORECAST_MISSILES = 96;

  /**
   * The opening salvo window over which an enemy's silo reload cadence is
   * evaluated. A chain of atoms followed by a hydrogen finisher fits well
   * inside this window, so it bounds how many times a slot can contribute.
   */
  const LEGENDARY_SALVO_WINDOW_TICKS = 90;

  /**
   * A missile planner only needs representative high-value/clustered targets.
   * The full structure list remains in the context for exposure and placement
   * scoring, while this cap prevents rebuilding a long salvo for every remote
   * low-value structure on large maps.
   */
  const LEGENDARY_MAX_MISSILE_TARGETS = 16;

  /** Non-active forecasts can safely reuse a conservative snapshot briefly. */
  const LEGENDARY_MISSILE_DEFENSE_CONTEXT_BUCKET_TICKS = 3;

  /**
   * Hard / Impossible: one additional defense post is allowed per this fraction
   * of the incoming-to-own-troop ratio.
   */
  const DEFENSE_POST_RATIO_PER_POST = 0.4;
  // Posts multiply one border's tile cost; Cities raise the troop ceiling for
  // the WHOLE defense. An unbounded live-attack post budget drained treasury
  // every ~50s of a multi-nation dogpile and kept the second City permanently
  // unaffordable — the army cap then lost the attrition war the posts were
  // meant to survive.
  const DEFENSE_POST_MAX_CONCURRENT = 3;
  // Once a strategic invasion already matches our entire field army, releasing
  // an affordable failed Post budget into an unrelated structure can decide the
  // battle before the next placement retry.
  const DEFENSE_POST_HARD_RESERVE_THREAT_RATIO = 1;
  const DEFENSE_POST_FAILED_RETRY_TICKS = 10;
  const ECONOMIC_PLACEMENT_PROBE_RETRY_TICKS = DEFENSE_POST_FAILED_RETRY_TICKS;

  // NOTE: the OCEAN sentinel (-1) used by sharedWaterComponents now lives in
  // gameApi's water reconstruction (SHARED_OCEAN_SENTINEL); structureBehavior only
  // consumes the resulting Set<number>|null via shimSharedWaterComponents.

  // The set of unit types treated as "structures" — src Structures.types
  // (Game.ts:374): City, DefensePost, SAMLauncher, MissileSilo, Port, Factory.
  const STRUCTURES_TYPES = [
    UNIT.City,
    UNIT.DefensePost,
    UNIT.SAMLauncher,
    UNIT.MissileSilo,
    UNIT.Port,
    UNIT.Factory,
  ];

  // Vendored units() caps at three positional types and silently drops the
  // rest; enumerate per type so the full six-structure roster is seen.
  function structuresOfAllTypes(game) {
    const out = [];
    for (const type of STRUCTURES_TYPES) out.push(...game.units(type));
    return out;
  }

  // USER GATE (not in src): the popup lets the user disallow auto-building
  // specific structure types. A type is allowed unless explicitly set false.
  function autoBotBuildAllowed(type) {
    const allow = state.settings && state.settings.buildStructures;
    return !allow || allow[type] !== false;
  }

  function profileStructureAsync(profile, name, action) {
    if (typeof autoBotProfileAsyncPhase === "function") {
      return autoBotProfileAsyncPhase(profile, name, action);
    }
    return action();
  }

  function profileStructureSync(profile, name, action) {
    if (typeof autoBotProfileSyncPhase === "function") {
      return autoBotProfileSyncPhase(profile, name, action);
    }
    return action();
  }

  // ===========================================================================
  // §SHIMS — the two genuinely-missing datasets, reconstructed client-side.
  // These are the ONLY approximations; they affect placement SCORING only.
  // ===========================================================================

  // canTrade(a, b) — src PlayerImpl.ts:887. No mutual embargo and different id.
  // (gameApi player exposes hasEmbargoAgainst + id(), so this is exact.)
  function shimCanTrade(a, b) {
    if (a == null || b == null) return false;
    const aId = typeof a.id === "function" ? a.id() : a.smallID?.();
    const bId = typeof b.id === "function" ? b.id() : b.smallID?.();
    if (aId === bId) return false;
    const aEmbargo = typeof a.hasEmbargoAgainst === "function"
      ? a.hasEmbargoAgainst(b)
      : false;
    const bEmbargo = typeof b.hasEmbargoAgainst === "function"
      ? b.hasEmbargoAgainst(a)
      : false;
    return !aEmbargo && !bEmbargo;
  }

  // sharedWaterComponents(game, player) — src SharedWaterCache + GameImpl.
  // SHAPE returned by src: `Set<number> | null` where null = no coastal/shared
  // water; a present set contains OCEAN_SENTINEL(-1) when touching ocean and lake
  // component-ids that are shared with a tradeable other player.
  //
  // RECONSTRUCTION (gameApi §SHIM-DATA): this now returns a REAL `Set<number>|null`
  // backed by a full-resolution water union-find that gameApi builds ONCE per game
  // (cached — terrain is static). gameApi.sharedWaterComponents reproduces core's
  // SharedWaterCache predicate exactly: ocean is always shared (sentinel -1); a
  // lake component is shared iff another non-bot player on that component's coast
  // can trade with us (no mutual embargo). The component ids remain available
  // to the coastal trade/factory planning logic. Port placement is stricter:
  // randCoastalTileArray only accepts a border tile adjacent to the canonical
  // open-ocean component.
  //
  // EXACT vs APPROXIMATE: the "shared" PREDICATE is exact (same ocean handling,
  // same bot-skip, same canTrade). The only divergence is GRANULARITY: core labels
  // components on a DOWNSAMPLED MINIMAP graph (x/y÷2) that the client does not
  // expose; we union-find at FULL resolution, so a narrow channel the minimap
  // merges (or a strait it splits) can land in a different component. This is
  // strictly better than the old bounded 400-tile BFS.
  function shimSharedWaterComponents(game, player) {
    {
      if (typeof game.sharedWaterComponents === "function") {
        return game.sharedWaterComponents(player);
      }
    }
