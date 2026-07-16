import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "espree";
import { KEYS } from "eslint-visitor-keys";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = path.join(repoRoot, "engine/ingame/runtime.js");
const runtimeSource = fs.readFileSync(runtimePath, "utf8");
const ingameDir = path.join(repoRoot, "engine/ingame");
const ingameSource = fs
  .readdirSync(ingameDir)
  .filter((name) => name.endsWith(".js") && name !== "runtime.js")
  .map((name) => fs.readFileSync(path.join(ingameDir, name), "utf8"))
  .join("\n");

const runtimeConstants = [...runtimeSource.matchAll(/^const ([A-Za-z_$][\w$]*)\s*=/gm)].map(
  (match) => match[1],
);
const incorrectlyConstant = runtimeConstants.filter((name) => {
  const escaped = name.replaceAll("$", "\\$");
  const assignment = new RegExp(
    `(?:^|[^.\\w$])${escaped}\\s*(?:=|\\+=|-=|\\*=|/=|\\+\\+|--)`,
    "gm",
  );
  return assignment.test(ingameSource);
});

assert.deepEqual(
  incorrectlyConstant,
  [],
  `runtime bindings assigned by later classic scripts must use let: ${incorrectlyConstant.join(", ")}`,
);

assert.match(
  runtimeSource,
  /^const runtimeState = Object\.create\(null\);$/m,
  "shared mutable state must live behind an explicit const object",
);

const runtimeStateFields = new Set(
  [...runtimeSource.matchAll(/^runtimeState\.([A-Za-z_$][\w$]*)\s*=/gm)].map((match) => match[1]),
);
assert.ok(runtimeStateFields.size > 0, "runtime state must declare shared fields");

const setterLocations = new Map();
function visit(node, fileName) {
  if (!node || typeof node.type !== "string") return;

  if (
    node.type === "AssignmentExpression" &&
    node.left.type === "MemberExpression" &&
    !node.left.computed &&
    node.left.object.type === "Identifier" &&
    node.left.object.name === "runtimeState" &&
    node.left.property.type === "Identifier"
  ) {
    const field = node.left.property.name;
    const locations = setterLocations.get(field) ?? [];
    locations.push(fileName);
    setterLocations.set(field, locations);
  }

  for (const key of KEYS[node.type] ?? []) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) visit(item, fileName);
    } else {
      visit(child, fileName);
    }
  }
}

for (const fileName of fs
  .readdirSync(ingameDir)
  .filter((name) => name.endsWith(".js") && name !== "runtime.js")) {
  const source = fs.readFileSync(path.join(ingameDir, fileName), "utf8");
  visit(parse(source, { ecmaVersion: "latest", sourceType: "script" }), fileName);
}

const undeclaredSetterFields = [...setterLocations.keys()].filter(
  (field) => !runtimeStateFields.has(field),
);
assert.deepEqual(
  undeclaredSetterFields,
  [],
  `every migrated setter must target a declared runtime field: ${undeclaredSetterFields.join(", ")}`,
);

const legacyMutableBindings = [...runtimeStateFields].filter((field) => {
  const escaped = field.replaceAll("$", "\\$");
  return new RegExp(`^let ${escaped}\\s*=`, "m").test(runtimeSource);
});
assert.deepEqual(
  legacyMutableBindings,
  [],
  `migrated state must not retain cross-file let bindings: ${legacyMutableBindings.join(", ")}`,
);

assert.ok(
  setterLocations.size > 0,
  "the migration test must inventory setters in later classic scripts",
);

const lobbyDir = path.join(repoRoot, "engine/lobby");
const lobbyCoreSource = fs.readFileSync(path.join(lobbyDir, "core.js"), "utf8");
const lobbyStateBody = lobbyCoreSource.match(/const lobbyState = \{([\s\S]*?)\n\};/)?.[1] ?? "";
const lobbyStateFields = new Set(
  [...lobbyStateBody.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map((match) => match[1]),
);
assert.ok(
  lobbyStateFields.size > 0,
  "lobby shared mutable state must use an explicit const object",
);

const lobbySetterLocations = new Map();
function visitLobbyState(node, fileName) {
  if (!node || typeof node.type !== "string") return;
  if (
    node.type === "AssignmentExpression" &&
    node.left.type === "MemberExpression" &&
    !node.left.computed &&
    node.left.object.type === "Identifier" &&
    node.left.object.name === "lobbyState" &&
    node.left.property.type === "Identifier"
  ) {
    const field = node.left.property.name;
    const locations = lobbySetterLocations.get(field) ?? [];
    locations.push(fileName);
    lobbySetterLocations.set(field, locations);
  }
  for (const key of KEYS[node.type] ?? []) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) visitLobbyState(item, fileName);
    } else {
      visitLobbyState(child, fileName);
    }
  }
}

for (const fileName of fs.readdirSync(lobbyDir).filter((name) => name.endsWith(".js"))) {
  const source = fs.readFileSync(path.join(lobbyDir, fileName), "utf8");
  visitLobbyState(parse(source, { ecmaVersion: "latest", sourceType: "script" }), fileName);
}

assert.deepEqual(
  [...lobbySetterLocations.keys()].filter((field) => !lobbyStateFields.has(field)),
  [],
  "every migrated lobby setter must target a declared lobbyState field",
);
assert.ok(lobbySetterLocations.size > 0, "the migration test must inventory lobby setters");
for (const field of lobbyStateFields) {
  assert.doesNotMatch(
    lobbyCoreSource,
    new RegExp(`^let ${field.replaceAll("$", "\\$")}\\s*=`, "m"),
    `migrated lobby state must not retain the legacy let binding: ${field}`,
  );
}

process.stdout.write("runtime mutable-state declaration tests passed\n");
