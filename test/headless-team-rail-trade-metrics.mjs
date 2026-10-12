import assert from "node:assert/strict";
import * as metrics from "../scripts/headless/team-rail-trade-metrics.mjs";

const player = (id, team, tradeGold, trainGold, alive = true) => ({
  id: () => id,
  team: () => team,
  tradeGold: () => tradeGold,
  trainGold: () => trainGold,
  isAlive: () => alive,
});
const bot = player("bot", "red", 9_007_199_254_740_993n, 11n);
const teammates = [
  bot,
  player("active-ally", "red", 31n, 13n),
  player("eliminated-ally", "red", 37n, 17n, false),
  player("opponent", "blue", 1_234_567_890_123_456_789n, 1_000_000n),
];
const earnings = metrics.botTeamGrossRailTradeEarnings(teammates, bot);
assert.deepEqual(earnings, {
  botTeamGrossTrainGoldEarned: "41",
  botTeamGrossTradeGoldEarned: "9007199254741061",
});

const laterPair = {
  botTeamGrossTrainGoldEarned: "9007199254740999",
  botTeamGrossTradeGoldEarned: "3",
};
assert.deepEqual(metrics.sumBotTeamGrossRailTradeEarnings([earnings, laterPair]), {
  botTeamGrossTrainGoldEarned: "9007199254741040",
  botTeamGrossTradeGoldEarned: "9007199254741064",
});
assert.deepEqual(
  metrics.deltaBotTeamGrossRailTradeEarnings(
    { botTeamGrossTrainGoldEarned: "9007199254741000", botTeamGrossTradeGoldEarned: "7" },
    { botTeamGrossTrainGoldEarned: "2", botTeamGrossTradeGoldEarned: "9" },
  ),
  {
    botTeamGrossTrainGoldEarned: "9007199254740998",
    botTeamGrossTradeGoldEarned: "-2",
  },
);
