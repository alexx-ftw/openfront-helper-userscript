import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = path.join(repoRoot, "engine/ingame/runtime.js");
const runtimeSource = fs.readFileSync(runtimePath, "utf8");
const ingameDir = path.join(repoRoot, "engine/ingame");
const ingameSource = fs
  .readdirSync(ingameDir)
  .filter((name) => name.endsWith(".js") && name !== "runtime.js")
  .map((name) => fs.readFileSync(path.join(ingameDir, name), "utf8"))
  .join("\n");

const runtimeConstants = [
  ...runtimeSource.matchAll(/^const ([A-Za-z_$][\w$]*)\s*=/gm),
].map((match) => match[1]);
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

process.stdout.write("runtime mutable-state declaration tests passed\n");
