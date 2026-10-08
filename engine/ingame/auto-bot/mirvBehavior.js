// Auto-Bot — MirvBehavior: a faithful 1:1 port of the in-game Nation MIRV AI
// (src/core/execution/nation/NationMIRVBehavior.ts). Decides when to launch a
// MIRV — counter an inbound MIRV, deny a runaway victory, or stop a steamroll —
// and aims it at the centre of the target's territory.
//
// Faithful adaptations vs the core class (the ONLY allowed changes — see
// PORT-CONTRACT.md):
//  - DIFFICULTY: src reads the lobby Nation difficulty; the bot REPLICATES a
//    user-chosen difficulty, so every `this.game.config().gameConfig().difficulty`
//    read becomes `currentDifficulty()`.
//  - PLAYER IDENTITY: src compares players with `===`; the client wraps players
//    fresh each tick, so identity compares become `.smallID()` compares.
//  - ASYNC: the MIRV must be fired through the build menu, and the target's
//    border tiles are an async worker read, so considerMIRV()/maybeSendMIRV()
//    BECOME async (nationExecution awaits considerMIRV — NationExecution.ts).
//  - COST: src reads `unitInfo(MIRV).cost(game, player)`, but that cost fn calls
//    `game.stats().numMirvsLaunched()` which the client GameView does NOT expose.
//    We read the live MIRV price from a buildables probe instead (same value,
//    different source — DIVERGENCE noted on cost()).
//
// Loaded after portutil/gameApi (and the emoji phase, which provides the globals
// AllPlayers, EMOJI_NUKE and respondToMIRV, plus EmojiBehavior), before
// nationExecution.
//
// DIVERGENCE (forward-reference): the following are provided by the EmojiBehavior
// phase and referenced bare here exactly as src does — do NOT define them locally
// (that would collide when the emoji phase adds them as shared globals):
//   - global `AllPlayers` (the all-players emoji recipient sentinel)
//   - global `EMOJI_NUKE` (number[] of emoji ids)
//   - global function `respondToMIRV(game, random, mirvTarget)`
//   - emojiBehavior.maybeSendAttackEmoji(player) / emojiBehavior.sendEmoji(recipient, emojiList)

