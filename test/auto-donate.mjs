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
  const player = {
    id: () => id,
    smallID: () => id,
    displayName: () => name,
    troops: () => troops,
    gold: () => gold,
    isAlive: () => true,
    friendly,
    isFriendly: () => player.friendly,
    incomingAttacks: () => incomingAttacks ?? (inCombat ? [{}] : []),
    outgoingAttacks: () => outgoingAttacks,
    sharesBorder: border,
  };
  return player;
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
    transportShipState: () => ({ isRetreating: retreating }),
    targetTile: () => targetTile,
    owner: () => owner,
    troops: () => troops,
  };
}

const DONATION_DEFAULTS = {
  opponents: [],
  friendlyBorder: false,
  allyTroops: 50,
  allyMaxTroops: 1000,
  allyFriendly: true,
  supportsBorderApi: true,
  supportsUnitApi: true,
  beingAttacked: false,
  attackDuringBorderLookup: false,
  allyTurnsHostileDuringBorderLookup: false,
  incomingTransports: [],
  autoDonateTroops: true,
  autoDonateGold: false,
  donateGoldAllowed: true,
  gold: 0,
  allyGold: 0,
  goldThreshold: 1000,
  returnDetails: false,
  allyIncomingAttacks: undefined,
  allyOutgoingAttacks: [],
  ownIncomingAttacks: undefined,
  tickCount: 1,
  tickAdvanceMs: 0,
};

