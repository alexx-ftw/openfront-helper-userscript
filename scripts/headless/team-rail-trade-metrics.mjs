const result = (train, trade) => ({
  botTeamGrossTrainGoldEarned: train.toString(),
  botTeamGrossTradeGoldEarned: trade.toString(),
});

export function botTeamGrossRailTradeEarnings(players, bot) {
  const botTeam = bot.team();
  const botId = bot.id();
  let train = 0n;
  let trade = 0n;
  for (const player of players) {
    if (botTeam === null ? player.id() !== botId : player.team() !== botTeam) continue;
    train += player.trainGold();
    trade += player.tradeGold();
  }
  return result(train, trade);
}

export function sumBotTeamGrossRailTradeEarnings(games) {
  return result(
    games.reduce((total, game) => total + BigInt(game.botTeamGrossTrainGoldEarned), 0n),
    games.reduce((total, game) => total + BigInt(game.botTeamGrossTradeGoldEarned), 0n),
  );
}

export function deltaBotTeamGrossRailTradeEarnings(candidate, baseline) {
  return result(
    BigInt(candidate.botTeamGrossTrainGoldEarned) - BigInt(baseline.botTeamGrossTrainGoldEarned),
    BigInt(candidate.botTeamGrossTradeGoldEarned) - BigInt(baseline.botTeamGrossTradeGoldEarned),
  );
}
