// Per-player on-map overlay — a single layer on the shared map-overlay scheduler
// that draws, above each living player's name:
//   • a troop RATIO BAR (home = relation color, attacking = orange, bg = max)
//     plus the /10 troop count            — toggle: showMapTroopCounts
//   • threat marks: ☢ nuke-capable icon,  — toggle: showThreatIndicators
//     red "stronger than you" dot, amber "weak" dot (enemies only)
//   • gold readout                        — toggle: showMapMoney
// Colored by relation (blue=you, teal=team, green=ally, red=enemy). One scan
// (throttled) feeds everything; the per-frame draw maps nameLocation → screen.
//
// IMPORTANT: OpenFront stores troops at 10x internally and the UI renders /10
// (see gold-per-minute.js renderTroops). Ratios (troops/max) are scale-invariant,
// but any DISPLAYED absolute troop number must be divided by 10.

  function formatMapTroops(value) {
    const v = Math.max(0, Math.floor(Number(value) || 0));
    if (v >= 1e6) {
      return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    }
    if (v >= 1e3) {
      return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    }
    return String(v);
  }

  // Display helper: raw internal troops (10x) → shown value.
  function troopsDisplay(rawTroops) {
    return formatMapTroops((Number(rawTroops) || 0) / 10);
  }

  function formatMapGold(value) {
    const v = Math.max(0, Math.floor(Number(value) || 0));
    if (v >= 1e6) {
      return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    }
    if (v >= 1e3) {
      return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    }
    return `$${v}`;
  }

  function playerOverlayEnabled() {
    return (
      playerMapOverlaysEnabled &&
      (mapTroopCountsEnabled || threatIndicatorsEnabled || mapMoneyEnabled)
    );
  }

  // Scan cache: [{ player, relation, isEnemy, troops, inCombat, maxTroops, gold, threat }].
  // troops/inCombat/maxTroops are RAW (10x); divide by 10 only when displaying.
  let _playerOverlayScan = [];

  function scanPlayerOverlay(game) {
    // Skip overlay during spawn phase — many players crowd the screen and
    // overlays add cost with little value. Uses the game's own spawn-phase
    // detection (game.inSpawnPhase()) instead of heuristics.
    try {
      if (game?.inSpawnPhase?.()) {
        _playerOverlayScan = [];
        return;
      }
    } catch (_error) { /* ignore */ }

    const players = getCachedPlayerViews(game);
    const me = game.myPlayer ? game.myPlayer() : null;
    const nukeBuilders = threatIndicatorsEnabled ? advNukeBuilderIds(game) : null;
    const needBar = mapTroopCountsEnabled;
    const out = [];
    for (let i = 0; i < players.length; i += 1) {
      const player = players[i];
      if (!player || !player.isAlive || !player.isAlive()) {
        continue;
      }
      let relation = "enemy";
      try {
        relation = getPlayerRelationToMyPlayer(game, player) || "enemy";
      } catch (_error) {
        relation = "enemy";
      }
      const isEnemy =
        relation !== "self" && relation !== "ally" && relation !== "team";
      const troops = advTroops(player);

      // Skip regular bots for troop bar + money overlays (too many early game).
      // Keep for human players AND nation AI (isNationBotPlayer).
      // PlayerType.Bot = "BOT" (portutil.js:28).
      const isRegularBot =
        isEnemy &&
        typeof isNationBotPlayer === "function" &&
        !isNationBotPlayer(player) &&
        player.type && player.type() === "BOT";

      const entry = {
        player,
        relation,
        isEnemy,
        troops,
        skipOverlay: isRegularBot,
        inCombat: (needBar && !isRegularBot) ? advTroopsInCombat(player) : 0,
        maxTroops: (needBar || threatIndicatorsEnabled) && !isRegularBot ? advMaxTroops(game, player) : 0,
        gold: (mapMoneyEnabled && !isRegularBot) ? advGoldNumber(player) : 0,
        threat: null,
      };
      if (threatIndicatorsEnabled && isEnemy && me) {
        try {
          entry.threat = advEvaluateThreat(game, me, player, nukeBuilders);
        } catch (_error) {
          entry.threat = null;
        }
      }
      out.push(entry);
    }
    _playerOverlayScan = out;
  }

  // Money readout with a dark rounded-pill background (Tactical-style), centered
  // above the player's name. Bigger + a coin icon so it reads clearly on the map.
  function drawMoneyPill(ctx, cx, cy, text) {
    ctx.font = 'bold 12px "Aptos", "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const padX = 7;
    const tw = ctx.measureText(text).width;
    const w = tw + padX * 2;
    const h = 18;
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    fillRoundRect(ctx, x0, y0, w, h, 5, "rgba(7, 12, 18, 0.82)", "rgba(252, 211, 77, 0.45)");
    ctx.fillStyle = "rgba(252, 211, 77, 0.98)";
    ctx.fillText(text, cx, cy + 0.5);
  }

  // Small rounded-rect helper (background + optional border).
  function fillRoundRect(ctx, x, y, w, h, r, bg, border) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill();
    if (border) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = border;
      ctx.stroke();
    }
  }

  // Troop ratio bar — 1:1 with Tactical Assistant name-overlay (lines 7942-7969).
  // home troops = green (fixed, NOT faction color), attacking = orange, total bar
  // length = total/max. Label shows only "/max" (current is implied by bar fill).
  function drawTroopBar(ctx, cx, barTop, relation, troops, attacking, maxTroops) {
    const barW = 40;
    const barH = 6;
    const barX = cx - barW / 2;
    const max = Math.max(1, maxTroops);
    const total = troops + attacking;
    const totalRatio = Math.min(total / max, 1);
    const mainRatio = attacking === 0 ? 1 : total > 0 ? troops / total : 0;
    const bufferRatio = attacking === 0 ? 0 : total > 0 ? attacking / total : 0;
    const mainW = mainRatio * totalRatio * barW;
    const bufferW = bufferRatio * totalRatio * barW;

    ctx.fillStyle = "rgba(34, 34, 34, 0.7)"; // background
    ctx.fillRect(barX, barTop, barW, barH);
    ctx.fillStyle = "rgba(0, 210, 82, 0.85)"; // HOME = green (fixed)
    ctx.fillRect(barX, barTop, mainW, barH);
    if (bufferW > 0) {
      ctx.fillStyle = "rgba(255, 166, 0, 0.7)"; // ATTACKING = orange
      ctx.fillRect(barX + mainW, barTop, bufferW, barH);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(68, 68, 68, 0.8)";
    ctx.strokeRect(barX + 0.5, barTop + 0.5, barW - 1, barH - 1);

    // "/max" label with its own dark pill so it's readable over any terrain.
    const maxLabel = `/${troopsDisplay(maxTroops)}`;
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const lx = barX + barW + 4;
    const lcy = barTop + barH / 2;
    const lpad = 5;
    const ltw = ctx.measureText(maxLabel).width;
    fillRoundRect(ctx, lx, lcy - 9, ltw + lpad * 2, 18, 5, "rgba(7, 12, 18, 0.82)", null);
    // Blue to match the game's in-UI troop counter (malibu-blue).
    ctx.fillStyle = "rgba(95, 178, 255, 0.98)";
    ctx.fillText(maxLabel, lx + lpad, lcy + 0.5);
  }

  function drawPlayerOverlay(ctx, game, transform) {
    const me = game.myPlayer ? game.myPlayer() : null;
    let myTroops = 1;
    try {
      myTroops = Math.max(1, Number(me && me.troops ? me.troops() : 1) || 1);
    } catch (_error) {
      myTroops = 1;
    }

    for (let i = 0; i < _playerOverlayScan.length; i += 1) {
      const entry = _playerOverlayScan[i];
      const player = entry.player;
      let loc = null;
      try {
        loc = player.nameLocation ? player.nameLocation() : null;
      } catch (_error) {
        loc = null;
      }
      if (!loc) {
        continue;
      }
      const p = mapWorldToScreen(transform, loc.x, loc.y);
      if (!p || !mapPointOnScreen(p.x, p.y, 30)) {
        continue;
      }
      const color = mapFactionColor(entry.relation);

      // Skip troop bar + money for regular bots (too many early game).
      // Threat marks still shown for all enemies.
      // Draw stacked ABOVE the player's name so nothing overlaps the label:
      // money (highest) → troop bar → then threat marks stay just under the name.
      if (!entry.skipOverlay) {
        if (mapMoneyEnabled) {
          drawMoneyPill(ctx, p.x, p.y - 34, formatMapGold(entry.gold));
        }

        if (mapTroopCountsEnabled) {
          // Live troops for a responsive bar; inCombat/max from the throttled scan.
          let liveTroops = entry.troops;
          try {
            liveTroops = Number(player.troops ? player.troops() : entry.troops) || entry.troops;
          } catch (_error) {
            liveTroops = entry.troops;
          }
          drawTroopBar(ctx, p.x, p.y - 20, entry.relation, liveTroops, entry.inCombat, entry.maxTroops);
        }
      }

      if (threatIndicatorsEnabled && entry.isEnemy && !entry.skipOverlay) {
        drawThreatMarks(ctx, p.x, p.y + 14, entry, myTroops);
      }
    }
  }

  function drawThreatMarks(ctx, x, baseY, entry, myTroops) {
    const threat = entry.threat;
    const troops = entry.troops;
    if (threat && (threat.nukeCapable || threat.buildingNuke)) {
      drawMapHaloText(ctx, x - 30, baseY, "☢", "rgba(248, 113, 113, 0.95)");
    }
    // Ratios are scale-invariant → compare raw values directly.
    let dot = null;
    if (troops >= 1.35 * myTroops) {
      dot = "rgba(248, 113, 113, 0.95)"; // stronger than you
    } else if (entry.maxTroops > 0 && troops <= 0.1 * entry.maxTroops) {
      dot = "rgba(251, 191, 36, 0.95)"; // weak
    }
    if (dot) {
      ctx.beginPath();
      ctx.arc(x + 30, baseY, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = dot;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.stroke();
    }
  }

  registerMapOverlayLayer({
    id: "player-overlay",
    scanIntervalMs: 500,
    isEnabled: playerOverlayEnabled,
    scan: function (game) {
      scanPlayerOverlay(game);
    },
    draw: function (ctx, game, transform) {
      drawPlayerOverlay(ctx, game, transform);
    },
  });

  function setPlayerMapOverlaysEnabled(enabled) {
    playerMapOverlaysEnabled = Boolean(enabled);
    if (!playerOverlayEnabled()) {
      _playerOverlayScan = [];
    }
    requestMapOverlayLoop();
  }

  function setMapTroopCountsEnabled(enabled) {
    mapTroopCountsEnabled = Boolean(enabled);
    if (!playerOverlayEnabled()) {
      _playerOverlayScan = [];
    }
    requestMapOverlayLoop();
  }

  function setThreatIndicatorsEnabled(enabled) {
    threatIndicatorsEnabled = Boolean(enabled);
    if (!playerOverlayEnabled()) {
      _playerOverlayScan = [];
    }
    requestMapOverlayLoop();
  }

  function setMapMoneyEnabled(enabled) {
    mapMoneyEnabled = Boolean(enabled);
    if (!playerOverlayEnabled()) {
      _playerOverlayScan = [];
    }
    requestMapOverlayLoop();
  }
