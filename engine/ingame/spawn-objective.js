// Replay-free spawn objective.
//
// The selector cannot learn a statistically optimal weight vector without
// outcomes. Instead it uses a robust floor: a candidate is only as strong as
// its weakest normalized dimension (starting territory, expansion potential,
// safety, or team fit). This prevents one spectacular metric from hiding a
// fatal weakness and keeps the objective deterministic across maps.

(function installSpawnObjective(root) {
  const CLAN_TAG_PATTERN = /^\[([a-zA-Z0-9]{2,5})\] /;

  function clampScore(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(1, number));
  }

  function normalizeClanTag(value) {
    if (typeof value !== "string") return null;
    const tag = value.trim();
    if (!/^[a-zA-Z0-9]{2,5}$/.test(tag)) return null;
    return tag.toUpperCase();
  }

  function extractClanTag(displayName) {
    if (typeof displayName !== "string") return null;
    const match = CLAN_TAG_PATTERN.exec(displayName);
    return match ? normalizeClanTag(match[1]) : null;
  }

  function sameClanTag(left, right) {
    const leftTag = normalizeClanTag(left);
    const rightTag = normalizeClanTag(right);
    return leftTag !== null && leftTag === rightTag;
  }

  function readValue(target, key) {
    try {
      const value = target?.[key];
      return typeof value === "function" ? value.call(target) : value;
    } catch (_error) {
      return null;
    }
  }

  function getPlayerClanTag(player) {
    if (!player) return null;

    const directTag = normalizeClanTag(readValue(player, "clanTag"));
    if (directTag) return directTag;

    const info = readValue(player, "info");
    const infoTag = normalizeClanTag(info?.clanTag);
    if (infoTag) return infoTag;

    const source = player.__src;
    const sourceTag = normalizeClanTag(source?.static?.clanTag);
    if (sourceTag) return sourceTag;

    const displayNames = [
      source?.static?.displayName,
      player?.data?.displayName,
      readValue(player, "displayName"),
    ];
    for (const displayName of displayNames) {
      const tag = extractClanTag(displayName);
      if (tag) return tag;
    }
    return null;
  }

  function clanProximityScore(x, y, points, radius = 110) {
    // Hot path: callers provide normalized finite map coordinates. Keep this
    // branch-free per point because it runs once for every exact map candidate.
    if (!points || points.length === 0 || radius <= 0) return 0;

    let nearest = Infinity;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const distance = Math.abs(point.x - x) + Math.abs(point.y - y);
      if (distance < nearest) nearest = distance;
    }
    return nearest === Infinity ? 0 : Math.max(0, 1 - nearest / radius);
  }

  function evaluateModelCandidate(candidate) {
    const startScore = clampScore(candidate.startScore);
    const expansionScore = clampScore(candidate.expansionScore);
    const safetyScore = clampScore(candidate.safetyScore);
    const teamScore = clampScore(candidate.teamScore, 1);
    const clanScore = clampScore(candidate.clanScore);
    return {
      startScore,
      expansionScore,
      safetyScore,
      teamScore,
      clanScore,
      robustFloor: Math.min(startScore, expansionScore, safetyScore, teamScore),
    };
  }

  function compareDescending(left, right) {
    const leftObjective = left.objective;
    const rightObjective = right.objective;
    const dimensions = [
      "robustFloor",
      "safetyScore",
      "expansionScore",
      "teamScore",
      "clanScore",
      "startScore",
    ];
    for (const dimension of dimensions) {
      if (leftObjective[dimension] !== rightObjective[dimension]) {
        return rightObjective[dimension] - leftObjective[dimension];
      }
    }
    const leftRef = Number.isFinite(Number(left.ref)) ? Number(left.ref) : Infinity;
    const rightRef = Number.isFinite(Number(right.ref)) ? Number(right.ref) : Infinity;
    return leftRef - rightRef;
  }

  function rankModelCandidates(candidates) {
    return Array.from(candidates || [])
      .map((candidate) => ({
        ...candidate,
        objective: evaluateModelCandidate(candidate),
      }))
      .sort(compareDescending);
  }

  root.__OFHSpawnObjective = {
    evaluateModelCandidate,
    rankModelCandidates,
    extractClanTag,
    sameClanTag,
    getPlayerClanTag,
    clanProximityScore,
  };
})(typeof globalThis === "object" ? globalThis : window);
