import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "engine/ingame/auto-donate.js"), "utf8");

function makePlayer({ id, name, troops, friendly, border = false, inCombat = false }) {
  return {
    id: () => id,
    smallID: () => id,
    displayName: () => name,
    troops: () => troops,
    isAlive: () => true,
    friendly,
    isFriendly: () => friendly,
    incomingAttacks: () => (inCombat ? [{}] : []),
    outgoingAttacks: () => [],
    sharesBorder: border,
  };
}

async function runDonation({
  opponents = [],
  friendlyBorder = false,
  supportsBorderApi = true,
} = {}) {
  const packets = [];
  const me = {
    id: () => 1,
    smallID: () => 1,
    troops: () => 1000,
    isAlive: () => true,
    isFriendly: (player) => Boolean(player.friendly),
    incomingAttacks: () => [],
    outgoingAttacks: () => [],
  };
  if (supportsBorderApi) {
    me.borderTiles = async () => ({ borderTiles: new Set([1]) });
  }

  const ally = makePlayer({
    id: 2,
    name: "ally",
    troops: 50,
    friendly: true,
    border: friendlyBorder,
    inCombat: true,
  });
  const players = [me, ally, ...opponents];
  const borderingPlayers = [
    ...(friendlyBorder ? [ally] : []),
    ...opponents.filter((player) => player.sharesBorder),
  ];
  const ownerByTile = new Map(borderingPlayers.map((player, index) => [index + 10, player]));
  const game = {
    myPlayer: () => me,
    playerViews: () => players,
    neighbors: (tile) => (tile === 1 ? [...ownerByTile.keys()] : []),
    isLand: () => true,
    hasOwner: (tile) => ownerByTile.has(tile),
    owner: (tile) => ownerByTile.get(tile),
    config: () => ({
      donateTroops: () => true,
      maxTroops: () => 1000,
    }),
  };

  const sandbox = {
    window: {},
    _quickPanelSettingsCache: {
      autoDonateEnabled: true,
      autoDonateKeepPct: 0,
      autoDonatePercentage: 80,
      autoDonateTargets: "ally",
    },
    getOpenFrontGameContext: () => ({ game }),
    sendGamePacket: (packet) => packets.push(packet),
    getPlayerDisplayName: (player) => player.displayName(),
    Date: { now: () => 5000 },
    console: { log() {}, error() {} },
  };

  vm.runInNewContext(SOURCE, sandbox, { filename: "auto-donate.js" });
  await sandbox.window.__OFH_tickAutoDonate();
  return packets;
}

const strongestBorderCap = await runDonation({
  opponents: [
    makePlayer({ id: 3, name: "border-strong", troops: 801, friendly: false, border: true }),
    makePlayer({ id: 4, name: "border-weak", troops: 600, friendly: false, border: true }),
  ],
});
assert.equal(
  strongestBorderCap[0]?.troops,
  599,
  "odd enemy army keeps the safer fractional half reserve",
);
assert.ok(
  1000 - strongestBorderCap[0].troops >= 801 / 2,
  "donation leaves at least half of the strongest border enemy",
);

const nonBorderStrongest = await runDonation({
  opponents: [
    makePlayer({ id: 3, name: "border-enemy", troops: 400, friendly: false, border: true }),
    makePlayer({ id: 4, name: "remote-enemy", troops: 1200, friendly: false, border: false }),
  ],
});
assert.equal(
  nonBorderStrongest[0]?.troops,
  800,
  "non-border enemies do not lower the donation cap",
);

const friendlyBorder = await runDonation({
  friendlyBorder: true,
  opponents: [],
});
assert.equal(
  friendlyBorder[0]?.troops,
  800,
  "friendly border players are not treated as opponents",
);

const noSafeDonation = await runDonation({
  opponents: [
    makePlayer({ id: 3, name: "overwhelming-enemy", troops: 2001, friendly: false, border: true }),
  ],
});
assert.equal(noSafeDonation.length, 0, "donation is skipped when no positive safe amount exists");

const missingBorderApi = await runDonation({ supportsBorderApi: false });
assert.equal(missingBorderApi.length, 0, "donation fails closed without border data");

console.log("auto-donate troop reserve tests passed");
