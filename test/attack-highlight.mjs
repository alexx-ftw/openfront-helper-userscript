import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

const SOURCE = readRepositoryFile("engine/ingame/attack-highlight.js");
const TEST_SOURCE = `${SOURCE}\nwindow.__scanAttackHighlight = scanAttackHighlight;\nwindow.__getAttackHighlightScan = () => _attackHighlightScan;`;

const hostile = { nameLocation: () => ({ x: 10, y: 20 }) };
const ally = { nameLocation: () => ({ x: 30, y: 40 }) };
let incomingAttacks = [];
const me = {
  nameLocation: () => ({ x: 1, y: 2 }),
  incomingAttacks: () => incomingAttacks,
  isFriendly: (player) => player === ally,
};
const game = {
  myPlayer: () => me,
  playerBySmallID: (id) => {
    if (id === 2) return hostile;
    if (id === 3) return ally;
    return null;
  },
};
const sandbox = {
  window: {},
  runtimeState: { attackHighlightEnabled: true },
  registerMapOverlayLayer: () => {},
};

executeClassicScript(TEST_SOURCE, sandbox, { filename: "attack-highlight.js" });

incomingAttacks = [
  { attackerID: 2, troops: 100, retreating: false },
  { attackerID: 2, troops: 50, retreating: () => false },
  { attackerID: 2, troops: 1000, retreating: () => true },
  { attackerID: 3, troops: 900, retreating: false },
  { attackerID: 4, troops: 700, retreating: false },
];
sandbox.window.__scanAttackHighlight(game);
let scan = sandbox.window.__getAttackHighlightScan();
assert.equal(scan.attackers.length, 1);
assert.equal(scan.attackers[0].troops, 150);
assert.equal(scan.total, 150, "the displayed total includes only live, resolved hostile attacks");

incomingAttacks = [{ attackerID: 2, troops: 500, retreating: true }];
sandbox.window.__scanAttackHighlight(game);
scan = sandbox.window.__getAttackHighlightScan();
assert.equal(scan.attackers.length, 0);
assert.equal(scan.total, 0, "withdrawn attacks clear the highlighted threat total");

process.stdout.write("attack highlight tests passed\n");
