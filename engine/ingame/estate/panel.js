  function ensureEstatePanel() {
    ensureEstatePanelStyles();
    let panel = document.getElementById(ESTATE_PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createElement("div");
    panel.id = ESTATE_PANEL_ID;

    const header = document.createElement("div");
    header.className = "est-header";
    const title = document.createElement("span");
    title.className = "est-title";
    title.textContent = tr("Estates");
    const count = document.createElement("span");
    count.className = "est-count";
    header.append(title, count);

    const table = document.createElement("div");
    table.className = "est-table";
    // Sticky header row: # + Tiles (Tiles sortable).
    const hRank = document.createElement("span");
    hRank.className = "est-cell est-head est-rank";
    hRank.textContent = "#";
    const hTiles = document.createElement("span");
    hTiles.className = "est-cell est-head est-tiles est-sortable";
    hTiles.title = tr("Tiles");
    hTiles.addEventListener("click", () => {
      estateSortDir = estateSortDir === 1 ? -1 : 1;
      renderEstatePanel();
    });
    table.append(hRank, hTiles);

    panel.append(header, table);
    (document.body || document.documentElement).appendChild(panel);
    makeGoldStatPanelDraggable(panel, header, ESTATE_PANEL_POS_KEY);
    applyStoredGoldStatPanelPosition(panel, ESTATE_PANEL_POS_KEY);
    return panel;
  }

  function getEstateRow(table, estate) {
    let entry = estateRowCache.get(estate.key);
    if (!entry) {
      const rowEl = document.createElement("div");
      rowEl.className = "est-row";
      const rank = document.createElement("span");
      rank.className = "est-cell est-rank";
      const tiles = document.createElement("span");
      tiles.className = "est-cell est-tiles";
      rowEl.append(rank, tiles);
      entry = { row: rowEl, cells: { rank, tiles }, cx: estate.cx, cy: estate.cy };
      // Click → pan the camera to this parcel's centre.
      rowEl.addEventListener("click", () => {
        {
          const transform = getOpenFrontGameContext()?.transform;
          if (transform && typeof transform.onGoToPosition === "function") {
            transform.onGoToPosition({ x: entry.cx, y: entry.cy });
          }
        }
      });
      estateRowCache.set(estate.key, entry);
      table.appendChild(rowEl);
    }
    return entry;
  }

  function renderEstatePanel() {
    const panel = document.getElementById(ESTATE_PANEL_ID);
    if (!panel) {
      return;
    }
    const inGame = Boolean(getOpenFrontGameContext()?.game);
    const shouldShow = estatePanelOpen && inGame && estateData.length > 0;
    panel.dataset.visible = shouldShow ? "true" : "false";
    if (!shouldShow) {
      return;
    }

    const table = panel.querySelector(".est-table");
    if (!table) {
      return;
    }

    // Sort a copy; default = most tiles first.
    const sorted = estateData
      .slice()
      .sort((a, b) => (estateSortDir === 1 ? b.tiles - a.tiles : a.tiles - b.tiles));

    // Header sort arrow.
    const hTiles = table.querySelector(".est-head.est-tiles");
    if (hTiles) {
      hTiles.textContent = tr("Tiles");
      const arrow = document.createElement("span");
      arrow.className = "est-sort-arrow";
      arrow.textContent = estateSortDir === 1 ? "▾" : "▴";
      hTiles.appendChild(arrow);
    }

    const count = panel.querySelector(".est-count");
    if (count) {
      count.textContent = String(sorted.length);
    }

    const seen = new Set();
    for (let i = 0; i < sorted.length; i += 1) {
      const estate = sorted[i];
      seen.add(estate.key);
      const entry = getEstateRow(table, estate);
      entry.cx = estate.cx; // refresh centre for click-to-focus
      entry.cy = estate.cy;
      entry.cells.rank.textContent = String(i + 1);
      entry.cells.tiles.textContent = String(estate.tiles);
      table.appendChild(entry.row); // move into sorted order (after header)
    }
    for (const [key, entry] of estateRowCache) {
      if (!seen.has(key)) {
        entry.row.remove();
        estateRowCache.delete(key);
      }
    }
  }

