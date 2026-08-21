import { fileURLToPath } from "node:url";

import { PlayerInfo, PlayerType } from "../../openfront-engine/src/core/game/Game";
import { setup } from "../../openfront-engine/tests/util/Setup";

// Shared engine-fixture bootstrap: the live-engine tests all spin up the
// same two-player world with infinite gold and instant builds. Centralizing
// the preamble keeps the duplicate-scanner gate honest.
export const engineTestsUtil = fileURLToPath(
  new URL("../../openfront-engine/tests/util/", import.meta.url),
);

export async function setupTwoPlayerGame(mapName) {
  return setup(
    mapName,
    { infiniteGold: true, instantBuild: true },
    [
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
    ],
    engineTestsUtil,
  );
}
