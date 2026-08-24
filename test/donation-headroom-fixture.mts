import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { DonateTroopsExecution } from "../openfront-engine/src/core/execution/DonateTroopExecution";
import { SpawnExecution } from "../openfront-engine/src/core/execution/SpawnExecution";
import { PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game";
import { setup } from "../openfront-engine/tests/util/Setup";

const engineTestsUtil = fileURLToPath(new URL("../openfront-engine/tests/util/", import.meta.url));
const donorInfo = new PlayerInfo("donor", PlayerType.Human, null, "donor");
const recipientInfo = new PlayerInfo("recipient", PlayerType.Human, null, "recipient");
const game = await setup(
  "big_plains",
  { donateTroops: true, infiniteTroops: false },
  [donorInfo, recipientInfo],
  engineTestsUtil,
);

const donor = game.player(donorInfo.id);
const recipient = game.player(recipientInfo.id);
game.addExecution(
  new SpawnExecution("donation-headroom", donorInfo, game.ref(10, 10)),
  new SpawnExecution("donation-headroom", recipientInfo, game.ref(20, 20)),
);
game.executeNextTick();
game.executeNextTick();

const allianceRequest = donor.createAllianceRequest(recipient);
assert.notEqual(allianceRequest, null);
allianceRequest.accept();

donor.addTroops(10_000);
const recipientMaxTroops = game.config().maxTroops(recipient);
recipient.addTroops(recipientMaxTroops - recipient.troops() - 100);
const recipientHeadroom = recipientMaxTroops - recipient.troops();
assert.ok(recipientHeadroom > 0 && recipientHeadroom < 5_000);
assert.equal(donor.isAlive(), true);
assert.equal(recipient.isAlive(), true);
assert.equal(donor.isFriendly(recipient), true);
assert.equal(donor.canDonateTroops(recipient), true);
const donorBefore = donor.troops();
const recipientBefore = recipient.troops();

const donation = new DonateTroopsExecution(donor, recipient.id(), 5_000);
donation.init(game, game.ticks());
donation.tick(game.ticks());

const transferredTroops = Math.floor(recipientHeadroom);
assert.equal(recipient.troops() - recipientBefore, transferredTroops);
assert.equal(donorBefore - donor.troops(), transferredTroops);

console.log("donation headroom engine fixture passed");
