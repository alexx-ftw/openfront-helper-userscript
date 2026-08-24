import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";
const sandbox = {};

executeClassicScript(readRepositoryFile("engine/ingame/shared-utils.js"), sandbox, {
  filename: "shared-utils.js",
});
executeClassicScript(readRepositoryFile("engine/ingame/nuke-prediction.js"), sandbox, {
  filename: "nuke-prediction.js",
});
executeClassicScript(
  `${readRepositoryFile("engine/ingame/retaliation-hud.js")}
globalThis.__isHostileNukeTargetingMe = isHostileNukeTargetingMe;`,
  sandbox,
  { filename: "retaliation-hud.js" },
);

const makePlayer = ({ id, team = null, friendly = false }) => ({
  isPlayer: () => true,
  smallID: () => id,
  team: () => team,
  isFriendly: () => friendly,
});

const me = makePlayer({ id: 1, team: null, friendly: true });
const diplomaticAlly = makePlayer({ id: 2, team: null, friendly: true });
const teammate = makePlayer({ id: 3, team: "blue", friendly: true });
const teamMe = makePlayer({ id: 1, team: "blue", friendly: true });

assert.equal(
  sandbox.getNukePredictionRelation({ myPlayer: () => me }, { owner: () => diplomaticAlly }),
  "enemy",
  "a breakable diplomatic ally's nuke remains an enemy nuke",
);
assert.equal(
  sandbox.getNukePredictionRelation({ myPlayer: () => teamMe }, { owner: () => teammate }),
  "ally",
  "a permanent teammate's nuke remains an ally nuke",
);
assert.equal(
  sandbox.__isHostileNukeTargetingMe(
    {
      isActive: () => true,
      type: () => "Atom Bomb",
      owner: () => diplomaticAlly,
      targetTile: () => 10,
    },
    { ownerID: () => 1 },
    me,
  ),
  true,
  "retaliation treats a diplomatic ally's incoming nuke as hostile",
);

console.warn("nuke prediction relation tests passed");
