import { executeClassicScript } from "./classic-script.mjs";
import { readStructureBehaviorSource } from "./structure-behavior-source.mjs";

const source = readStructureBehaviorSource();

export function createStructureUpgradeFixture({ UNIT, Difficulty, state, bindings = {} }) {
  const emitted = [];
  const sandbox = {
    UNIT,
    Difficulty,
    state,
    console,
    tr: (key) => key,
    setLastAction: (text, cat) => {
      state.lastAction = { text, cat };
    },
    getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
    sendAutoBotBuildOrUpgrade: (menu, bu) => {
      emitted.push(bu);
      return true;
    },
    autoBotBuildAllowed: () => true,
    ...bindings,
  };
  const behavior = executeClassicScript(
    source + "\nObject.create(StructureBehavior.prototype);",
    sandbox,
  );
  return { behavior, emitted, state };
}
