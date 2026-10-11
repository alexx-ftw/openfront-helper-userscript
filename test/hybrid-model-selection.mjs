import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

const source = readRepositoryFile("engine/ingame/auto-bot/panel.js");
const prefix = source.slice(0, source.indexOf("  restoreHybridCombatSelection();"));
const schemas = [
  ["ofh-combat-compact-tanh-v2", "compact-tanh-v1"],
  ["ofh-combat-compact-tanh-v3", "compact-frontier-v1"],
];
for (const [schema, kind] of schemas) {
  for (const reward of [
    "own-land-share-change-at-commitment-end",
    "discounted-terminal-win-return-v1",
  ]) {
    for (const learning of [false, true]) {
      const calls = [];
      const stored = new Map([
        ["openfront-helper-hybrid-backend", kind],
        [
          "openfront-helper-hybrid-combat-v2",
          JSON.stringify({ model: { schema, reward }, config: { mode: "shadow", learning } }),
        ],
      ]);
      const window = {
        localStorage: { getItem: (key) => stored.get(key) },
        __OFH_hybridCombat: {
          importModel: (model) => calls.push(["import", model.schema]),
          configure: (config) => calls.push(["configure", config.learning]),
        },
      };
      executeClassicScript(`${prefix}\nrestoreHybridCombatSelection();`, { window });
      if (reward === "discounted-terminal-win-return-v1" && learning) {
        assert.equal(calls.length, 0, "invalid stored offline settings cannot partly import");
        assert.match(window.__OFH_hybridStorageError, /offline learning/);
      } else {
        assert.deepEqual(calls, [
          ["import", schema],
          ["configure", learning],
        ]);
      }
    }
  }
}
const helpers = executeClassicScript(
  `${prefix}\n({kind:hybridModelKind, offline:hybridOfflineModel})`,
  { window: {} },
);
assert.equal(helpers.kind({ schema: "ofh-combat-ridge-v1" }), "ridge-v1");
assert.throws(() => helpers.kind({ schema: "unknown" }), /Unknown/);
assert.throws(() => helpers.kind({ schema: "__proto__" }), /Unknown/);
assert.equal(helpers.offline({ reward: "potential-shaped-land-delta-ticks-v2" }), true);
const fields = new Map();
for (const selector of [
  "[data-hybrid-mode]",
  "[data-hybrid-learning]",
  "[data-hybrid-model]",
  "[data-hybrid-status]",
  "[data-hybrid-kind]",
  "[data-hybrid-export]",
  "[data-hybrid-import]",
]) {
  fields.set(selector, {
    value: "",
    listeners: {},
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
  });
}
let active = { schema: "ofh-combat-ridge-v1", reward: "own-land-share-change-at-commitment-end" };
const imports = [];
const window = {
  localStorage: { setItem() {} },
  __OFH_hybridCombat: {
    diagnostics: () => ({ mode: "shadow", learning: false, samples: {} }),
    exportModel: () => active,
    createCompactModel: (options) => ({
      schema:
        options?.featureProfile === "frontier-v1"
          ? "ofh-combat-compact-tanh-v3"
          : "ofh-combat-compact-tanh-v2",
    }),
    importModel(model) {
      imports.push(model);
      active = model;
    },
  },
};
const start = source.indexOf("    const hybrid = window.__OFH_hybridCombat;");
const end = source.indexOf("    // ── Config tab wiring", start);
assert.ok(start > 0 && end > start, "real panel listener boundary exists");
executeClassicScript(`${prefix}\n${source.slice(start, end)}`, {
  window,
  panel: { querySelector: (selector) => fields.get(selector) },
  tr: (text) => text,
});
const kind = fields.get("[data-hybrid-kind]");
const modelField = fields.get("[data-hybrid-model]");
kind.value = "compact-frontier-v1";
kind.listeners.change();
assert.equal(JSON.parse(modelField.value).schema, "ofh-combat-compact-tanh-v3");
assert.equal(imports.length, 0, "choosing a draft cannot activate it");
modelField.value = JSON.stringify({ schema: "ofh-combat-compact-tanh-v2" });
fields.get("[data-hybrid-import]").listeners.click();
assert.equal(imports.length, 0, "mismatched draft kind cannot replace active model");
modelField.value = JSON.stringify({
  schema: "ofh-combat-compact-tanh-v3",
  reward: "discounted-terminal-win-return-v1",
});
fields.get("[data-hybrid-import]").listeners.click();
assert.equal(imports.length, 1);
assert.equal(
  fields.get("[data-hybrid-learning]").disabled,
  true,
  "offline terminal model cannot opt into live tactical labels",
);
process.stdout.write("hybrid model selection: v2/v3 restore and offline learning gates passed\n");
