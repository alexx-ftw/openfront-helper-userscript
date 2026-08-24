import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Both the classic helper engine and the upstream game use uppercase identifiers for semantic
// constants; lower-case consts are ordinary per-call locals and are intentionally outside this
// game-constant contract.
const GAME_CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/u;
const PREVIEW_LIMIT = 240;
const SOURCE_ROOTS = ["engine", "openfront-engine/src"];

function listSourceFiles(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(entryPath, result);
    } else if (entry.isFile() && /\.(?:js|ts|tsx)$/u.test(entry.name)) {
      result.push(entryPath);
    }
  }
  return result.sort();
}

function canonicalInitializer(initializer, sourceFile) {
  return ts
    .createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true })
    .printNode(ts.EmitHint.Expression, initializer, sourceFile)
    .trim();
}

function valueRecord({ file, name, declarationKind, initializerKind, canonical, occurrence }) {
  return {
    id: `${file}:${name}#${occurrence}`,
    file,
    name,
    declarationKind,
    initializerKind,
    initializerHash: crypto.createHash("sha256").update(canonical).digest("hex"),
    initializerLength: canonical.length,
    initializerPreview:
      canonical.length <= PREVIEW_LIMIT ? canonical : `${canonical.slice(0, PREVIEW_LIMIT - 3)}...`,
  };
}

function constantRecord({ file, name, declarationKind, initializer, sourceFile, occurrence }) {
  return valueRecord({
    file,
    name,
    declarationKind,
    initializerKind: ts.SyntaxKind[initializer.kind],
    canonical: canonicalInitializer(initializer, sourceFile),
    occurrence,
  });
}

function gameVariableDeclarationKind(node) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return null;
  const declarationList = node.parent;
  if (!ts.isVariableDeclarationList(declarationList)) return null;
  if (!GAME_CONSTANT_NAME.test(node.name.text)) return null;
  const flags = declarationList.flags;
  if ((flags & ts.NodeFlags.Const) !== 0) return "const";
  return (flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0 ? "var" : null;
}

function isStaticReadonlyProperty(node) {
  if (!ts.isPropertyDeclaration(node) || !ts.isIdentifier(node.name)) return false;
  if (!GAME_CONSTANT_NAME.test(node.name.text)) return false;
  const modifiers = node.modifiers ?? [];
  return (
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
  );
}

export function collectGameConstants(repositoryRoot) {
  const records = [];

  for (const sourceRoot of SOURCE_ROOTS) {
    const rootPath = path.join(repositoryRoot, sourceRoot);
    for (const filePath of listSourceFiles(rootPath)) {
      const file = path.relative(repositoryRoot, filePath).split(path.sep).join("/");
      const source = fs.readFileSync(filePath, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
      );
      if (sourceFile.parseDiagnostics.length > 0) {
        const message = ts.flattenDiagnosticMessageText(
          sourceFile.parseDiagnostics[0].messageText,
          " ",
        );
        throw new Error(`Cannot parse ${file}: ${message}`);
      }

      const occurrences = new Map();
      const addRecord = (name, declarationKind, initializer) => {
        if (!initializer) return;
        const occurrenceKey = `${file}:${name}`;
        const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
        occurrences.set(occurrenceKey, occurrence);
        records.push(
          constantRecord({
            file,
            name,
            declarationKind,
            initializer,
            sourceFile,
            occurrence,
          }),
        );
      };
      const addEnumMemberRecord = (enumName, member, memberIndex) => {
        const memberName = member.name.getText(sourceFile);
        const name = `${enumName}.${memberName}`;
        const occurrenceKey = `${file}:${name}`;
        const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
        occurrences.set(occurrenceKey, occurrence);
        const canonical = member.initializer
          ? canonicalInitializer(member.initializer, sourceFile)
          : `implicit enum value at index ${memberIndex}`;
        records.push(
          valueRecord({
            file,
            name,
            declarationKind: "enum member",
            initializerKind: member.initializer
              ? ts.SyntaxKind[member.initializer.kind]
              : "ImplicitEnumMember",
            canonical,
            occurrence,
          }),
        );
      };
      const visit = (node) => {
        const declarationKind = gameVariableDeclarationKind(node);
        if (declarationKind) addRecord(node.name.text, declarationKind, node.initializer);
        if (isStaticReadonlyProperty(node)) {
          addRecord(node.name.text, "static readonly", node.initializer);
        }
        if (ts.isEnumDeclaration(node)) {
          node.members.forEach((member, memberIndex) =>
            addEnumMemberRecord(node.name.text, member, memberIndex),
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  return records;
}

export function writeGameConstantFixture(repositoryRoot) {
  const fixturePath = path.join(repositoryRoot, "test/fixtures/game-constants.json");
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  const records = collectGameConstants(repositoryRoot);
  fs.writeFileSync(fixturePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return { fixturePath, count: records.length };
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--write")) {
  const result = writeGameConstantFixture(repositoryRoot);
  process.stdout.write(`Wrote ${result.count} game constant contracts to ${result.fixturePath}\n`);
}
