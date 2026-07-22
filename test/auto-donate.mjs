import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "engine/ingame/auto-donate.js"), "utf8");

function makePlayer({
  id,
  name,
  troops,
  gold = 0,
  friendly,
  border = false,
  inCombat = false,
  incomingAttacks,
  outgoingAttacks = [],
}) {
  return {
    id: () => id,
    smallID: () => id,
    displayName: () => name,
    troops: () => troops,
    gold: () => gold,
    isAlive: () => true,
    friendly,
    isFriendly: () => friendly,
    incomingAttacks: () => incomingAttacks ?? (inCombat ? [{}] : []),
    outgoingAttacks: () => outgoingAttacks,
    sharesBorder: border,
  };
}

function makeTransport({
  owner,
  targetTile = 99,
  troops = 100,
  active = true,
  retreating = false,
}) {
  return {
    isActive: () => active,
    retreating: () => retreating,
    targetTile: () => targetTile,
    owner: () => owner,
    troops: () => troops,
  };
}

const DONATION_DEFAULTS = {
  opponents: [],
  friendlyBorder: false,
  allyTroops: 50,
  supportsBorderApi: true,
  supportsUnitApi: true,
  beingAttacked: false,
  attackDuringBorderLookup: false,
  incomingTransports: [],
  autoDonateTroops: true,
  autoDonateGold: false,
  gold: 0,
  allyGold: 0,
  goldThreshold: 1000,
  returnDetails: false,
  allyIncomingAttacks: undefined,
  allyOutgoingAttacks: [],
};

async function runDonation(options = {}) {
  const {
    opponents,
    friendlyBorder,
    allyTroops,
    supportsBorderApi,
    supportsUnitApi,
    beingAttacked,
    attackDuringBorderLookup,
    incomingTransports,
    autoDonateTroops,
    autoDonateGold,
    gold,
    allyGold,
    goldThreshold,
    returnDetails,
    allyIncomingAttacks,
    allyOutgoingAttacks,
  } = { ...DONATION_DEFAULTS, ...options };
  const packets = [];
  let currentlyBeingAttacked = beingAttacked;
  const me = {
    id: () => 1,
    smallID: () => 1,
    troops: () => 1000,
    gold: () => gold,
    isAlive: () => true,
    isFriendly: (player) => Boolean(player.friendly),
    incomingAttacks: () => (currentlyBeingAttacked ? [{}] : []),
    outgoingAttacks: () => [],
  };
  if (supportsBorderApi) {
    me.borderTiles = async () => {
      if (attackDuringBorderLookup) currentlyBeingAttacked = true;
      return { borderTiles: new Set([1]) };
    };
  }

  const ally = makePlayer({
    id: 2,
    name: "ally",
    troops: allyTroops,
    gold: allyGold,
    friendly: true,
    border: friendlyBorder,
    inCombat: true,
    incomingAttacks: allyIncomingAttacks,
    outgoingAttacks: allyOutgoingAttacks,
  });
  const players = [me, ally, ...opponents];
  const borderingPlayers = [
    ...(friendlyBorder ? [ally] : []),
    ...opponents.filter((player) => player.sharesBorder),
  ];
  const ownerByTile = new Map(borderingPlayers.map((player, index) => [index + 10, player]));
  const transportTargetOwners = new Map(
    incomingTransports.map((transport) => [transport.targetTile(), 1]),
  );
  const game = {
    myPlayer: () => me,
    playerViews: () => players,
    neighbors: (tile) => (tile === 1 ? [...ownerByTile.keys()] : []),
    isLand: () => true,
    hasOwner: (tile) => ownerByTile.has(tile),
    ownerID: (tile) => transportTargetOwners.get(tile) ?? ownerByTile.get(tile)?.smallID() ?? null,
    owner: () => {
      throw new Error("owner() should not be needed when ownerID() is available");
    },
    config: () => ({
      donateTroops: () => true,
      maxTroops: () => 1000,
    }),
  };
  if (supportsUnitApi) {
    game.units = (type) => (type === "Transport" ? incomingTransports : []);
  }

  const sandbox = {
    window: {},
    _quickPanelSettingsCache: {
      autoDonateEnabled: autoDonateTroops,
      autoDonateGoldEnabled: autoDonateGold,
      autoDonateKeepPct: 0,
      autoDonatePercentage: 80,
      autoDonateTargets: "ally",
      autoDonateGoldThreshold: goldThreshold,
      autoDonateGoldPercentage: 80,
      autoDonateGoldTargets: "ally",
    },
    getOpenFrontGameContext: () => ({ game }),
    sendGamePacket: (packet) => packets.push(packet),
    getPlayerDisplayName: (player) => player.displayName(),
    runtimeDebugLog() {},
    Date: { now: () => 5000 },
    console: { log() {}, error() {} },
  };

  executeClassicScript(SOURCE, sandbox, { filename: "auto-donate.js" });
  await sandbox.window.__OFH_tickAutoDonate();
  if (returnDetails) {
    return {
      packets,
      maritime: sandbox.window.__OFH_getIncomingMaritimeInvasion(game, me),
    };
  }
  return packets;
}