"use strict";

  // 30 seconds at 10 ticks/second
  const MIRV_COOLDOWN_TICKS = 300;

  // Aim weighting for the target's structure core. The warhead field spans a
  // huge radius around the aim point, so a bounding-box centre over empty
  // terrain wastes most of it; silos and cities are the prizes worth the
  // 25M+ price tag, ports/factories ride along, and SAMs simply deny the
  // opponent their interceptor umbrella.
  const MIRV_AIM_STRUCTURE_WEIGHTS = [
    [UNIT.MissileSilo, 3],
    [UNIT.City, 2],
    [UNIT.Port, 2],
    [UNIT.Factory, 1],
    [UNIT.SAMLauncher, 1],
  ];

  class MirvBehavior {
    constructor(random, game, player, emojiBehavior) {
      this.random = random;
      this.game = game;
      this.player = player;
      this.emojiBehavior = emojiBehavior;

      // Tracks the last tick a MIRV was sent at each player, so multiple nations
      // don't pile-on the same target (especially with high starting-gold).
      // DIVERGENCE: src keeps this as a STATIC map shared across all
      // NationMIRVBehavior instances; per the port contract we keep it as
      // per-instance in-memory state — harmless here since there is a single bot.
      this.recentMirvTargets = new Map(); // PlayerID -> Tick
    }

    // ── difficulty getters (use the REPLICATED difficulty) ───────────────────
    get hesitationOdds() {
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return 2; // More likely to hesitate
        case Difficulty.Medium:
          return 4;
        case Difficulty.Hard:
          return 8;
        case Difficulty.Impossible:
          return 16; // Rarely hesitates
        case Difficulty.Legendary:
          return 20; // Legendary almost never hesitates
        default:
          return 16;
      }
    }

    get victoryDenialTeamThreshold() {
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return 0.9; // Only react right before the game ends (95%)
        case Difficulty.Medium:
          return 0.8;
        case Difficulty.Hard:
          return 0.7;
        case Difficulty.Impossible:
          return 0.6; // Reacts early
        case Difficulty.Legendary:
          return 0.5; // Reacts earlier than Impossible
        default:
          return 0.6;
      }
    }

    get victoryDenialIndividualThreshold() {
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return 0.75; // Only react right before the game ends (80%)
        case Difficulty.Medium:
          return 0.65;
        case Difficulty.Hard:
          return 0.55;
        case Difficulty.Impossible:
          return 0.4; // Reacts early
        case Difficulty.Legendary:
          return 0.3; // Reacts earlier than Impossible
        default:
          return 0.4;
      }
    }

    get steamrollCityGapMultiplier() {
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return 2; // Needs larger gap to trigger
        case Difficulty.Medium:
          return 1.5;
        case Difficulty.Hard:
          return 1.25;
        case Difficulty.Impossible:
          return 1.15; // Reacts to smaller gaps
        case Difficulty.Legendary:
          return 1.1;
        default:
          return 1.15;
      }
    }

    get steamrollMinLeaderCities() {
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return 20; // Needs more cities to trigger
        case Difficulty.Medium:
        case Difficulty.Hard:
          return 10;
        case Difficulty.Impossible:
          return 8; // Reacts early
        case Difficulty.Legendary:
          return 6;
        default:
          return 8;
      }
    }

    // ── main entry — NationMIRVBehavior.considerMIRV (now async) ──────────────
    async considerWinFixMIRV(mirvCost) {
      if (!state.settings.winFixes) return null;
      if (this.teamHasWon()) {
        state.nukeReserveGold = 0n;
        return false;
      }
      if (!this.hasReadyMIRVSlot()) return false;
      const target = this.selectWinFixMirvTarget(mirvCost);
      if (!target || this.wasRecentlyMirved(target)) {
        state.nukeReserveGold = 0n;
        return null;
      }
      if (this.player.gold() >= mirvCost) {
        const launched = await this.maybeSendMIRV(target);
        if (!launched) return false;
        state.nukeReserveGold = 0n;
        return true;
      }
      const earlyTicks = state.settings.mirvEarlyGameTicks ?? 6000;
      state.nukeReserveGold = this.game.ticks() >= earlyTicks ? mirvCost : 0n;
      return false;
    }

    async sendFirstEligibleMIRV() {
      if (!this.hasReadyMIRVSlot()) return false;
      const selectors = [
        () => this.selectCounterMirvTarget(),
        () => this.selectVictoryDenialTarget(),
        () => this.selectSteamrollStopTarget(),
      ];
      for (const selectTarget of selectors) {
        const target = selectTarget();
        if (!target || this.wasRecentlyMirved(target)) continue;
        return this.maybeSendMIRV(target);
      }
      return false;
    }

    async considerMIRV() {
      if (this.player === null) throw new Error("not initialized");
      if (this.game.config().isUnitDisabled(UNIT.MIRV)) {
        return false;
      }
      if (!this.hasReadyMIRVSlot()) {
        return false;
      }
      // gold is BigInt; cost() is the live MIRV price (BigInt).
      const mirvCost = await this.cost(UNIT.MIRV);

      // ── WIN-FIX (leader / pre-empt MIRV + save-up) — NOT in src ──────────────
      // The pure faithful targeting (counter-MIRV / victory-denial ≥55% /
      // steamroll) only fires when the bot is already huge; the faithful bot caps
      // ~16% and never gets there, so it never closes out. This branch lets the
      // bot, once it becomes the map leader (≥ mirvLeaderShare), proactively MIRV
      // the strongest rival (and pre-empt a rival about to afford its own MIRV),
      // recording an offensive war-chest goal in state.nukeReserveGold. Ordinary
      // economy and defensive SAM paths remain available while saving. Gated by
      // settings.winFixes.
      const winFixResult = await this.considerWinFixMIRV(mirvCost);
      if (winFixResult !== null) return winFixResult;

      if (this.player.gold() < mirvCost) {
        return false;
      }

      if (this.random.chance(this.hesitationOdds)) {
        return false;
      }

      return this.sendFirstEligibleMIRV();
    }

    // ── MIRV Strategy Methods ────────────────────────────────────────────────
    selectCounterMirvTarget() {
      if (this.player === null) throw new Error("not initialized");
      const attackers = this.getValidMirvTargetPlayers().filter((p) =>
        this.isInboundMIRVFrom(p),
      );
      if (attackers.length === 0) return null;
      attackers.sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
      return attackers[0];
    }

    getTeamVictorySeverity(player, totalLand) {
      const teamMembers = this.game
        .players()
        .filter((candidate) => candidate.team() === player.team() && candidate.isPlayer());
      const teamTerritory = teamMembers.reduce((sum, member) => sum + member.numTilesOwned(), 0);
      const teamShare = teamTerritory / totalLand;
      if (teamShare < this.victoryDenialTeamThreshold) return 0;
      const largestMember = teamMembers.reduce(
        (largest, member) => member.numTilesOwned() > largest.numTilesOwned() ? member : largest,
      );
      return largestMember.smallID() === player.smallID() ? teamShare : 0;
    }

    getVictorySeverity(player, totalLand) {
      if (player.team() !== null) return this.getTeamVictorySeverity(player, totalLand);
      const share = player.numTilesOwned() / totalLand;
      return share >= this.victoryDenialIndividualThreshold ? share : 0;
    }

    selectVictoryDenialTarget() {
      if (this.player === null) throw new Error("not initialized");
      const totalLand = this.game.numLandTiles();
      if (totalLand === 0) return null;
      const ranked = this.getValidMirvTargetPlayers()
        .map((player) => ({ player, severity: this.getVictorySeverity(player, totalLand) }))
        .filter((candidate) => candidate.severity > 0)
        .sort((a, b) => b.severity - a.severity);
      return ranked[0]?.player ?? null;
    }

    selectSteamrollStopTarget() {
      if (this.player === null) throw new Error("not initialized");
      const validTargets = this.getValidMirvTargetPlayers();

      if (validTargets.length === 0) return null;

      const allPlayers = this.game
        .players()
        .filter((p) => p.isPlayer())
        .map((p) => ({ p, cityCount: this.countCities(p) }))
        .sort((a, b) => b.cityCount - a.cityCount);

      if (allPlayers.length < 2) return null;

      const topPlayer = allPlayers[0];

      if (topPlayer.cityCount <= this.steamrollMinLeaderCities) return null;

      const secondHighest = allPlayers[1].cityCount;

      const threshold = secondHighest * this.steamrollCityGapMultiplier;

      if (topPlayer.cityCount >= threshold) {
        return validTargets.some((p) => p.smallID() === topPlayer.p.smallID())
          ? topPlayer.p
          : null;
      }

      return null;
    }

    // ── WIN-FIX target selection (NOT in src) ────────────────────────────────
    // (a) PRE-EMPT: a rival with a silo whose gold is nearing the MIRV price
    //     (≥ mirvPreemptFrac × price) and who is at least half our size — gut them
    //     before they can MIRV us, and each launch raises the global MIRV price.
    // (b) LEADER: once we own ≥ mirvLeaderShare of the map, MIRV the strongest
    //     remaining rival to break the late-game deadlock and snowball to victory.
    // teamHasWon — true in a TEAM game once our whole team owns ≥ teamWonShare of the
    // live map (numLandTiles − fallout). Used to flip the economy from "save for MIRV"
    // to "build economy / SAMs" once the win is effectively secured.
    teamHasWon() {
      if (this.player === null) return false;
      {
        if (String(this.game.config().gameConfig().gameMode) !== "Team") {
          return false;
        }
      }
      const fallout =
        typeof this.game.numTilesWithFallout === "function"
          ? this.game.numTilesWithFallout()
          : 0;
      const denom = (this.game.numLandTiles() || 0) - fallout;
      if (denom <= 0) return false;
      let teamTiles = 0;
      for (const p of this.game.players()) {
        {
          if (p.isPlayer() && this.player.isOnSameTeam(p)) {
            teamTiles += p.numTilesOwned();
          }
        }
      }
      // Use the GAME's REAL team-win threshold (Config.percentageTilesOwnedToWin → 95%
      // for Team, 80% FFA), exactly like WinCheckExecution.checkWinnerTeam. teamWonShare
      // overrides it ONLY if explicitly set to a number (e.g. to react a bit earlier).
      let winFrac = 0.95;
      {
        const p = Number(this.game.config().percentageTilesOwnedToWin());
        if (Number.isFinite(p)) winFrac = p / 100;
      }
      if (Number.isFinite(state.settings.teamWonShare)) {
        winFrac = state.settings.teamWonShare;
      }
      return teamTiles / denom > winFrac;
    }

    selectWinFixMirvTarget(_mirvCost) {
      if (this.player === null) return null;
      const valid = this.getValidMirvTargetPlayers().filter((p) => p.isAlive());
      if (valid.length === 0) return null;

      // USER RULE: only MIRV a genuine DOMINANT leader — a nation that BOTH
      //   (1) owns > mirvTargetMinShare (35%) of the map, AND
      //   (2) ranks in the top mirvTargetTopN (1–3) by owned tiles.
      // (Pre-empt / leader-share branches removed: MIRV is reserved for crushing a
      // runaway leader, not for general nuking — small atom/hydro handle the rest.)
      const total = this.game.numLandTiles() || 1;
      const minShare = state.settings.mirvTargetMinShare ?? 0.35;
      const topN = state.settings.mirvTargetTopN ?? 3;

      // Rank ALL alive players (including us) by owned tiles → the top-N id set.
      const topSet = new Set(
        this.game
          .players()
          .filter((p) => p.isAlive())
          .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
          .slice(0, topN)
          .map((p) => p.smallID()),
      );

      const qualifying = valid
        .filter(
          (p) =>
            topSet.has(p.smallID()) && p.numTilesOwned() / total > minShare,
        )
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());

      return qualifying.length > 0 ? qualifying[0] : null;
    }

    // ── MIRV Cooldown Methods ────────────────────────────────────────────────
    wasRecentlyMirved(target) {
      const lastTick = this.recentMirvTargets.get(target.id());
      if (lastTick === undefined) return false;
      return this.game.ticks() - lastTick < MIRV_COOLDOWN_TICKS;
    }

    recordMirvHit(target) {
      this.recentMirvTargets.set(target.id(), this.game.ticks());
    }

    // ── MIRV Helper Methods ──────────────────────────────────────────────────
    hasReadyMIRVSlot() {
      if (this.player === null) throw new Error("not initialized");
      const silos = this.player.units(UNIT.MissileSilo);
      return (Array.isArray(silos) ? silos : []).some((silo) => {
        if (!silo || silo.isActive?.() === false || silo.isUnderConstruction?.()) {
          return false;
        }
        const level = Number(silo.level?.());
        const queue = silo.missileTimerQueue?.();
        return Number.isFinite(level) && level > 0 && Array.isArray(queue) && queue.length < level;
      });
    }

    isValidMirvTargetPlayer(target) {
      if (this.player === null) throw new Error("not initialized");
      return (
        target.smallID() !== this.player.smallID() &&
        target.isPlayer() &&
        target.type() !== PlayerType.Bot &&
        !this.player.isFriendly(target)
      );
    }

    getValidMirvTargetPlayers() {
      if (this.player === null) throw new Error("not initialized");
      return this.game.players().filter((p) => this.isValidMirvTargetPlayer(p));
    }

    isInboundMIRVFrom(attacker) {
      if (this.player === null) throw new Error("not initialized");
      const enemyMirvs = attacker.units(UNIT.MIRV);
      for (const mirv of enemyMirvs) {
        const dst = mirv.targetTile();
        if (dst === null || dst === undefined) continue;
        if (!this.game.hasOwner(dst)) continue;
        const owner = this.game.owner(dst);
        if (owner && owner.isPlayer && owner.isPlayer() && owner.smallID() === this.player.smallID()) {
          return true;
        }
      }
      return false;
    }

    isPermanentTeammateAlreadyMirvingThisSpot(tile) {
      if (this.player === null) throw new Error("not initialized");
      const activeMirvs = this.game.units?.(UNIT.MIRV, UNIT.MIRVWarhead);
      const warheadInnerRadius = this.game.config?.().nukeMagnitudes?.(UNIT.MIRVWarhead)?.inner;
      const overlapRadiusSquared = (warheadInnerRadius * 2) ** 2;

      return (Array.isArray(activeMirvs) ? activeMirvs : []).some((mirv) => {
        if (!mirv || mirv.isActive?.() === false) return false;
        const owner = mirv.owner?.();
        if (!owner || owner.smallID?.() === this.player.smallID()) return false;
        if (!playersArePermanentTeammates(this.player, owner)) return false;
        const targetTile = mirv.targetTile?.();
        if (targetTile === null || targetTile === undefined) return false;
        return this.game.euclideanDistSquared(tile, targetTile) <= overlapRadiusSquared;
      });
    }

    // ── MIRV Execution Methods (now async) ───────────────────────────────────
    async maybeSendMIRV(enemy) {
      if (this.player === null) throw new Error("not initialized");
      if (!this.hasReadyMIRVSlot()) return false;

      this.emojiBehavior.maybeSendAttackEmoji(enemy);

      const centerTile = await this.calculateTerritoryCenter(enemy);
      // TileRef zero is a valid map coordinate. Upstream's truthy gate drops it,
      // which can suppress both an outbound MIRV and inbound-MIRV detection.
      if (centerTile === null || centerTile === undefined) return false;
      if (this.isPermanentTeammateAlreadyMirvingThisSpot(centerTile)) return false;

      if (!(await this.emitMIRVBuildIntent(enemy, centerTile))) return false;

      this.recordMirvHit(enemy);
      // WIN-FIX (NOT in src): remember this crater centre so the attack behaviour
      // pours amphibious landings into the freshly-MIRV'd (weakened) nation. We
      // reuse the centerTile the MIRV already computed — no extra worker read.
      if (state.settings.winFixes) {
        if (!Array.isArray(state.recentMirvHits)) state.recentMirvHits = [];
        state.recentMirvHits.push({
          sid: enemy.smallID(),
          tile: centerTile,
          at: this.game.ticks(),
        });
      }
      state.stats.nukes++;
      setLastAction(tr("☢️ MIRV"), "nuke");
      this.emojiBehavior.sendEmoji(AllPlayers, EMOJI_NUKE);
      respondToMIRV(this.game, this.random, enemy);
      return true;
    }

    async emitMIRVBuildIntent(enemy, centerTile) {
      // Affordability/actuation via the buildables probe + build menu (the client
      // has no synchronous canBuild / addExecution). Find the MIRV BuildableUnit,
      // check it's buildable AND affordable (gold is BigInt — keep bigint math),
      // then fire through the build menu aimed at the territory centre.
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(centerTile, [UNIT.MIRV]),
          WORKER_TIMEOUT_MS,
          null,
        );
      }
      const bu = Array.isArray(buildables)
        ? buildables.find((b) => b.type === UNIT.MIRV)
        : null;
      if (bu === null || bu === undefined) return false;
      if (
        bu.canBuild === false ||
        bu.canBuild === null ||
        bu.canBuild === undefined ||
        this.player.gold() < bu.cost
      ) return false;
      // Both the territory-center and buildability reads yield to the worker.
      // Revalidate diplomacy at actuation time so a newly friendly player
      // cannot receive a MIRV selected from stale state.
      if (!this.isValidMirvTargetPlayer(enemy)) return false;
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") return false;
      if (!sendAutoBotBuildOrUpgrade(buildMenu, bu, centerTile, this.game, this.player, true)) {
        return false;
      }
      return true;
    }

    countCities(p) {
      return p.unitCount(UNIT.City);
    }

    calculateBorderBounds(tiles) {
      const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const tile of tiles) {
        const x = this.game.x(tile);
        const y = this.game.y(tile);
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
      return bounds;
    }

    findClosestBorderTile(tiles, centerX, centerY) {
      return tiles.reduce((closest, tile) => {
        const dx = this.game.x(tile) - centerX;
        const dy = this.game.y(tile) - centerY;
        const distanceSquared = dx * dx + dy * dy;
        return distanceSquared < closest.distanceSquared
          ? { tile, distanceSquared }
          : closest;
      }, { tile: null, distanceSquared: Infinity }).tile;
    }

    // calculateTerritoryCenter — src/core/execution/Util.ts:233, made async.
    // The src wraps portutil.calculateTerritoryCenter, which reads
    // target.borderTiles() SYNCHRONOUSLY. On the client a non-"me" player's sync
    // border snapshot is EMPTY (only `me` is cached each tick, and a behavior has
    // no way to populate the per-target cache — gameApi's ensureBorderTiles is on
    // the wrapper, not on `game`). So we fetch the target's borders via the async
    // worker accessor (`borderTilesAsync()`) and compute the bounding-box centre
    // DIRECTLY from that returned set — identical math to calculateTerritoryCenter,
    // just sourcing the tiles from the async read. (Mirrors nuke.js mirvCenter.)
    async calculateTerritoryCenter(target) {
      let tiles;
      {
        const res = await withTimeout(
          target.borderTilesAsync(),
          WORKER_TIMEOUT_MS,
          null,
        );
        // borderTilesAsync may resolve to a Set, an array, or a {borderTiles}
        // envelope depending on the worker shape — unwrap defensively.
        tiles = res && res.borderTiles ? res.borderTiles : res;
      }
      if (!tiles) return null;
      const arr = Array.from(tiles);
      if (arr.length === 0) return null;

      const bounds = this.calculateBorderBounds(arr);
      // Prefer the target's structure core over the geometric centre: the
      // warhead field is wide enough that empty terrain at the bbox middle
      // wastes it, while the weighted structure centroid drops it on the
      // silos/cities that justify the price. Clamped into the border bounds
      // and owner-verified like the geometric centre below; any miss falls
      // through to the original behaviour.
      const structureCore = this.mirvStructureCoreTile(target, bounds);
      if (structureCore !== null) {
        if (
          this.game.hasOwner(structureCore) &&
          this.game.ownerID(structureCore) === target.smallID()
        ) {
          return structureCore;
        }
        return this.findClosestBorderTile(
          arr,
          this.game.x(structureCore),
          this.game.y(structureCore),
        );
      }
      const centerX = Math.floor((bounds.minX + bounds.maxX) / 2);
      const centerY = Math.floor((bounds.minY + bounds.maxY) / 2);
      const centerTile = this.game.ref(centerX, centerY);

      // Verify ownership of the center tile (src compares identity; smallID here).
      if (
        this.game.hasOwner(centerTile) &&
        this.game.ownerID(centerTile) === target.smallID()
      ) {
        return centerTile;
      }

      return this.findClosestBorderTile(arr, centerX, centerY);
    }

    // Weighted centroid of the target's high-value structures, clamped into
    // the territory's border bounds. Returns null when nothing is observable
    // (stub targets, empty unit snapshots) so the geometric centre is used.
    mirvStructureCoreTile(target, bounds) {
      if (typeof target?.units !== "function") return null;
      let weightedX = 0;
      let weightedY = 0;
      let totalWeight = 0;
      for (const [type, weight] of MIRV_AIM_STRUCTURE_WEIGHTS) {
        const units = target.units(type);
        for (const unit of Array.isArray(units) ? units : []) {
          const tile = unit?.tile?.();
          if (tile === null || tile === undefined) continue;
          weightedX += this.game.x(tile) * weight;
          weightedY += this.game.y(tile) * weight;
          totalWeight += weight;
        }
      }
      if (totalWeight <= 0) return null;
      const clampedX = Math.min(
        bounds.maxX,
        Math.max(bounds.minX, Math.round(weightedX / totalWeight)),
      );
      const clampedY = Math.min(
        bounds.maxY,
        Math.max(bounds.minY, Math.round(weightedY / totalWeight)),
      );
      return this.game.ref(clampedX, clampedY);
    }

    // cost — src reads unitInfo(type).cost(game, player). The MIRV cost fn calls
    // game.stats().numMirvsLaunched(), which the client GameView does NOT expose.
    // DIVERGENCE: we read the live MIRV price from a buildables probe (the same
    // 25M + 15M × launched value the engine computes, just sourced client-side).
    // We probe an owned tile (the cost is global, so any owned tile returns it).
    async cost(type) {
      if (this.player === null) throw new Error("not initialized");
      const border = this.player.borderTiles();
      const tile = border && border.size > 0 ? border.values().next().value : null;
      if (tile === null || tile === undefined) return 0n;
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(tile, [type]),
          WORKER_TIMEOUT_MS,
          null,
        );
      }
      const bu = Array.isArray(buildables)
        ? buildables.find((b) => b.type === type)
        : null;
      return bu && bu.cost !== undefined && bu.cost !== null ? bu.cost : 0n;
    }
  }
