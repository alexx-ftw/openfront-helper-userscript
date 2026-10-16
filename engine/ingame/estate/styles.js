  function ensureEstatePanelStyles() {
    if (document.getElementById(ESTATE_PANEL_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = ESTATE_PANEL_STYLE_ID;
    style.textContent = `
      #${ESTATE_PANEL_ID} {
        position: fixed;
        right: 14px;
        top: 770px;
        z-index: 9000;
        display: none;
        flex-direction: column;
        width: 178px;
        height: 240px;
        min-width: 140px;
        min-height: 110px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        resize: both;
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, 0.34);
        border-radius: 8px;
        background: rgba(12, 18, 20, 0.95);
        color: #e2e8f0;
        font: 700 11px/1.15 "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4), 0 0 16px rgba(148, 163, 184, 0.1);
        pointer-events: auto;
      }
      #${ESTATE_PANEL_ID}[data-visible="true"] { display: flex; }

      #${ESTATE_PANEL_ID} .est-header {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        cursor: grab;
        touch-action: none;
      }
      #${ESTATE_PANEL_ID} .est-header:active { cursor: grabbing; }
      #${ESTATE_PANEL_ID} .est-title {
        flex: 1;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        color: rgba(226, 232, 240, 0.85);
      }
      #${ESTATE_PANEL_ID} .est-count {
        font-size: 10px;
        font-weight: 900;
        color: rgba(148, 163, 184, 0.85);
      }

      #${ESTATE_PANEL_ID} .est-table {
        flex: 1;
        min-height: 0;
        overflow: auto;
        display: grid;
        grid-template-columns: 40px minmax(0, 1fr);
        align-content: start;
        grid-auto-rows: 26px;
      }
      #${ESTATE_PANEL_ID} .est-row { display: contents; }
      #${ESTATE_PANEL_ID} .est-cell {
        padding: 0 8px;
        line-height: 25px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
        border-bottom: 1px solid rgba(148, 163, 184, 0.08);
      }
      #${ESTATE_PANEL_ID} .est-rank { color: rgba(148, 163, 184, 0.72); }
      #${ESTATE_PANEL_ID} .est-tiles { text-align: right; }
      #${ESTATE_PANEL_ID} .est-head {
        position: sticky;
        top: 0;
        z-index: 1;
        background: rgba(16, 22, 24, 0.98);
        color: rgba(226, 232, 240, 0.72);
        font-size: 10px;
        text-transform: uppercase;
        border-bottom: 1px solid rgba(148, 163, 184, 0.22);
      }
      #${ESTATE_PANEL_ID} .est-head.est-sortable { cursor: pointer; }
      #${ESTATE_PANEL_ID} .est-head.est-sortable:hover { color: #fff; }
      #${ESTATE_PANEL_ID} .est-sort-arrow { font-size: 8px; margin-left: 2px; }
      #${ESTATE_PANEL_ID} .est-row .est-cell { cursor: pointer; }
      #${ESTATE_PANEL_ID} .est-row:hover .est-cell { background: rgba(148, 163, 184, 0.18); }
      #${ESTATE_PANEL_ID} .est-empty {
        grid-column: 1 / -1;
        padding: 12px;
        text-align: center;
        color: rgba(226, 232, 240, 0.55);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

