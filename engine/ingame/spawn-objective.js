// Replay-free spawn objective.
//
// The selector cannot learn a statistically optimal weight vector without
// outcomes. Instead it uses a robust floor: a candidate is only as strong as
// its weakest normalized dimension (starting territory, expansion potential,
// free-land availability, safety, reachable tribe expansion, or allied support).
// A rich isolated start is not robust: enemies can surround it before teammates
// can connect. Clan proximity remains a late tie-break, while team proximity is
// part of the survival floor whenever spawned allies are known.

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
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
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
    const tribeScore = clampScore(candidate.tribeScore, 1);
    const nationScore = clampScore(candidate.nationScore, 1);
    const tribeReachScore = clampScore(candidate.tribeReachScore, 1);
    const tribeReachCount = Number.isFinite(Number(candidate.tribeReachCount))
      ? Math.max(0, Number(candidate.tribeReachCount))
      : 0;
    const freeLandScore = clampScore(candidate.freeLandScore, 1);
    const resourceScore = clampScore(candidate.resourceScore, 1);
    const clanScore = clampScore(candidate.clanScore);
    const teamPolyhedronScore = clampScore(candidate.teamPolyhedronScore);
    return {
      startScore,
      expansionScore,
      safetyScore,
      teamScore,
      tribeScore,
      nationScore,
      tribeReachScore,
      tribeReachCount,
      freeLandScore,
      resourceScore,
      clanScore,
      teamPolyhedronScore,
      robustFloor: Math.min(
        startScore,
        expansionScore,
        freeLandScore,
        safetyScore,
        resourceScore,
        teamScore,
      ),
    };
  }

  function compareModelCandidates(left, right) {
    const leftObjective = left.objective;
    const rightObjective = right.objective;
    const insideTeamPolyhedron =
      leftObjective.teamPolyhedronScore === 1 && rightObjective.teamPolyhedronScore === 1;
    const dimensions = insideTeamPolyhedron
      ? "freeLandScore expansionScore tribeReachCount tribeReachScore resourceScore robustFloor safetyScore tribeScore nationScore startScore teamScore clanScore".split(" ")
      : "robustFloor safetyScore expansionScore tribeReachScore tribeReachCount freeLandScore resourceScore tribeScore nationScore startScore teamScore clanScore".split(" ");
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
      .sort(compareModelCandidates);
  }

  root.__OFHSpawnObjective = {
    evaluateModelCandidate,
    compareModelCandidates,
    rankModelCandidates,
    extractClanTag,
    sameClanTag,
    getPlayerClanTag,
    clanProximityScore,
  };
})(typeof globalThis === "object" ? globalThis : window);