const strongestBorderCap = await runDonation({
  opponents: [
    makePlayer({ id: 3, name: "border-strong", troops: 1001, friendly: false, border: true }),
    makePlayer({ id: 4, name: "border-weak", troops: 600, friendly: false, border: true }),
  ],
});

const retreatingOnlyCombat = await runDonation({
  allyIncomingAttacks: [{ retreating: () => true }],
  allyOutgoingAttacks: [{ retreating: () => true }],
});
assert.equal(
  retreatingOnlyCombat.length,
  0,
  "retreating attacks do not make an ally eligible for combat-only troop donations",
);

const activeOutgoingCombat = await runDonation({
  allyIncomingAttacks: [{ retreating: () => true }],
  allyOutgoingAttacks: [{ retreating: () => true }, { retreating: () => false }],
});
assert.equal(
  activeOutgoingCombat.length,
  1,
  "one active outgoing attack still makes an ally eligible for combat-only troop donations",
);
assert.equal(
  strongestBorderCap[0]?.troops,
  499,
  "odd enemy army keeps the safer fractional half reserve",
);
assert.ok(
  1000 - strongestBorderCap[0].troops >= 1001 / 2,
  "donation leaves at least half of the strongest border enemy",
);

const nonBorderStrongest = await runDonation({
  opponents: [
    makePlayer({ id: 3, name: "border-enemy", troops: 400, friendly: false, border: true }),
    makePlayer({ id: 4, name: "remote-enemy", troops: 1200, friendly: false, border: false }),
  ],
});
assert.equal(nonBorderStrongest[0]?.troops, 580, "non-border enemies do not lower the 42% reserve");

const friendlyBorder = await runDonation({
  friendlyBorder: true,
  allyTroops: 1200,
  opponents: [],
});
assert.equal(friendlyBorder[0]?.troops, 400, "allied border players still determine the reserve");
assert.ok(
  1000 - friendlyBorder[0].troops >= 1200 / 2,
  "the reserve includes an allied border player's army",
);

const minimumKeepReserve = await runDonation();
assert.equal(minimumKeepReserve[0]?.troops, 580, "donation leaves at least 42% of maximum troops");
assert.ok(
  1000 - minimumKeepReserve[0].troops <= 1000 * (1 - 0.42),
  "the donation does not cross the 42% reserve",
);

const beingAttacked = await runDonation({ beingAttacked: true });
assert.equal(beingAttacked.length, 0, "donation is skipped while being attacked");

const sharedIncomingAttackGate = await runDonation({
  beingAttacked: true,
  supportsUnitApi: false,
  returnDetails: true,
});
assert.equal(
  sharedIncomingAttackGate.maritime?.active,
  true,
  "the shared donation gate reports land attacks even without transport data",
);
assert.equal(sharedIncomingAttackGate.maritime?.reason, "incoming-attack");

const attackedDuringBorderLookup = await runDonation({ attackDuringBorderLookup: true });
assert.equal(
  attackedDuringBorderLookup.length,
  0,
  "donation is skipped if an attack starts during the border lookup",
);

const maritimeEnemy = makePlayer({
  id: 5,
  name: "maritime-enemy",
  troops: 1800,
  friendly: false,
});
const maritimeInvasion = await runDonation({
  opponents: [maritimeEnemy],
  incomingTransports: [
    makeTransport({ owner: maritimeEnemy, troops: 700 }),
    makeTransport({ owner: maritimeEnemy, troops: 500 }),
  ],
  returnDetails: true,
});
assert.equal(maritimeInvasion.maritime?.active, true);
assert.equal(
  maritimeInvasion.maritime?.troops,
  1200,
  "incoming enemy transport troops are summed as the maritime invasion force",
);
assert.equal(
  maritimeInvasion.packets.length,
  0,
  "all troop donations stop while an enemy maritime invasion is inbound",
);

const maritimeGoldInvasion = await runDonation({
  opponents: [maritimeEnemy],
  incomingTransports: [makeTransport({ owner: maritimeEnemy, troops: 700 })],
  autoDonateTroops: false,
  autoDonateGold: true,
  gold: 5000,
  goldThreshold: 1000,
  returnDetails: true,
});
assert.equal(
  maritimeGoldInvasion.packets.length,
  0,
  "gold donations also stop while the Port/destroyer reserve is active",
);

const noSafeDonation = await runDonation({
  opponents: [
    makePlayer({ id: 3, name: "overwhelming-enemy", troops: 2001, friendly: false, border: true }),
  ],
});
assert.equal(noSafeDonation.length, 0, "donation is skipped when no positive safe amount exists");

const missingBorderApi = await runDonation({ supportsBorderApi: false });
assert.equal(missingBorderApi.length, 0, "donation fails closed without border data");

const missingUnitApi = await runDonation({ supportsUnitApi: false });
assert.equal(missingUnitApi.length, 0, "donation fails closed without transport data");

process.stdout.write("auto-donate troop reserve tests passed\n");
