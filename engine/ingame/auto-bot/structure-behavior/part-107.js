    structureTileValueFunction(type, options) {
      if (type === UNIT.SAMLauncher && options.prioritizeStructureCoverage) {
        return this.threatSamLauncherValue();
      }
      return isLegendaryDifficulty()
        ? this.legendaryStructureSpawnTileValue(type)
        : this.structureSpawnTileValue(type);
    }

    structureMissileEmergency(type, options = {}) {
      if (!this.shouldInspectStructureMissileEmergency(options)) {
        return { active: false };
      }
      const tick = Number(this.game.ticks?.());
      const { context, evaluation, active } = this.structureMissileEmergencyState(options);
      return {
        active,
        samDefense: type === UNIT.SAMLauncher && active,
        // A missing baseline SAM is still valuable after the current salvo is
        // already impossible to stop.  Keep its construction safe from the
        // actual blast, but do not require one level-one launcher to fully
        // defend every in-flight missile before allowing reconstruction.
        recoverySam:
          type === UNIT.SAMLauncher &&
          options.allowPreemptiveSam === true &&
          this.ownProjectedSamCapacity() <= 0,
        incrementalSamDefense:
          type === UNIT.SAMLauncher && options.activeMissileDefense === true,
        tick,
        context,
        evaluation,
        stateKey: active ? this.missileDefenseStateFingerprint() : null,
      };
    }

    shouldInspectStructureMissileEmergency(options) {
      return (
        isLegendaryDifficulty() ||
        options.activeMissileDefense === true ||
        this.missileDefenseSignalSnapshot()?.hasActiveHostileMissile === true
      );
    }

    structureMissileEmergencyState(options) {
      const context = options.missileDefenseContext || this.getMissileDefenseContext();
      const evaluation = options.missileDefenseContext
        ? this.legendaryDefenseEvaluation(context)
        : this.getMissileDefenseEvaluation(context);
      const active =
        (evaluation.hasThreats && !evaluation.fullyDefended) ||
        this.uncoveredActiveMirvDemands(context).length > 0;
      return { context, evaluation, active };
    }

    async probeCoveragePrioritySamTiles(scored, type, timeoutMs, emergency) {
      const snappedTiles = new Set();
      const attemptedTiles = new Set();
      let attempts = 0;
      for (const { t } of scored) {
        const snappedTile = this.localLandStructureSpawnTile(t);
        if (snappedTile === null) return { handled: false, buildable: null };
        if (snappedTile === false || snappedTiles.has(snappedTile)) continue;
        snappedTiles.add(snappedTile);
        if (!this.structureEmergencyTileAllowed(snappedTile, type, emergency)) {
          continue;
        }
        attempts++;
        attemptedTiles.add(t);
        const bu = await this.buildableFor(type, t, timeoutMs);
        if (this.isUsableStructureBuildable(bu, t, type)) {
          return { handled: true, buildable: bu };
        }
        if (attempts >= HOSTILE_SILO_SAM_AUTHORITATIVE_FALLBACK_LIMIT) break;
      }
      // The local reconstruction is only an optimisation for the expensive
      // cluster anchors.  It is not authoritative: an incomplete public
      // snapshot, an occupied anchor, or three unlucky probes must not turn a
      // mandatory first SAM into a permanent no-op.  Fall through to the
      // normal bounded worker probes, which decide actual buildability.
      return { handled: false, buildable: null, attemptedTiles };
    }

    async probeLegendarySiloLead(tiles, probe, emergency) {
      const lead = await this.buildableFor(UNIT.MissileSilo, tiles[0], probe.probeTimeoutMs);
      if (!this.structureEmergencySnapshotCurrent(emergency)) return { stale: true };
      if (this.isUsableStructureBuildable(lead, tiles[0], UNIT.MissileSilo)) {
        return { buildable: lead };
      }
      return { remainingTiles: tiles.slice(1) };
    }

    // Keep the ranked fast path's safety checks and fallback order together.
    // eslint-disable-next-line sonarjs/cognitive-complexity
    async probeRankedStructureTiles(scored, type, probe, emergency) {
      const ranked = scored.slice(0, probe.probeLimit);
      for (
        let offset = 0;
        offset < ranked.length;
        offset += probe.parallelProbeCount
      ) {
        if (!this.structureEmergencySnapshotCurrent(emergency)) return null;
        let tiles = ranked
          .slice(offset, offset + probe.parallelProbeCount)
          .map(({ t }) => t)
          .filter((tile) => this.structureEmergencyTileAllowed(tile, type, emergency));
        if (tiles.length === 0) continue;
        if (
          type === UNIT.MissileSilo &&
          isLegendaryDifficulty(currentDifficulty()) &&
          state.settings.winFixes
        ) {
          // The ranked lead wins; avoid quoting the rest of the batch needlessly.
          const result = await this.probeLegendarySiloLead(tiles, probe, emergency);
          if (result.stale) return null;
          if (result.buildable) return result.buildable;
          tiles = result.remainingTiles;
          if (tiles.length === 0) continue;
        }
        const buildables = await Promise.all(
          tiles.map((tile) => this.buildableFor(type, tile, probe.probeTimeoutMs)),
        );
        if (!this.structureEmergencySnapshotCurrent(emergency)) return null;
        for (let index = 0; index < buildables.length; index++) {
          if (this.isUsableStructureBuildable(buildables[index], tiles[index], type)) {
            return buildables[index];
          }
        }
      }
      return null;
    }

    structureEmergencySnapshotCurrent(emergency) {
      // Missile objects legitimately advance while worker probes are in
      // flight. A replacement first SAM is checked against the current blast
      // at every candidate/final-build boundary, so it must not be discarded
      // merely because an unrelated salvo changed the global fingerprint.
      if (emergency.recoverySam === true) return true;
      return (
        !emergency.active ||
        this.missileDefenseSnapshotIsCurrent(emergency.tick, emergency.stateKey)
      );
    }

    structureEmergencyTileAllowed(tile, type, emergency) {
      if (
        emergency.samDefense &&
        !this.structureEmergencySamTileAllowed(tile, emergency)
      ) return false;
      return !(
        emergency.active &&
        type !== UNIT.SAMLauncher &&
        this.legendaryTileInsideUninterceptedBlast(
          tile,
          emergency.context,
          emergency.evaluation,
        )
      );
    }

    structureEmergencySamTileAllowed(tile, emergency) {
