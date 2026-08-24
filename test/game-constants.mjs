import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectGameConstants } from "../scripts/game-constants.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repositoryRoot, "test/fixtures/game-constants.json");
const expected = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const actual = collectGameConstants(repositoryRoot);

assert.ok(Array.isArray(expected), "the game constant contract must be an array");
assert.equal(new Set(expected.map((entry) => entry.id)).size, expected.length);
assert.equal(new Set(actual.map((entry) => entry.id)).size, actual.length);
const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
assert.ok(
  expected.length >= actual.length,
  "the game constant contract cannot cover fewer declarations than the source",
);

for (const entry of actual) {
  const expectedEntry = expectedById.get(entry.id);
  assert.ok(expectedEntry, `missing game constant contract for ${entry.file}:${entry.name}`);
  assert.deepEqual(
    entry,
    expectedEntry,
    `game constant contract drift at ${entry.file}:${entry.name}`,
  );
}

process.stdout.write(`game constant contract tests passed (${actual.length} constants)\n`);
