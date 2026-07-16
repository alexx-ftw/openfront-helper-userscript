// Preferred tribe-cluster marker. The auto-bot planner publishes the center of
// the exact shared-border component it is concentrating on; this layer only
// projects that authoritative topology result onto the map.

  function preferredTribeClusterMarkerEnabled() {
    const center = state?.earlyGame?.preferredClusterCenter;
    return (
      state?.settings?.enabled === true &&
      Number.isFinite(Number(center?.x)) &&
      Number.isFinite(Number(center?.y)) &&
      Number(state?.earlyGame?.preferredClusterSize) > 1
    );
  }

  function drawPreferredTribeClusterMarker(ctx, _game, transform) {
    const center = state?.earlyGame?.preferredClusterCenter;
    if (!center) return;
    const point = mapWorldToScreen(transform, Number(center.x), Number(center.y));
    const members = Array.isArray(state?.earlyGame?.preferredClusterMembers)
      ? state.earlyGame.preferredClusterMembers
      : [];
    ctx.save();
    ctx.setLineDash([6, 4]);
    for (const member of members) {
      const memberPoint = mapWorldToScreen(
        transform,
        Number(member.x),
        Number(member.y),
      );
      if (
        !memberPoint ||
        !mapPointOnScreen(memberPoint.x, memberPoint.y, 30)
      ) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(memberPoint.x, memberPoint.y, 17, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(250, 204, 21, 0.14)";
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(250, 204, 21, 0.92)";
      ctx.stroke();
    }
    ctx.restore();
    if (!point || !mapPointOnScreen(point.x, point.y, 80)) return;

    const markerY = point.y - 30;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, markerY, 12, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(250, 204, 21, 0.98)";
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(point.x - 5, markerY + 10);
    ctx.lineTo(point.x, point.y - 5);
    ctx.lineTo(point.x + 5, markerY + 10);
    ctx.fillStyle = "rgba(250, 204, 21, 0.98)";
    ctx.fill();
    drawMapHaloText(ctx, point.x, markerY, "★", {
      color: "#fde047",
      font: '900 14px "Aptos", "Segoe UI", sans-serif',
    });
    drawMapHaloText(
      ctx,
      point.x,
      markerY - 21,
      `Largest tribe cluster · ${Math.floor(
        Number(state.earlyGame.preferredClusterSize) || 0,
      )}`,
      { color: "#fde047", font: '900 12px "Aptos", "Segoe UI", sans-serif' },
    );
    ctx.restore();
  }

  registerMapOverlayLayer({
    id: "preferred-tribe-cluster",
    scanIntervalMs: 500,
    isEnabled: preferredTribeClusterMarkerEnabled,
    scan: function () {},
    draw: drawPreferredTribeClusterMarker,
  });
