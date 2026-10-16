  // Flood-fill the player's owned tiles into connected components. Seeds are the
  // border tiles (every component has a border); each owned tile is visited once.
  function computeEstateComponent(game, seed, mySmallId, visited) {
    visited.add(seed);
    const stack = [seed];
    const neighborBuffer = typeof game.neighbors4 === "function" ? [0, 0, 0, 0] : null;
    let size = 0;
    let sumX = 0;
    let sumY = 0;
    let minRef = seed;
    while (stack.length > 0) {
      const tile = stack.pop();
      size += 1;
      sumX += game.x(tile);
      sumY += game.y(tile);
      if (tile < minRef) minRef = tile;
      const neighbors = neighborBuffer || game.neighbors(tile);
      const count = neighborBuffer ? game.neighbors4(tile, neighborBuffer) : neighbors.length;
      for (let i = 0; i < count; i += 1) {
        const neighbor = neighbors[i];
        if (visited.has(neighbor)) continue;
        if (Number(game.ownerID(neighbor)) !== mySmallId) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    return {
      key: String(minRef),
      tiles: size,
      cx: sumX / size,
      cy: sumY / size,
    };
  }

  function computeEstateComponents(game, borderTiles, mySmallId) {
    const visited = new Set();
    const components = [];
    for (const seed of borderTiles) {
      if (visited.has(seed)) continue;
      components.push(computeEstateComponent(game, seed, mySmallId, visited));
    }
    return components;
  }

