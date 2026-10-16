    return null;
  }

  function shimHasSharedWater(game, player) {
    if (typeof game.hasSharedWater === "function") {
      return game.hasSharedWater(player);
    }
    return shimSharedWaterComponents(game, player) !== null;
  }

  // railNetwork connectivity — src builds a global station→cluster graph
  // (TrainStation/Railroad), then factory/cityValue score a candidate by the
  // distinct rail clusters reachable within [trainStationMinRange,
  // trainStationMaxRange], weighted by trade gold.
  //
  // TWO PATHS (see buildReachableStations):
  //   - EXTENSION (EXACT clusters): the real rail tiles come from
  //     game.railroadState() (GameView.frameData().railroadState — a per-tile
  //     Uint8Array: 0=no rail, nonzero=rail). We flood-fill the actual rail tiles
  //     into connected components, then map each train-station-bearing unit
  //     (hasTrainStation()===true) to the rail component touching its tile. The
  //     rail-component id IS the cluster key → clusters reflect the ACTUAL laid
  //     track, exactly like core (a station with no adjacent rail is isolated /
  //     null-cluster, matching core's singleton-for-scoring).
  //   - HARNESS (proximity APPROXIMATION): when railroadState() is null (the
  //     coreAdapter has no frameData), we fall back to the StationUnionFind below:
  //     union stationed City/Port/Factory units within trainStationMaxRange
  //     euclidean PROXIMITY. This approximates rail connectivity by geometric
  //     reachability; it is outcome-neutral (placement scoring only) and only
  //     runs in the headless harness.
  //
  // The trade-gold WEIGHTS, the [min,max] range gating, and computeConnectivityScore
  // are reproduced VERBATIM in both paths — only HOW clusters are determined changes.
  class StationUnionFind {
    constructor() {
      this.parent = new Map(); // key -> key
    }
    add(key) {
      if (!this.parent.has(key)) this.parent.set(key, key);
    }
    find(key) {
      let root = key;
      while (this.parent.get(root) !== root) root = this.parent.get(root);
      // path-compress
      let cur = key;
      while (this.parent.get(cur) !== root) {
        const next = this.parent.get(cur);
        this.parent.set(cur, root);
        cur = next;
      }
      return root;
    }
    union(a, b) {
      const ra = this.find(a);
      const rb = this.find(b);
      if (ra !== rb) this.parent.set(ra, rb);
    }
  }

  function maritimePortConstructionStatus(ports) {
    const status = { completed: false, underConstruction: false };
    for (const port of ports) {
      {
        if (typeof port?.isUnderConstruction !== "function") {
          status.completed = true;
        } else if (port.isUnderConstruction()) {
          status.underConstruction = true;
        } else {
          status.completed = true;
        }
      }
    }
    return status;
  }

  function safeStructureGameTick(game) {
    {
      return Number(game?.ticks?.());
    }
  }

  const ECONOMIC_PLACEMENT_SNAPSHOT_IDS = new WeakMap();
  let nextEconomicPlacementSnapshotId = 1;

  function isHostileActiveMissile(player, missile, mySid) {
    if (!missile || missile.isActive?.() === false) return false;
    const owner = missile.owner?.();
    if (!owner || owner.smallID?.() === mySid) return false;
    return !playersArePermanentTeammates(player, owner);
  }

  function isActiveStructureMissileThreat(missile) {
    return Boolean(missile && missile.isActive?.() !== false);
  }

  class StructureBehavior {
    constructor(random, game, player) {
      this.random = random;
      this.game = game;
      this.player = player;
      this.initializeStructureCaches();
    }

    initializeStructureCaches() {
      // src private fields (NationStructureBehavior.ts:126-135).
      this.reachableStationsCache = null;
      this.factoryTradeDestinationsCache = null;
      this._economicPlacementFingerprintTick = null;
      this._economicPlacementFingerprints = new Map();
      this._economicPlacementSnapshotGeometryCache = new WeakMap();
      this._sharedWaterComponents = null;
      this.placementsCount = 0;
      this._hasHighStartingGold = null;
      this._postSaveUpStartTick = null;
      this._hostileSiloSamAttemptTick = null;
      this._hostileSiloSamRetryNotBeforeTick = null;
      this._nukeDemandSiloSpawnReservation = null;
      this._nukeDemandSiloUpgradeReservation = null;
      this._hostilePlayersSnapshotTick = null;
      this._hostilePlayersSnapshot = null;
      this._borderingHostileMaxTroopAdvantageTick = null;
      this._borderingHostileMaxTroopAdvantage = null;
      // Troop-cap pressure snapshot (one boolean per game tick) plus the
      // City-upgrade candidate probe it authorizes: one bounded unit probe per
      // tick with a per-level authoritative cost cache in between.
      this._troopCapPressureTick = null;
      this._troopCapPressure = null;
      this._legendaryCityUpgradeProbeTick = null;
      this._legendaryCityUpgradeProbe = null;
      this._legendaryCityUpgradeCostCache = new Map();
      this._legendaryThroughputUpgradeProbeTick = null;
      this._legendaryThroughputUpgradeProbe = null;
      this.initializeThreatSnapshotCaches();
      this.initializeMissileDefenseCaches();
    }

    initializeThreatSnapshotCaches() {
      // One strategic-border Defense Post authorization snapshot ({ tick,
      // threat }) per game tick; the hostile-player and border scans it builds
      // on are shared with the other construction gates.
      this._strategicBorderDefensePostThreatSnapshot = null;
      this._leadGuardDefensePostThreatSnapshot = null;
      this._hostileThreatSnapshotTick = null;
      this._hostileThreatSnapshot = null;
      this._hostileSiloCapacitySnapshotTick = null;
      this._hostileSiloCapacitySnapshot = null;
      this._hasCoastalTiles = null;
      this._hasOceanPortTiles = null;
      this._economicExposureBorderTick = null;
      this._economicExposureBorderTiles = null;
    }

    initializeMissileDefenseCaches() {
      this._missileDefenseSignalTick = null;
      this._missileDefenseSignalCache = null;
      this._activeHostileMissileTick = null;
      this._activeHostileMissileCache = null;
      this._hostileMissileImpactZonesTick = null;
      this._hostileMissileImpactZonesCache = null;
      this._friendlySamUnitsTick = null;
