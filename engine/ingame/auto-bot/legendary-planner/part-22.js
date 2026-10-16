    ...LEGENDARY_PRIMARY_FIELDS.map((field) =>
      legendaryScoreValue(candidate[field]),
    ),
  );
}

function legendaryObjectiveTotal(candidate) {
  return LEGENDARY_PRIMARY_FIELDS.reduce(
    (total, field) => total + legendaryScoreValue(candidate[field]),
    0,
  );
}

function compareLegendaryCandidates(left, right) {
  const bothEconomicActions =
    (left.type === "City" || left.type === "Factory" || left.type === "Port") &&
    (right.type === "City" || right.type === "Factory" || right.type === "Port");
  if (bothEconomicActions) {
    const capacityPriority =
      legendaryScoreValue(right.capacity) - legendaryScoreValue(left.capacity);
    if (capacityPriority !== 0) return capacityPriority;
    if (left.netTeamGold !== undefined && right.netTeamGold !== undefined) {
      const leftNetGold = legendaryBigInt(left.netTeamGold);
      const rightNetGold = legendaryBigInt(right.netTeamGold);
      if (leftNetGold !== rightNetGold) return leftNetGold > rightNetGold ? -1 : 1;
    }
  }

  for (const field of LEGENDARY_PRIORITY_FIELDS) {
    const a = legendaryScoreValue(left[field]);
    const b = legendaryScoreValue(right[field]);
    if (a !== b) return b - a;
  }

  if (
    left.netTeamGold !== undefined &&
    right.netTeamGold !== undefined
  ) {
    const leftGold = legendaryBigInt(left.netTeamGold);
    const rightGold = legendaryBigInt(right.netTeamGold);
    if (leftGold !== rightGold) return leftGold > rightGold ? -1 : 1;
  }

  const leftBalance = legendaryObjectiveBalance(left);
  const rightBalance = legendaryObjectiveBalance(right);
  if (leftBalance !== rightBalance) return rightBalance - leftBalance;

  const leftTotal = legendaryObjectiveTotal(left);
  const rightTotal = legendaryObjectiveTotal(right);
  if (leftTotal !== rightTotal) return rightTotal - leftTotal;

  const leftDefense = legendaryScoreValue(left.defense);
  const rightDefense = legendaryScoreValue(right.defense);
  if (leftDefense !== rightDefense) return rightDefense - leftDefense;

  for (const field of LEGENDARY_TIE_FIELDS) {
    const a = legendaryScoreValue(left[field]);
    const b = legendaryScoreValue(right[field]);
    if (a !== b) return b - a;
  }

  const leftCost = legendaryBigInt(left.cost);
  const rightCost = legendaryBigInt(right.cost);
  if (leftCost !== rightCost) return leftCost < rightCost ? -1 : 1;

  const leftOrder = legendaryScoreValue(left.typeOrder);
  const rightOrder = legendaryScoreValue(right.typeOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  return String(left.type ?? "").localeCompare(String(right.type ?? ""));
}

function rankLegendaryConstructionCandidates(candidates, options = {}) {
  const gold = legendaryBigInt(options.gold ?? 0n);
  const reserve = legendaryBigInt(options.reserve ?? 0n);
  const available = gold > reserve ? gold - reserve : 0n;

  return candidates
    .filter((candidate) => {
      if (!candidate || candidate.legal === false || candidate.affordable === false) {
        return false;
      }
      return legendaryBigInt(candidate.cost) <= available;
    })
    .slice()
    .sort(compareLegendaryCandidates);
}

function rankLegendaryConstructionActions(candidates, options = {}) {
  const gold = legendaryBigInt(options.gold ?? 0n);
  const reserve = legendaryBigInt(options.reserve ?? 0n);
  const available = gold > reserve ? gold - reserve : 0n;
  const eligible = candidates
    .filter((candidate) => candidate && candidate.legal !== false)
    .slice()
    .sort(compareLegendaryCandidates);
  // Runtime economy candidates always carry an explicit netTeamGold verdict.
  // Synthetic/non-economic callers without one preserve their legacy ordering.
  const valueRanked = eligible.filter((candidate) => {
    if (candidate.netTeamGold === undefined) return true;
    let netTeamGold;
    if (typeof candidate.netTeamGold === "bigint") {
      netTeamGold = candidate.netTeamGold;
    } else if (
      typeof candidate.netTeamGold === "number" &&
      Number.isFinite(candidate.netTeamGold)
    ) {
      netTeamGold = BigInt(Math.round(candidate.netTeamGold));
    } else {
      return false;
    }
    if (netTeamGold > 0n) return true;
    return (
      !["City", "Factory", "Port"].includes(candidate.type) ||
      Number(candidate.capacity ?? 0) > 0
    );
  });
  const affordable = valueRanked.filter(
    (candidate) =>
      candidate.affordable !== false && legendaryBigInt(candidate.cost) <= available,
  );
  const bestFuture = valueRanked.find(
    (candidate) => legendaryBigInt(candidate.cost) > available,
  );

  if (!bestFuture) return affordable;
  const shortfall = legendaryBigInt(bestFuture.cost) - available;
  const bestNow = affordable[0] ?? null;
  // Waiting is an actual portfolio action.  It wins only when the preferred
  // future asset dominates every affordable one and buying the best immediate
  // alternative would consume at least the entire funding gap.  In that case
  // spending now necessarily delays the dominating action by more gold than is
  // currently missing; no income-rate guess or arbitrary ratio is required.
  if (
    bestNow === null ||
    (compareLegendaryCandidates(bestFuture, bestNow) < 0 &&
      shortfall * 2n <= legendaryBigInt(bestNow.cost))
  ) {
    return [
      {
        action: "wait",
        type: "Wait",
        targetType: bestFuture.type,
        shortfall,
        cost: 0n,
      },
      ...affordable,
    ];
  }
  return affordable;
}

function chooseLegendaryConstructionCandidate(candidates, options = {}) {
  return rankLegendaryConstructionCandidates(candidates, options)[0] ?? null;
}
