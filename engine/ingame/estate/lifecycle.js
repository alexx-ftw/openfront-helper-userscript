  async function refreshEstates() {
    if (!estatePanelOpen || estateComputing) {
      return;
    }
    const context = getOpenFrontGameContext();
    const game = context?.game;
    if (!game) {
      estateData = [];
      renderEstatePanel();
      return;
    }
    let me;
    {
      me = game.myPlayer?.();
    }
    if (!me?.isPlayer?.()) {
      estateData = [];
      renderEstatePanel();
      return;
    }

    setEstateComputing(true);
    try {
      const mySmallId = Number(me.smallID());
      const result = await me.borderTiles();
      const borderTiles = result?.borderTiles;
      if (!borderTiles || !estatePanelOpen) {
        return;
      }
      estateData = computeEstateComponents(game, borderTiles, mySmallId);
      renderEstatePanel();
    } finally {
      setEstateComputing(false);
    }
  }

  function setEstatePanelEnabled(enabled) {
    estatePanelOpen = Boolean(enabled);
    if (estatePanelOpen) {
      ensureEstatePanel();
      if (estateIntervalId === null) {
        estateIntervalId = window.setInterval(refreshEstates, ESTATE_COMPUTE_MS);
      }
      refreshEstates();
    } else {
      if (estateIntervalId !== null) {
        clearInterval(estateIntervalId);
        estateIntervalId = null;
      }
      estateData = [];
      for (const [, entry] of estateRowCache) {
        entry.row.remove();
      }
      estateRowCache.clear();
      const panel = document.getElementById(ESTATE_PANEL_ID);
      if (panel) {
        panel.dataset.visible = "false";
      }
    }
  }
