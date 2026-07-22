// Map-agnostic spawn candidate index.
//
// This file intentionally has no dependency on GameView, PlayerView, or the
// overlay. It can therefore be built once from the live terrain and updated
// locally when a terrain/occupancy tile changes. The engine-specific adapter
// supplies ownership, border, team-area, and distance rules.

{
  const SPAWN_IS_LAND_BIT = 7;
  const SPAWN_MAGNITUDE_MASK = 31;
  const DEFAULT_IMPASSABLE_MAGNITUDE = 31;
  const DEFAULT_SPAWN_RADIUS = 4;
  const SPAWN_PLAINS_MAGNITUDE = 10;
  const FRONTIER_VALUE_SCALE = 1000;

  function isInteger(value) {
    return Number.isInteger(value) && value >= 0;
  }

  function isValidTerrainByte(byte, impassableMagnitude = DEFAULT_IMPASSABLE_MAGNITUDE) {
    return (
      (byte & (1 << SPAWN_IS_LAND_BIT)) !== 0 &&
      (byte & SPAWN_MAGNITUDE_MASK) !== impassableMagnitude
    );
  }

  function isPlainsTerrainByte(byte, impassableMagnitude = DEFAULT_IMPASSABLE_MAGNITUDE) {
    return (
      isValidTerrainByte(byte, impassableMagnitude) &&
      (byte & SPAWN_MAGNITUDE_MASK) < SPAWN_PLAINS_MAGNITUDE
    );
  }

  // Relative one-step expansion value derived from Config.attackLogic for a
  // human attacker against terra nullius: Plains 80*16.5, Highland 100*20,
  // Mountain 120*25. The scale is integer so frontier updates stay cheap.
  function terrainExpansionValue(byte, impassableMagnitude = DEFAULT_IMPASSABLE_MAGNITUDE) {
    if (!isValidTerrainByte(byte, impassableMagnitude)) return 0;
    const magnitude = byte & SPAWN_MAGNITUDE_MASK;
    if (magnitude < SPAWN_PLAINS_MAGNITUDE) return FRONTIER_VALUE_SCALE;
    if (magnitude < 20) return 660;
    return 440;
  }

  function safePressureScore(pressure) {
    const value = Number.isFinite(Number(pressure)) ? Math.max(0, Number(pressure)) : 0;
    return 1 / (1 + value);
  }

  // This is the exact geometry used by OpenFront's euclDistFN(..., true): the
  // center is shifted by -0.5 before the radius test. Out-of-map tiles are
  // omitted by GameMap.neighbors(), so edge candidates are handled naturally.
  function buildSpawnDiskOffsets(radius) {
    const offsets = [];
    const limit = Math.ceil(radius) + 1;
    const radiusSquared = radius * radius;
    for (let dy = -limit; dy <= limit; dy += 1) {
      for (let dx = -limit; dx <= limit; dx += 1) {
        const shiftedX = dx + 0.5;
        const shiftedY = dy + 0.5;
        if (shiftedX * shiftedX + shiftedY * shiftedY <= radiusSquared) {
          offsets.push({ dx, dy });
        }
      }
    }
    return offsets;
  }

  function buildSpawnFrontierOffsets(diskOffsets) {
    const diskKeys = new Set(diskOffsets.map((offset) => `${offset.dx},${offset.dy}`));
    const frontier = [];
    const frontierKeys = new Set();
    for (const offset of diskOffsets) {
      const neighbors = [
        { dx: offset.dx - 1, dy: offset.dy },
        { dx: offset.dx + 1, dy: offset.dy },
        { dx: offset.dx, dy: offset.dy - 1 },
        { dx: offset.dx, dy: offset.dy + 1 },
      ];
      for (const neighbor of neighbors) {
        const key = `${neighbor.dx},${neighbor.dy}`;
        if (diskKeys.has(key) || frontierKeys.has(key)) continue;
        frontierKeys.add(key);
        frontier.push(neighbor);
      }
    }
    return frontier;
  }

  function createSpawnIndexConfiguration(options) {
    const width = Number(options.width);
    const height = Number(options.height);
    if (!isInteger(width) || width === 0 || !isInteger(height) || height === 0) {
      throw new Error("SpawnCandidateIndex requires positive integer dimensions");
    }
    const size = width * height;
    const terrain = options.terrain;
    if (!terrain || typeof terrain.length !== "number" || terrain.length < size) {
      throw new Error("SpawnCandidateIndex requires a terrain buffer covering the map");
    }
    return {
      width,
      height,
      size,
      terrain: copySpawnTerrain(terrain, size),
      spawnRadius: Number.isFinite(options.spawnRadius)
        ? Math.max(0, Number(options.spawnRadius))
        : DEFAULT_SPAWN_RADIUS,
      impassableMagnitude: Number.isFinite(options.impassableMagnitude)
        ? Number(options.impassableMagnitude) & SPAWN_MAGNITUDE_MASK
        : DEFAULT_IMPASSABLE_MAGNITUDE,
    };
  }

  function copySpawnTerrain(terrain, size) {
    const snapshot = new Uint8Array(size);
    if (typeof terrain.subarray === "function") {
      snapshot.set(terrain.subarray(0, size));
      return snapshot;
    }
    for (let ref = 0; ref < size; ref += 1) snapshot[ref] = terrain[ref];
    return snapshot;
  }

  function createSpawnBlockedBuffer(options, size) {
    const blocked = new Uint8Array(size);
    if (!options.blocked) return blocked;
    if (options.blocked.length < size) {
      throw new Error("SpawnCandidateIndex blocked buffer is smaller than the map");
    }
    for (let ref = 0; ref < size; ref += 1) blocked[ref] = options.blocked[ref] ? 1 : 0;
    return blocked;
  }

  function createSpawnCountBuffer(size, maximumValue) {
    if (maximumValue <= 0xff) return new Uint8Array(size);
    if (maximumValue <= 0xffff) return new Uint16Array(size);
    return new Uint32Array(size);
  }

  class SpawnCandidateIndex {
    constructor(options = {}) {
      const configuration = createSpawnIndexConfiguration(options);
      Object.assign(this, configuration);
      this.blocked = createSpawnBlockedBuffer(options, this.size);

      this.diskOffsets = buildSpawnDiskOffsets(this.spawnRadius);
      this.frontierOffsets = buildSpawnFrontierOffsets(this.diskOffsets);
      this.spawnGain = createSpawnCountBuffer(this.size, this.diskOffsets.length);
      this.plainsGain = createSpawnCountBuffer(this.size, this.diskOffsets.length);
      this.invalidCount = createSpawnCountBuffer(this.size, this.diskOffsets.length);
      this.frontierGain = createSpawnCountBuffer(
        this.size,
        this.frontierOffsets.length,
      );
      this.frontierPlainsGain = createSpawnCountBuffer(
        this.size,
        this.frontierOffsets.length,
      );
      this.frontierValueGain = createSpawnCountBuffer(
        this.size,
        this.frontierOffsets.length * FRONTIER_VALUE_SCALE,
      );
      this.frontierSlots = createSpawnCountBuffer(
        this.size,
        this.frontierOffsets.length,
      );
      this._buildCursor = 0;
      this.ready = false;
      this.version = 0;

    }

    _isValidRef(ref) {
      return isInteger(ref) && ref < this.size;
    }

    _cellValid(ref) {
      return (
        this.blocked[ref] === 0 &&
        isValidTerrainByte(this.terrain[ref], this.impassableMagnitude)
      );
    }

    _forEachAffectedCenter(tileRef, callback) {
      const tileX = tileRef % this.width;
      const tileY = Math.floor(tileRef / this.width);
      for (const offset of this.diskOffsets) {
        const centerX = tileX - offset.dx;
        const centerY = tileY - offset.dy;
        if (
          centerX < 0 ||
          centerX >= this.width ||
          centerY < 0 ||
          centerY >= this.height
        ) {
          continue;
        }
        callback(centerY * this.width + centerX);
      }
    }

    _forEachAffectedFrontierCenter(tileRef, callback) {
      const tileX = tileRef % this.width;
      const tileY = Math.floor(tileRef / this.width);
      for (const offset of this.frontierOffsets) {
        const centerX = tileX - offset.dx;
        const centerY = tileY - offset.dy;
        if (
          centerX < 0 ||
          centerX >= this.width ||
          centerY < 0 ||
          centerY >= this.height
        ) {
          continue;
        }
        callback(centerY * this.width + centerX);
      }
    }

    _applyCellStateDelta(tileRef, delta) {
      const {
        oldValid,
        newValid,
        oldPlains,
        newPlains,
        oldExpansionValue = 0,
        newExpansionValue = 0,
      } = delta;
      if (
        oldValid === newValid &&
        oldPlains === newPlains &&
        oldExpansionValue === newExpansionValue
      ) return;
      this._forEachAffectedCenter(tileRef, (centerRef) => {
        // During an incremental build, centers before the cursor already have
        // counters and must receive the delta. Centers after it will be built
        // from the current terrain/occupancy snapshot, so changing them here
        // would double-apply the update when their turn arrives.
        if (!this.ready && centerRef >= this._buildCursor) return;
        if (oldValid !== newValid) {
          if (newValid) {
            this.spawnGain[centerRef] += 1;
            this.invalidCount[centerRef] -= 1;
          } else {
            this.spawnGain[centerRef] -= 1;
            this.invalidCount[centerRef] += 1;
          }
        }
        if (oldPlains !== newPlains) {
          if (newPlains) this.plainsGain[centerRef] += 1;
          else this.plainsGain[centerRef] -= 1;
        }
      });

      this._forEachAffectedFrontierCenter(tileRef, (centerRef) => {
        if (!this.ready && centerRef >= this._buildCursor) return;
        if (oldValid !== newValid) {
          if (newValid) this.frontierGain[centerRef] += 1;
          else this.frontierGain[centerRef] -= 1;
        }
        if (oldPlains !== newPlains) {
          if (newPlains) this.frontierPlainsGain[centerRef] += 1;
          else this.frontierPlainsGain[centerRef] -= 1;
        }
        if (oldExpansionValue !== newExpansionValue) {
          this.frontierValueGain[centerRef] += newExpansionValue - oldExpansionValue;
        }
      });
    }

    _measureSpawnDisk(centerX, centerY) {
      let spawnGain = 0;
      let plainsGain = 0;
      let invalidCount = 0;
      for (const offset of this.diskOffsets) {
        const x = centerX + offset.dx;
        const y = centerY + offset.dy;
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
        const ref = y * this.width + x;
        if (this._cellValid(ref)) {
          spawnGain += 1;
          if (isPlainsTerrainByte(this.terrain[ref], this.impassableMagnitude)) {
            plainsGain += 1;
          }
        } else {
          invalidCount += 1;
        }
      }
      return { spawnGain, plainsGain, invalidCount };
    }

    _measureSpawnFrontier(centerX, centerY) {
      let frontierGain = 0;
      let frontierPlainsGain = 0;
      let frontierValueGain = 0;
      let frontierSlots = 0;
      for (const offset of this.frontierOffsets) {
        const x = centerX + offset.dx;
        const y = centerY + offset.dy;
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
        frontierSlots += 1;
        const ref = y * this.width + x;
        if (!this._cellValid(ref)) continue;
        frontierGain += 1;
        frontierValueGain += terrainExpansionValue(
          this.terrain[ref],
          this.impassableMagnitude,
        );
        if (isPlainsTerrainByte(this.terrain[ref], this.impassableMagnitude)) {
          frontierPlainsGain += 1;
        }
      }
      return { frontierGain, frontierPlainsGain, frontierValueGain, frontierSlots };
    }

    _buildCenter(centerRef) {
      const centerX = centerRef % this.width;
      const centerY = Math.floor(centerRef / this.width);
      const disk = this._measureSpawnDisk(centerX, centerY);
      const frontier = this._measureSpawnFrontier(centerX, centerY);
      this.spawnGain[centerRef] = disk.spawnGain;
      this.plainsGain[centerRef] = disk.plainsGain;
      this.invalidCount[centerRef] = disk.invalidCount;
      this.frontierGain[centerRef] = frontier.frontierGain;
      this.frontierPlainsGain[centerRef] = frontier.frontierPlainsGain;
      this.frontierValueGain[centerRef] = frontier.frontierValueGain;
      this.frontierSlots[centerRef] = frontier.frontierSlots;
    }

    // Build a bounded number of centers. Callers can pass a small number from
    // requestIdleCallback and yield between slices; tests and adapters may use
    // buildAll() when a synchronous snapshot is acceptable.
    buildSlice(maxCenters = 256) {
      if (this.ready) return { done: true, processed: 0 };
      const amount = Math.max(1, Math.floor(Number(maxCenters) || 1));
      const end = Math.min(this.size, this._buildCursor + amount);
      const start = this._buildCursor;
      for (; this._buildCursor < end; this._buildCursor += 1) {
        this._buildCenter(this._buildCursor);
      }
      if (this._buildCursor >= this.size) {
        this.ready = true;
        this.version += 1;
      }
      return { done: this.ready, processed: end - start };
    }

    buildAll() {
      while (!this.ready) this.buildSlice(this.size);
      return this;
    }

    updateTerrain(ref, byte) {
      if (!this._isValidRef(ref)) return false;
      const nextByte = Number(byte) & 0xff;
      const previousByte = this.terrain[ref];
      if (previousByte === nextByte) return false;
      const oldValid = this._cellValid(ref);
      const oldPlains = oldValid && isPlainsTerrainByte(previousByte, this.impassableMagnitude);
      const oldExpansionValue = oldValid
        ? terrainExpansionValue(previousByte, this.impassableMagnitude)
        : 0;
      this.terrain[ref] = nextByte;
      const newValid = this._cellValid(ref);
      const newPlains = newValid && isPlainsTerrainByte(nextByte, this.impassableMagnitude);
      const newExpansionValue = newValid
        ? terrainExpansionValue(nextByte, this.impassableMagnitude)
        : 0;
      this._applyCellStateDelta(ref, {
        oldValid,
        newValid,
        oldPlains,
        newPlains,
        oldExpansionValue,
        newExpansionValue,
      });
      this.version += 1;
      return true;
    }

    updateBlocked(ref, blocked) {
      if (!this._isValidRef(ref)) return false;
      const nextBlocked = blocked ? 1 : 0;
      const previousBlocked = this.blocked[ref];
      if (previousBlocked === nextBlocked) return false;
      const oldValid = this._cellValid(ref);
      const oldPlains = oldValid && isPlainsTerrainByte(this.terrain[ref], this.impassableMagnitude);
      const oldExpansionValue = oldValid
        ? terrainExpansionValue(this.terrain[ref], this.impassableMagnitude)
        : 0;
      this.blocked[ref] = nextBlocked;
      const newValid = this._cellValid(ref);
      const newPlains = newValid && isPlainsTerrainByte(this.terrain[ref], this.impassableMagnitude);
      const newExpansionValue = newValid
        ? terrainExpansionValue(this.terrain[ref], this.impassableMagnitude)
        : 0;
      this._applyCellStateDelta(ref, {
        oldValid,
        newValid,
        oldPlains,
        newPlains,
        oldExpansionValue,
        newExpansionValue,
      });
      this.version += 1;
      return true;
    }

    // Synchronize only the supplied refs when a tile-update event identifies
    // them. Without refs, the full scan is intentionally explicit: callers
    // should use it only at map load or when the game reports a terrain revision.
    _syncAllTerrain(readByte) {
      let changed = 0;
      for (let ref = 0; ref < this.size; ref += 1) {
        if (this.updateTerrain(ref, readByte(ref))) changed += 1;
      }
      return changed;
    }

    _syncTerrainRefs(readByte, refs) {
      let changed = 0;
      for (const ref of refs) {
        if (this.updateTerrain(ref, readByte(ref))) changed += 1;
      }
      return changed;
    }

    syncTerrain(source, refs = null) {
      const readByte =
        typeof source === "function"
          ? source
          : (ref) => source[ref];
      return refs == null
        ? this._syncAllTerrain(readByte)
        : this._syncTerrainRefs(readByte, refs);
    }

    getCandidate(ref, options = {}) {
      if (!this.ready || !this._isValidRef(ref)) return null;
      if (!this._cellValid(ref)) return null;
      const mode = options.mode === "random" ? "random" : "explicit";
      if (mode === "random" && this.invalidCount[ref] !== 0) return null;
      if (mode === "explicit" && this.spawnGain[ref] === 0) return null;
      const x = ref % this.width;
      const y = Math.floor(ref / this.width);
      if (options.isCenterAllowed && !options.isCenterAllowed(ref, x, y)) return null;
      return {
        ref,
        x,
        y,
        spawnGain: this.spawnGain[ref],
        plainsGain: this.plainsGain[ref],
        invalidCount: this.invalidCount[ref],
        frontierGain: this.frontierGain[ref],
        frontierPlainsGain: this.frontierPlainsGain[ref],
        frontierValueGain: this.frontierValueGain[ref],
        frontierSlots: this.frontierSlots[ref],
      };
    }

    _candidateRangeAllowed(ref, mode, isCenterAllowed) {
      if (!this._cellValid(ref)) return false;
      if (mode === "random" && this.invalidCount[ref] !== 0) return false;
      if (mode === "explicit" && this.spawnGain[ref] === 0) return false;
      if (!isCenterAllowed) return true;
      return isCenterAllowed(ref, ref % this.width, Math.floor(ref / this.width));
    }

    forEachCandidateRange(options = {}) {
      if (!this.ready || typeof options.onCandidate !== "function") return 0;
      const mode = options.mode === "random" ? "random" : "explicit";
      const start = Math.max(0, Math.min(this.size, Math.floor(Number(options.startRef) || 0)));
      const end = Math.max(
        start,
        Math.min(
          this.size,
          Number.isFinite(Number(options.endRef))
            ? Math.floor(Number(options.endRef))
            : this.size,
        ),
      );
      let count = 0;
      for (let ref = start; ref < end; ref += 1) {
        if (!this._candidateRangeAllowed(ref, mode, options.isCenterAllowed)) continue;
        const x = ref % this.width;
        const y = Math.floor(ref / this.width);
        options.onCandidate(
          ref,
          x,
          y,
          this.spawnGain[ref],
          this.invalidCount[ref],
          this.plainsGain[ref],
          this.frontierGain[ref],
          this.frontierPlainsGain[ref],
          this.frontierValueGain[ref],
          this.frontierSlots[ref],
        );
        count += 1;
      }
      return count;
    }

    forEachCandidate(options = {}) {
      return this.forEachCandidateRange(options);
    }

    stats() {
      let candidateCount = 0;
      if (this.ready) {
        for (let ref = 0; ref < this.size; ref += 1) {
          if (this.getCandidate(ref) !== null) candidateCount += 1;
        }
      }
      return {
        width: this.width,
        height: this.height,
        size: this.size,
        ready: this.ready,
        builtCenters: this._buildCursor,
        candidateCount,
        diskSize: this.diskOffsets.length,
        version: this.version,
      };
    }
  }

  const api = {
    DEFAULT_SPAWN_RADIUS,
    DEFAULT_IMPASSABLE_MAGNITUDE,
    FRONTIER_VALUE_SCALE,
    buildSpawnDiskOffsets,
    create: (options) => new SpawnCandidateIndex(options),
    isValidTerrainByte,
    safePressureScore,
  };

  const spawnIndexRoot = typeof globalThis === "object" ? globalThis : window;
  spawnIndexRoot.__OFHSpawnIndex = api;
}
