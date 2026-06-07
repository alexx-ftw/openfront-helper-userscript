// Auto-Bot — floating control panel UI (control/log tabs, sliders, drag).

"use strict";

  // =========================================================================
  // Floating control panel
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        --ab-accent: #34d399;
        --ab-accent-2: #22d3ee;
        --ab-border: rgba(52, 211, 153, 0.26);
        --ab-surface: rgba(255, 255, 255, 0.05);
        --ab-surface-2: rgba(255, 255, 255, 0.09);
        --ab-muted: #8ba0a0;
        position: fixed;
        z-index: 2147483646;
        width: 244px;
        bottom: 16px;
        right: 16px;
        background:
          radial-gradient(130% 90% at 100% 0%, rgba(34, 211, 238, 0.09), transparent 55%),
          linear-gradient(180deg, rgba(13, 26, 24, 0.97), rgba(8, 14, 17, 0.98));
        border: 1px solid var(--ab-border);
        border-radius: 14px;
        box-shadow: 0 22px 50px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(187, 247, 208, 0.1);
        color: #e8eef0;
        font: 500 12px/1.45 "Aptos", system-ui, -apple-system, "Segoe UI", sans-serif;
        user-select: none;
        overflow: hidden;
        backdrop-filter: blur(10px) saturate(125%);
      }
      #${PANEL_ID} .ab-head {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; cursor: grab;
        background: rgba(52,211,153,0.07);
        border-bottom: 1px solid rgba(52,211,153,0.12);
      }
      #${PANEL_ID} .ab-head:active { cursor: grabbing; }
      #${PANEL_ID} .ab-title { font-weight: 700; font-size: 12px; letter-spacing: 0.2px; flex: 1; }
      #${PANEL_ID} .ab-head-btns { display: flex; align-items: center; gap: 1px; }
      #${PANEL_ID} .ab-mini, #${PANEL_ID} .ab-close {
        background: transparent; border: none; color: var(--ab-muted);
        cursor: pointer; font-size: 13px; line-height: 1; width: 20px; height: 20px;
        border-radius: 6px; display: grid; place-items: center; transition: .14s;
      }
      #${PANEL_ID} .ab-mini:hover { color: #fff; background: var(--ab-surface-2); }
      #${PANEL_ID} .ab-close:hover { color: #fca5a5; background: rgba(248,113,113,0.15); }
      #${PANEL_ID} .ab-switch {
        position: relative; width: 36px; height: 20px; border-radius: 999px;
        background: rgba(120,130,130,.3); cursor: pointer; transition: .18s; flex: none;
        border: 1px solid rgba(255,255,255,.08);
      }
      #${PANEL_ID} .ab-switch.on {
        background: linear-gradient(135deg, var(--ab-accent), #10b981);
        border-color: rgba(187,247,208,.5);
      }
      #${PANEL_ID} .ab-switch::after {
        content: ""; position: absolute; top: 2px; left: 2px;
        width: 14px; height: 14px; border-radius: 50%; background: #fff;
        transition: transform .18s; box-shadow: 0 1px 3px rgba(0,0,0,.4);
      }
      #${PANEL_ID} .ab-switch.on::after { transform: translateX(16px); }
      #${PANEL_ID} .ab-body { padding: 9px 10px 10px; }
      #${PANEL_ID}.ab-collapsed .ab-body { display: none; }
      #${PANEL_ID}.ab-collapsed .ab-tabs { display: none; }
      #${PANEL_ID} .ab-gate {
        display: flex; align-items: center; justify-content: center; gap: 7px;
        font-weight: 700; font-size: 11px; padding: 7px 10px; border-radius: 9px;
        margin-bottom: 11px; border: 1px solid transparent;
      }
      #${PANEL_ID} .ab-gate::before {
        content: ""; width: 7px; height: 7px; border-radius: 50%; flex: none;
        background: currentColor; box-shadow: 0 0 8px currentColor;
      }
      #${PANEL_ID} .ab-gate.ok { background: rgba(34,197,94,0.14); color: #86efac; border-color: rgba(134,239,172,.28); }
      #${PANEL_ID} .ab-gate.bad { background: rgba(239,68,68,0.16); color: #fca5a5; border-color: rgba(248,113,113,.3); }
      #${PANEL_ID} .ab-gate.wait { background: rgba(148,163,184,0.12); color: #cbd5e1; border-color: rgba(148,163,184,.2); }
      #${PANEL_ID} .ab-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 5px 0;
      }
      #${PANEL_ID} .ab-feat {
        display: flex; align-items: center; gap: 9px; cursor: pointer;
        padding: 8px 9px; border-radius: 9px; transition: background 0.12s;
      }
      #${PANEL_ID} .ab-feat:hover { background: var(--ab-surface); }
      #${PANEL_ID} .ab-adv-toggle {
        cursor: pointer; color: #cdd8d8; font-size: 11px; font-weight: 600;
        padding: 7px 9px; border-radius: 7px; transition: .12s; letter-spacing: .2px;
        background: var(--ab-surface); margin-top: 4px;
      }
      #${PANEL_ID} .ab-adv-toggle:hover { background: var(--ab-surface-2); color: #fff; }
      #${PANEL_ID} .ab-feats-grid {
        display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px;
        max-height: 0; overflow: hidden; transition: max-height 0.24s ease;
      }
      #${PANEL_ID} .ab-feats-grid.open { max-height: 200px; margin: 4px 0 2px; }
      #${PANEL_ID} .ab-feat-mini {
        position: relative; flex-direction: column; align-items: center; justify-content: center;
        gap: 3px; padding: 7px 2px; border-radius: 8px; background: var(--ab-surface);
        border: 1px solid transparent; opacity: 0.5; transition: .12s;
      }
      #${PANEL_ID} .ab-feat-mini:hover { background: var(--ab-surface-2); opacity: 0.85; }
      #${PANEL_ID} .ab-feat-mini.on { opacity: 1; border-color: rgba(52,211,153,.45); background: rgba(52,211,153,.14); }
      #${PANEL_ID} .ab-feat-mini .ab-feat-emoji { font-size: 16px; line-height: 1; transition: filter .14s; }
      #${PANEL_ID} .ab-feat-mini.on .ab-feat-emoji { filter: drop-shadow(0 0 5px rgba(52,211,153,.85)); }
      .ab-feat-tip {
        position: fixed; z-index: 2147483647; transform: translate(-50%, -100%);
        padding: 7px 10px; border-radius: 8px; pointer-events: none;
        background: rgba(8,14,17,0.98); border: 1px solid rgba(52,211,153,0.35);
        color: #e8eef0; font: 500 11px/1.4 "Aptos", system-ui, sans-serif;
        white-space: normal; max-width: 220px; text-align: center;
        box-shadow: 0 8px 22px rgba(0,0,0,0.5); opacity: 0; transition: opacity 0.12s;
      }
      .ab-feat-tip b { color: #6ee7b7; font-weight: 800; }
      .ab-feat-tip.show { opacity: 1; }
      #${PANEL_ID} .ab-status {
        display: none; margin-top: 6px; padding: 11px; border-radius: 11px;
        background: var(--ab-surface); border: 1px solid rgba(255,255,255,.05); font-size: 11px;
      }
      #${PANEL_ID} .ab-status.open { display: block; }
      #${PANEL_ID} .ab-status .ab-st-line { color: #dce6e6; font-weight: 600; }
      #${PANEL_ID} .ab-status .ab-st-act { color: #fcd34d; margin-top: 4px; font-size: 10.5px; }
      #${PANEL_ID} .ab-stats {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px;
      }
      #${PANEL_ID} .ab-stat {
        background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.05);
        border-radius: 9px; padding: 7px 4px; text-align: center;
      }
      #${PANEL_ID} .ab-stat b { display: block; color: var(--ab-accent); font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; }
      #${PANEL_ID} .ab-stat span { color: var(--ab-muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px; }
      #${PANEL_ID} .ab-tabs {
        display: flex; gap: 4px; padding: 8px 10px 0;
      }
      #${PANEL_ID} .ab-tab {
        flex: none; cursor: pointer; padding: 4px 11px;
        font-size: 10px; font-weight: 700; color: var(--ab-muted);
        border-radius: 7px; border: 1px solid transparent;
        transition: color 0.14s, background 0.14s;
      }
      #${PANEL_ID} .ab-tab:hover { color: #fff; background: var(--ab-surface); }
      #${PANEL_ID} .ab-tab.on {
        color: #06281f; background: linear-gradient(135deg, var(--ab-accent), #10b981);
        box-shadow: 0 4px 12px rgba(16,185,129,.25);
      }
      #${PANEL_ID} .ab-pane[data-pane="log"] { display: none; }
      #${PANEL_ID}.ab-tab-log .ab-pane[data-pane="control"] { display: none; }
      #${PANEL_ID}.ab-tab-log .ab-pane[data-pane="log"] { display: block; }
      #${PANEL_ID} .ab-log-filters {
        display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;
      }
      #${PANEL_ID} .ab-chip {
        cursor: pointer; padding: 3px 7px; border-radius: 999px;
        font-size: 10px; font-weight: 700; color: #cbd5e1;
        background: rgba(255,255,255,0.05); border: 1px solid transparent;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      #${PANEL_ID} .ab-chip:hover { background: rgba(255,255,255,0.09); }
      #${PANEL_ID} .ab-chip.on {
        background: rgba(34,197,94,0.18); color: #86efac;
        border-color: rgba(74,222,128,0.4);
      }
      #${PANEL_ID} .ab-log-list {
        max-height: 240px; overflow-y: auto; display: flex; flex-direction: column;
        gap: 1px; font-variant-numeric: tabular-nums;
      }
      #${PANEL_ID} .ab-log-list::-webkit-scrollbar { width: 7px; }
      #${PANEL_ID} .ab-log-list::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.14); border-radius: 4px;
      }
      #${PANEL_ID} .ab-log-item {
        display: flex; gap: 6px; align-items: baseline; padding: 3px 5px;
        border-radius: 5px; line-height: 1.3;
      }
      #${PANEL_ID} .ab-log-item:nth-child(odd) { background: rgba(255,255,255,0.03); }
      #${PANEL_ID} .ab-log-time { color: #6b7280; font-size: 10px; flex: none; }
      #${PANEL_ID} .ab-log-text { color: #e5e7eb; font-size: 11px; word-break: break-word; }
      #${PANEL_ID} .ab-log-empty { color: #6b7280; font-size: 11px; text-align: center; padding: 16px 0; }
    `;
    document.head.appendChild(style);
  }

  // key -> [label, detailed description] for the hover tooltip. Descriptions
  // reuse the popup's strings so they share translations.
  const FEAT_TIP = {
    spawn: ["Auto-spawn", "Automatically pick a spawn tile."],
    expand: ["Auto-expand / attack", "Expand into land and attack targets."],
    boat: ["Auto-landing (1% boat)", "Send probe and landing boats overseas."],
    warship: ["Auto-deploy warships", "Build and dispatch warships."],
    build: ["Auto-build", "Build and upgrade structures."],
    nuke: ["Auto-launch nukes", "Fire nukes at high-value targets."],
    alliance: ["Auto-accept alliances", "Send and accept alliance requests."],
    donate: ["Auto-donate troops (allies)", "Donate troops to needy allies."],
    betray: ["Auto-betray allies", "Off = stay loyal (defensive retaliation only)."],
  };

  function featRow(key, label, emoji) {
    const on = state.settings.features[key];
    // Compact icon tile (5-per-row). No checkmark — when ON the icon lights up
    // (full opacity + glow). Label + detailed description show on hover.
    return `
      <div class="ab-feat ab-feat-mini ${on ? "on" : ""}" data-feat="${key}">
        <span class="ab-feat-emoji">${emoji}</span>
      </div>`;
  }

  function buildPanel() {
    ensureStyles();
    let panel = document.getElementById(PANEL_ID);
    // X-closed: keep the panel out of the DOM (the lifecycle watcher calls
    // buildPanel() every ~1.2s, so this also stops it from coming back).
    if (state.settings.hidden) {
      if (panel) panel.remove();
      return null;
    }
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    if (state.settings.minimized) panel.classList.add("ab-collapsed");
    if (state.activeTab === "log") panel.classList.add("ab-tab-log");
    panel.innerHTML = `
      <div class="ab-head">
        <span class="ab-title">Auto-Bot</span>
        <div class="ab-switch ${state.settings.enabled ? "on" : ""}" data-role="switch" title="${tr("Toggle on/off")}"></div>
        <div class="ab-head-btns">
          <button class="ab-mini" data-role="mini" title="${tr("Collapse")}">${state.settings.minimized ? "▢" : "—"}</button>
          <button class="ab-close" data-role="close" title="${tr("Close")}">✕</button>
        </div>
      </div>
      <div class="ab-tabs">
        <div class="ab-tab ${state.activeTab === "control" ? "on" : ""}" data-tab="control">${tr("🎮 Controls")}</div>
        <div class="ab-tab ${state.activeTab === "log" ? "on" : ""}" data-tab="log">${tr("📜 Log")}</div>
      </div>
      <div class="ab-body">
        <div class="ab-pane" data-pane="control">
          <div class="ab-gate wait" data-role="gate">${tr("Checking lobby…")}</div>
          <div class="ab-adv-toggle" data-role="feats-toggle">${
            state.settings.featsOpen
              ? tr("Auto toggles ▴")
              : tr("Auto toggles ▾")
          }</div>
          <div class="ab-feats-grid ${state.settings.featsOpen ? "open" : ""}" data-role="feats">
            ${featRow("spawn", "Auto-spawn", "🏁")}
            ${featRow("expand", "Auto-expand / attack", "⚔️")}
            ${featRow("boat", "Auto-landing (1% boat)", "⛵")}
            ${featRow("warship", "Auto-deploy warships", "🚢")}
            ${featRow("build", "Auto-build", "🏗️")}
            ${featRow("nuke", "Auto-launch nukes", "☢️")}
            ${featRow("alliance", "Auto-accept alliances", "🤝")}
            ${featRow("donate", "Auto-donate troops (allies)", "🎁")}
            ${featRow("betray", "Auto-betray allies", "🗡️")}
          </div>
          <div class="ab-adv-toggle" data-role="status-toggle">${
            state.settings.statusOpen
              ? tr("Status & stats ▴")
              : tr("Status & stats ▾")
          }</div>
          <div class="ab-status ${state.settings.statusOpen ? "open" : ""}" data-role="status-wrap">
            <div class="ab-st-line" data-role="status">—</div>
            <div class="ab-st-act" data-role="lastaction">—</div>
            <div class="ab-stats">
              <div class="ab-stat"><b data-role="s-troops">0</b><span>${tr("Troops")}</span></div>
              <div class="ab-stat"><b data-role="s-gold">0</b><span>${tr("Gold")}</span></div>
              <div class="ab-stat"><b data-role="s-tiles">0</b><span>${tr("Tiles")}</span></div>
            </div>
            <div class="ab-stats" style="grid-template-columns: repeat(4, 1fr);">
              <div class="ab-stat"><b data-role="c-spawns">0</b><span>${tr("Spawn")}</span></div>
              <div class="ab-stat"><b data-role="c-attacks">0</b><span>${tr("Attacks")}</span></div>
              <div class="ab-stat"><b data-role="c-builds">0</b><span>${tr("Builds")}</span></div>
              <div class="ab-stat"><b data-role="c-nukes">0</b><span>${tr("Nukes")}</span></div>
            </div>
          </div>
        </div>
        <div class="ab-pane" data-pane="log">
          <div class="ab-log-filters" data-role="log-filters">
            <div class="ab-chip ${state.logFilter === "all" ? "on" : ""}" data-filter="all">${tr("All")}</div>
            ${Object.entries(LOG_CATS)
              .map(
                ([key, c]) =>
                  `<div class="ab-chip ${state.logFilter === key ? "on" : ""}" data-filter="${key}">${c.emoji} ${tr(c.label)}</div>`,
              )
              .join("")}
          </div>
          <div class="ab-log-list" data-role="log-list"></div>
        </div>
      </div>`;

    document.body.appendChild(panel);
    wirePanel(panel);
    applyStoredPosition(panel);
    return panel;
  }

  function wirePanel(panel) {
    // master switch
    panel.querySelector('[data-role="switch"]').addEventListener("click", () => {
      setEnabled(!state.settings.enabled);
    });

    // minimize
    panel.querySelector('[data-role="mini"]').addEventListener("click", () => {
      state.settings.minimized = !state.settings.minimized;
      panel.classList.toggle("ab-collapsed", state.settings.minimized);
      panel.querySelector('[data-role="mini"]').textContent = state.settings.minimized
        ? "▢"
        : "—";
      saveSettings();
    });

    // close (hide whole panel; re-show from the popup Auto Bot tab)
    panel.querySelector('[data-role="close"]').addEventListener("click", () => {
      state.settings.hidden = true;
      saveSettings();
      panel.remove();
    });

    // feature toggles
    panel.querySelectorAll(".ab-feat").forEach((el) => {
      el.addEventListener("click", () => {
        const key = el.dataset.feat;
        if (!key) return; // the win-fixes tile has no data-feat → its own handler
        const on = !state.settings.features[key];
        state.settings.features[key] = on;
        el.classList.toggle("on", on); // tile lights up when ON (no checkmark)
        saveSettings();
      });
    });

    // "Auto toggles" collapsible group (Control tab)
    const featsToggle = panel.querySelector('[data-role="feats-toggle"]');
    const feats = panel.querySelector('[data-role="feats"]');
    if (featsToggle && feats) {
      featsToggle.addEventListener("click", () => {
        state.settings.featsOpen = !state.settings.featsOpen;
        feats.classList.toggle("open", state.settings.featsOpen);
        featsToggle.textContent = state.settings.featsOpen
          ? tr("Auto toggles ▴")
          : tr("Auto toggles ▾");
        saveSettings();
      });
    }

    // hover tooltip for the compact feature tiles (label + detailed description)
    let featTip = null;
    panel.querySelectorAll(".ab-feat-mini").forEach((tile) => {
      tile.addEventListener("mouseenter", () => {
        const info = FEAT_TIP[tile.dataset.feat];
        if (!info) return;
        if (!featTip) {
          featTip = document.createElement("div");
          featTip.className = "ab-feat-tip";
          document.body.appendChild(featTip);
        }
        featTip.innerHTML = `<b>${tr(info[0])}</b><br>${tr(info[1])}`;
        const r = tile.getBoundingClientRect();
        featTip.style.left = `${r.left + r.width / 2}px`;
        featTip.style.top = `${r.top - 6}px`;
        featTip.classList.add("show");
      });
      tile.addEventListener("mouseleave", () => {
        if (featTip) featTip.classList.remove("show");
      });
    });

    // status & stats collapsible group
    const statusToggle = panel.querySelector('[data-role="status-toggle"]');
    const statusWrap = panel.querySelector('[data-role="status-wrap"]');
    if (statusToggle && statusWrap) {
      statusToggle.addEventListener("click", () => {
        state.settings.statusOpen = !state.settings.statusOpen;
        statusWrap.classList.toggle("open", state.settings.statusOpen);
        statusToggle.textContent = state.settings.statusOpen
          ? tr("Status & stats ▴")
          : tr("Status & stats ▾");
        saveSettings();
      });
    }

    // (Advanced settings — difficulty / win-fixes / tick interval — now live in
    // the main popup's "Auto Bot" tab, not in this panel.)

    // tab switching
    panel.querySelectorAll(".ab-tab").forEach((el) => {
      el.addEventListener("click", () => {
        const tab = el.dataset.tab;
        if (tab === state.activeTab) return;
        state.activeTab = tab;
        panel.classList.toggle("ab-tab-log", tab === "log");
        panel
          .querySelectorAll(".ab-tab")
          .forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
        if (tab === "log") renderLog();
      });
    });

    // log category filter chips
    panel.querySelectorAll(".ab-chip").forEach((el) => {
      el.addEventListener("click", () => {
        state.logFilter = el.dataset.filter;
        panel
          .querySelectorAll(".ab-chip")
          .forEach((c) => c.classList.toggle("on", c.dataset.filter === state.logFilter));
        renderLog();
      });
    });

    makeDraggable(panel, panel.querySelector(".ab-head"));
  }

  function renderLog() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const list = panel.querySelector('[data-role="log-list"]');
    if (!list) return;
    const entries =
      state.logFilter === "all"
        ? state.log
        : state.log.filter((e) => e.cat === state.logFilter);
    if (entries.length === 0) {
      list.innerHTML = `<div class="ab-log-empty">${tr("No actions yet")}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      // The label already carries its own action emoji (🛡️/🏗️/☢️/…), so we
      // render it as-is — the category is only used for filtering, not display.
      const item = document.createElement("div");
      item.className = "ab-log-item";
      const time = document.createElement("span");
      time.className = "ab-log-time";
      time.textContent = new Date(e.t).toLocaleTimeString();
      const text = document.createElement("span");
      text.className = "ab-log-text";
      text.textContent = e.text;
      item.appendChild(time);
      item.appendChild(text);
      frag.appendChild(item);
    }
    list.replaceChildren(frag);
  }

  function makeDraggable(panel, handle) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;

    function onDown(e) {
      if (e.target.closest('[data-role="switch"], [data-role="mini"], [data-role="close"]')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = originLeft + "px";
      panel.style.top = originTop + "px";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      const left = clamp(originLeft + (e.clientX - startX), 0, window.innerWidth - 60);
      const top = clamp(originTop + (e.clientY - startY), 0, window.innerHeight - 30);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      state.settings.pos = {
        left: parseInt(panel.style.left, 10),
        top: parseInt(panel.style.top, 10),
      };
      saveSettings();
      console.log("[Panel] saved pos", state.settings.pos);
    }
    handle.addEventListener("pointerdown", onDown);
  }

  function applyStoredPosition(panel) {
    const pos = state.settings.pos;
    console.log("[Panel] applyStoredPosition", pos);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = clamp(pos.left, 0, window.innerWidth - 60) + "px";
      panel.style.top = clamp(pos.top, 0, window.innerHeight - 30) + "px";
    }
  }

  function renderHeader() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel
      .querySelector('[data-role="switch"]')
      .classList.toggle("on", state.settings.enabled);
  }

  function refreshGateBanner() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const gate = panel.querySelector('[data-role="gate"]');
    if (!gate) return;
    const game = getGame();
    if (!game) {
      gate.className = "ab-gate wait";
      gate.textContent = tr("Waiting to enter game…");
      return;
    }
    const type = gameType(game);
    if (type) {
      gate.className = "ab-gate ok";
      let label;
      if (type === "Singleplayer") label = tr("Singleplayer");
      else if (type === "Public") label = tr("Public lobby");
      else label = tr("Private lobby");
      gate.textContent = "✓ " + label;
    } else {
      gate.className = "ab-gate wait";
      gate.textContent = tr("Waiting to enter game…");
    }
  }

  function fmt(n) {
    const v = Math.round(n);
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
    if (v >= 1_000) return (v / 1_000).toFixed(1) + "k";
    return String(v);
  }

  function renderStatus() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const set = (role, text) => {
      const el = panel.querySelector(`[data-role="${role}"]`);
      if (el) el.textContent = text;
    };
    set("status", state.status);
    set("lastaction", state.lastAction);
    set("s-troops", fmt(state.live.troops));
    set("s-gold", fmt(state.live.gold));
    set("s-tiles", fmt(state.live.tiles));
    set("c-spawns", String(state.stats.spawns));
    set("c-attacks", String(state.stats.attacks));
    set("c-builds", String(state.stats.builds));
    set("c-nukes", String(state.stats.nukes));
  }
