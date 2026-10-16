// Estates panel: lists each separate parcel of land you own — a "parcel" is a
// connected component of your owned tiles (orthogonally adjacent via the game's
// neighbours). A lone tile (e.g. a boat landing isolated in the wild) counts as
// its own parcel. Click a column to sort, click a row to pan the camera there.
//
// Seeds come from player.borderTiles() (async worker call); the flood-fill that
// counts each component is client-side & synchronous (game.neighbors / ownerID).
// Recomputed on a throttle while the panel is open, never per frame.

  const ESTATE_PANEL_ID = "openfront-helper-estate-panel";
  const ESTATE_PANEL_STYLE_ID = "openfront-helper-estate-panel-styles";
  const ESTATE_PANEL_POS_KEY = "openfrontHelperEstatePanelPos";
  const ESTATE_COMPUTE_MS = 2500;

  let estatePanelOpen = false;
  let estateSortDir = 1; // 1 = most tiles first, -1 = fewest first
  let estateData = []; // [{ key, tiles, cx, cy }]
  let estateComputing = false;

  function setEstateComputing(value) {
    estateComputing = value;
  }
  let estateIntervalId = null;
  const estateRowCache = new Map(); // key -> { row, cells:{rank,tiles} }