async function runDonation(options = {}) {
  const {
    opponents,
    friendlyBorder,
    allyTroops,
    allyMaxTroops,
    allyFriendly,
    supportsBorderApi,
    supportsUnitApi,
    beingAttacked,
    attackDuringBorderLookup,
    allyTurnsHostileDuringBorderLookup,
    incomingTransports,
    autoDonateTroops,
    autoDonateGold,
    donateGoldAllowed,
    gold,
    allyGold,
    goldThreshold,
    returnDetails,
    allyIncomingAttacks,
    allyOutgoingAttacks,
    ownIncomingAttacks,
    tickCount,
    tickAdvanceMs,
  } = { ...DONATION_DEFAULTS, ...options };
  const packets = [];
  let currentlyBeingAttacked = beingAttacked;
  let now = 5000;
  let borderLookupHook = () => {};
  const me = {
    id: () => 1,
    smallID: () => 1,
    troops: () => 1000,
    gold: () => gold,
    isAlive: () => true,
    isFriendly: (player) => Boolean(player.friendly),
    incomingAttacks: () => ownIncomingAttacks ?? (currentlyBeingAttacked ? [{}] : []),
    outgoingAttacks: () => [],
  };
  if (supportsBorderApi) {
    me.borderTiles = async () => {
      if (attackDuringBorderLookup) currentlyBeingAttacked = true;
      borderLookupHook();
      return { borderTiles: new Set([1]) };
    };
  }

  const ally = makePlayer({
    id: 2,
    name: "ally",
    troops: allyTroops,
    gold: allyGold,
    friendly: allyFriendly,
    border: friendlyBorder,
    inCombat: true,
    incomingAttacks: allyIncomingAttacks,
    outgoingAttacks: allyOutgoingAttacks,
  });
  if (allyTurnsHostileDuringBorderLookup) {
    borderLookupHook = () => {
      ally.friendly = false;
    };
  }
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
      donateGold: () => donateGoldAllowed,
      maxTroops: (player) => (player === ally ? allyMaxTroops : 1000),
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
    Date: { now: () => now },
    console: { log() {}, error() {} },
  };

  executeClassicScript(
    `${SOURCE}\nglobalThis.__autoDonateSelectors = { findNeediestAutoDonateTarget, findPoorestAutoDonateTarget };`,
    sandbox,
    { filename: "auto-donate.js" },
  );
  for (let tickIndex = 0; tickIndex < tickCount; tickIndex++) {
    await sandbox.window.__OFH_tickAutoDonate();
    now += tickAdvanceMs;
  }
  if (returnDetails) {
    return {
      packets,
      maritime: sandbox.window.__OFH_getIncomingMaritimeInvasion(game, me),
      selectors: sandbox.__autoDonateSelectors,
      game,
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

const hostileNamedRecipient = await runDonation({
  allyFriendly: false,
  autoDonateTroops: true,
  autoDonateGold: true,
  gold: 5000,
});
assert.deepEqual(
  hostileNamedRecipient,
  [],
  "a configured name cannot receive troops or gold after becoming hostile",
);

const relationshipChangesDuringLookup = await runDonation({
  allyTurnsHostileDuringBorderLookup: true,
});
assert.deepEqual(
  relationshipChangesDuringLookup,
  [],
  "troops are not sent when the selected ally becomes hostile during the border lookup",
);

const disabledGoldDonation = await runDonation({
  autoDonateTroops: false,
  autoDonateGold: true,
  donateGoldAllowed: false,
  gold: 5000,
});
assert.deepEqual(disabledGoldDonation, [], "gold donation respects the live game configuration");

const validGoldOnlyDonation = await runDonation({
  autoDonateTroops: false,
  autoDonateGold: true,
  gold: 5000,
  goldThreshold: 1000,
});
assert.equal(validGoldOnlyDonation.length, 1);
assert.equal(validGoldOnlyDonation[0]?.type, "donate_gold");
assert.equal(validGoldOnlyDonation[0]?.recipient, 2);
assert.equal(
  validGoldOnlyDonation[0]?.gold,
  4000,
  "a valid gold-only donation passes the live game into the cooldown gate",
);

const donationSelectorHarness = await runDonation({ returnDetails: true });
const equalTroopRecipients = [
  { troops: () => 250, gold: () => 500 },
  { troops: () => 250, gold: () => 100 },
  { troops: () => 600, gold: () => 50 },
];
assert.strictEqual(
  donationSelectorHarness.selectors.findNeediestAutoDonateTarget(
    equalTroopRecipients,
    donationSelectorHarness.game,
  ),
  equalTroopRecipients[0],
  "linear troop recipient selection preserves the first recipient on an equal percentage",
);
assert.strictEqual(
  donationSelectorHarness.selectors.findPoorestAutoDonateTarget(equalTroopRecipients),
  equalTroopRecipients[2],
  "linear gold recipient selection preserves the poorest eligible recipient",
);

const prematureRepeatDonation = await runDonation({
  tickCount: 2,
  tickAdvanceMs: 3001,
});
assert.equal(
  prematureRepeatDonation.length,
  1,
  "the engine's ten-second per-recipient donation cooldown blocks a three-second retry",
);

const readyRepeatDonation = await runDonation({
  tickCount: 2,
  tickAdvanceMs: 10000,
});
assert.equal(
  readyRepeatDonation.length,
  2,
  "the same recipient becomes eligible again when the engine cooldown expires",
);

const combatTroopsBeforeGold = await runDonation({
  autoDonateTroops: true,
  autoDonateGold: true,
  gold: 5000,
});
assert.deepEqual(
  combatTroopsBeforeGold.map((packet) => packet.type),
  ["donate_troops"],
  "combat troops claim the shared recipient cooldown before an optional gold transfer",
);

const fullCombatAlly = await runDonation({
  allyTroops: 1000,
  allyMaxTroops: 1000,
});
assert.deepEqual(
  fullCombatAlly,
  [],
  "a full combat ally is not selected for a troop donation the engine would discard",
);

const nearlyFullCombatAlly = await runDonation({
  allyTroops: 950,
  allyMaxTroops: 1000,
});
assert.equal(
  nearlyFullCombatAlly[0]?.troops,
  50,
  "troop donations are capped to the recipient's remaining capacity",
);

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
  allyMaxTroops: 2000,
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

const ownRetreatingAttack = await runDonation({
  ownIncomingAttacks: [{ retreating: () => true }],
});
assert.equal(
  ownRetreatingAttack.length,
  1,
  "an incoming retreat no longer blocks an otherwise safe allied donation",
);

const ownMixedIncomingAttacks = await runDonation({
  ownIncomingAttacks: [{ retreating: () => true }, { retreating: () => false }],
});
assert.equal(
  ownMixedIncomingAttacks.length,
  0,
  "one active incoming attack still blocks allied donations",
);

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

const cancelledMaritimeInvasion = await runDonation({
  opponents: [maritimeEnemy],
  incomingTransports: [makeTransport({ owner: maritimeEnemy, troops: 700, retreating: true })],
  returnDetails: true,
});
assert.equal(
  cancelledMaritimeInvasion.maritime?.active,
  false,
  "a retreating transport no longer reserves troops for a cancelled landing",
);
assert.equal(
  cancelledMaritimeInvasion.packets.length,
  1,
  "a cancelled maritime landing no longer blocks a safe allied donation",
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
