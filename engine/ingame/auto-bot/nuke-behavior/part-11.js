
    // ── removeOldNukeEvents — NationNukeBehavior.ts:490 ───────────────────────
    removeOldNukeEvents() {
      const maxAge = 600; // 600 ticks = 1 minute
      const tick = this.game.ticks();
      while (
        this.recentlySentNukes.length > 0 &&
        this.recentlySentNukes[0][0] + maxAge < tick
      ) {
        this.recentlySentNukes.shift();
      }
    }

    // ── isNukeAlreadyLandingNear — NationNukeBehavior.ts:618 (upstream
    // 34a8fe723: every warhead in flight counts, not only teammates') ────────
    isNukeAlreadyLandingNear(tile, nukeType) {
      // Get the inner radius for our nuke type
      const ourInnerRadius = this.game.config().nukeMagnitudes(nukeType).inner;

      // Get all active nukes in the game
      const activeNukes = this.game.units(
        UNIT.AtomBomb, UNIT.HydrogenBomb, UNIT.MIRVWarhead,
      );

      // Check if any in-flight warhead's blast radius overlaps with ours
      for (const nuke of activeNukes) {
        const targetTile = nuke.targetTile();
        if (targetTile === null || targetTile === undefined) continue;

        // Get the blast radius of the in-flight warhead
        const otherInnerRadius = this.game
          .config()
          .nukeMagnitudes(nuke.type()).inner;

        // Check if the blast zones overlap
        // They overlap if distance between targets < sum of the two radii
        const distSquared = this.game.euclideanDistSquared(tile, targetTile);
        const sumRadius = ourInnerRadius + otherInnerRadius;
        const sumRadiusSquared = sumRadius * sumRadius;

        if (distSquared <= sumRadiusSquared) {
          return true;
        }
      }

      return false;
    }

    // ── enemyLandBlastCoverage — NationNukeBehavior.ts:640 (upstream
    // 34a8fe723) ──────────────────────────────────────────────────────────────
    enemyLandBlastCoverage(center, nukeType) {
      const { inner, outer } = this.game.config().nukeMagnitudes(nukeType);
      const step = Math.max(1, Math.floor(outer / 10));
      const cx = this.game.x(center);
      const cy = this.game.y(center);
      let total = 0;
      let enemyLand = 0;
      for (let dy = -outer; dy <= outer; dy += step) {
        for (let dx = -outer; dx <= outer; dx += step) {
          const distSquared = dx * dx + dy * dy;
          if (distSquared > outer * outer) continue;
          const weight = distSquared <= inner * inner ? 2 : 1;
          total += weight;
          if (!this.game.isValidCoord(cx + dx, cy + dy)) continue;
          // Water, fallout and unowned land have no player owner
          const owner = this.game.owner(this.game.ref(cx + dx, cy + dy));
          if (
            this.isEnemyNukeLand(owner)
          ) {
            enemyLand += weight;
          }
        }
      }
      return enemyLand / total;
    }

    // ── blastHitsFriendlyLand — NationNukeBehavior.ts:665 (upstream
    // 34a8fe723) ──────────────────────────────────────────────────────────────
    /** Whether any tile in the blast belongs to us, a teammate or an ally (even AFK ones). */
    blastHitsFriendlyLand(center, nukeType) {
      // Stub/older harnesses may lack the player roster or the friendly
      // relation; nothing is known to be friendly there, so keep the fire path.
      if (
        typeof this.game?.players !== "function" ||
        typeof this.player?.isFriendly !== "function"
      ) {
        return false;
      }
      const friendlyIds = new Set(
        this.game.players()
          .filter((p) => this.player.isFriendly(p, true))
          .map((p) => p.smallID()),
      );
      const outer = this.game.config().nukeMagnitudes(nukeType).outer;
      const cx = this.game.x(center);
      const cy = this.game.y(center);
      for (let dy = -outer; dy <= outer; dy++) {
        for (let dx = -outer; dx <= outer; dx++) {
          if (dx * dx + dy * dy > outer * outer) continue;
          if (!this.game.isValidCoord(cx + dx, cy + dy)) continue;
          const ownerId = this.game.ownerID(this.game.ref(cx + dx, cy + dy));
          if (friendlyIds.has(ownerId)) return true;
        }
      }
      return false;
    }

    findUntargetableTrajectoryRange(trajectory, spawnTile, targetTile) {
      const targetRangeSquared = this.game.config().defaultNukeTargetableRange() ** 2;
      let untargetableStart = -1;
      let untargetableEnd = -1;
      for (let i = 0; i < trajectory.length; i++) {
        const tile = trajectory[i];
        if (untargetableStart === -1) {
          const outsideSpawn = this.game.euclideanDistSquared(tile, spawnTile) > targetRangeSquared;
          if (!outsideSpawn) continue;
          const insideTarget = this.game.euclideanDistSquared(tile, targetTile) < targetRangeSquared;
          if (insideTarget) break;
          untargetableStart = i;
        } else if (this.game.euclideanDistSquared(tile, targetTile) < targetRangeSquared) {
          untargetableEnd = i;
          break;
        }
      }
      return { start: untargetableStart, end: untargetableEnd };
    }

    isHostileSamIntercept(sam, excludedSamIds) {
      if (!this.isEnemyNukeSam(sam.unit)) return false;
      if (excludedSamIds?.has(sam.unit.id())) return false;
      const rangeSquared = this.game.config().samRange(sam.unit.level()) ** 2;
      return sam.distSquared <= rangeSquared;
    }

    isTrajectoryIndexTargetable(index, untargetable) {
      return !(
        untargetable.start !== -1 &&
        untargetable.end !== -1 &&
        index >= untargetable.start &&
        index < untargetable.end
      );
    }

    canSamReachTrajectoryIndex(sam, trajectory, index) {
      const speed = Number(this.game.config().defaultSamMissileSpeed());
      if (!Number.isFinite(speed) || speed <= 0) return false;
      const distance = Number(
        this.game.manhattanDist(sam.unit.tile(), trajectory[index]),
      );
      if (!Number.isFinite(distance) || distance < 0) return false;
      return Math.ceil(distance / speed) <= index;
    }

    collectTrajectorySamCandidates(trajectory, includeUnderConstruction) {
      const config = this.game.config();
      if (
        typeof config?.maxSamRange !== "function" ||
        typeof config?.defaultNukeSpeed !== "function"
      ) return null;
      const maxRange = Number(config.maxSamRange());
      const speed = Number(config.defaultNukeSpeed());
      if (
        typeof this.game.nearbyUnits !== "function" ||
        typeof this.game.euclideanDistSquared !== "function" ||
        !Number.isFinite(maxRange) || maxRange < 0 ||
        !Number.isFinite(speed) || speed <= 0
      ) return null;

      const stride = 8;
