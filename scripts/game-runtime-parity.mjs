import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

function parseTypeScript(relativePath) {
  const source = read(relativePath);
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  assert.equal(sourceFile.parseDiagnostics.length, 0, `${relativePath} must remain parseable`);
  return sourceFile;
}

function findEnum(sourceFile, enumName) {
  let declaration = null;
  function visit(node) {
    if (ts.isEnumDeclaration(node) && node.name.text === enumName) {
      declaration = node;
    }
    if (!declaration) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(declaration, `missing ${enumName} enum`);
  return new Map(
    declaration.members.map((member) => {
      assert.ok(ts.isIdentifier(member.name), `${enumName} members must be identifiers`);
      assert.ok(
        member.initializer && ts.isStringLiteral(member.initializer),
        `${enumName}.${member.name.text} must have a string value`,
      );
      return [member.name.text, member.initializer.text];
    }),
  );
}

function findObject(sourceFile, variableName) {
  let initializer = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      initializer = node.initializer;
    }
    if (!initializer) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(initializer, `missing ${variableName} object`);
  return new Map(
    initializer.properties.map((property) => {
      assert.ok(ts.isPropertyAssignment(property), `${variableName} must use properties`);
      const key = property.name;
      const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
      assert.ok(name, `${variableName} property names must be static`);
      assert.ok(
        ts.isStringLiteral(property.initializer),
        `${variableName}.${name} must be a string value`,
      );
      return [name, property.initializer.text];
    }),
  );
}

function findMethod(sourceFile, methodName) {
  let declaration = null;
  function visit(node) {
    if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName
    ) {
      declaration = node;
    }
    if (!declaration) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(declaration, `missing Config.${methodName}()`);
  return declaration;
}

function findSwitch(sourceFile, methodName) {
  const method = findMethod(sourceFile, methodName);
  let declaration = null;
  function visit(node) {
    if (ts.isSwitchStatement(node)) {
      declaration = node;
      return;
    }
    if (!declaration) ts.forEachChild(node, visit);
  }
  if (method.body) ts.forEachChild(method.body, visit);
  assert.ok(declaration, `Config.${methodName}() must contain a switch over UnitType`);
  return declaration;
}

function isUnitTypeCase(clause, type) {
  return (
    ts.isCaseClause(clause) &&
    ts.isPropertyAccessExpression(clause.expression) &&
    ts.isIdentifier(clause.expression.expression) &&
    clause.expression.expression.text === "UnitType" &&
    clause.expression.name.text === type
  );
}

function switchCaseClauses(sourceFile, methodName, type) {
  const clauses = [...findSwitch(sourceFile, methodName).caseBlock.clauses];
  const start = clauses.findIndex((clause) => isUnitTypeCase(clause, type));
  assert.notEqual(start, -1, `missing UnitType.${type} case in Config.${methodName}()`);
  let end = start + 1;
  if (clauses[start].statements.length === 0) {
    while (end < clauses.length && ts.isCaseClause(clauses[end])) {
      const clause = clauses[end];
      end += 1;
      if (clause.statements.length > 0) break;
    }
  }
  return clauses.slice(start, end);
}

function findReturnExpression(sourceFile, methodName, type) {
  for (const clause of switchCaseClauses(sourceFile, methodName, type)) {
    let expression = null;
    function visit(node) {
      if (ts.isReturnStatement(node) && node.expression) {
        expression = node.expression;
        return;
      }
      if (!expression) ts.forEachChild(node, visit);
    }
    for (const statement of clause.statements) {
      if (!expression) visit(statement);
    }
    if (expression) return expression;
  }
  assert.fail(`Config.${methodName}(${type}) must return a value`);
}

function findCaseObject(sourceFile, methodName, type) {
  for (const clause of switchCaseClauses(sourceFile, methodName, type)) {
    let object = null;
    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        object = node;
        return;
      }
      if (!object) ts.forEachChild(node, visit);
    }
    for (const statement of clause.statements) {
      if (!object) visit(statement);
    }
    if (object) return object;
  }
  assert.fail(`Config.${methodName}(${type}) must assign a UnitInfo object`);
}

function propertyInitializer(object, propertyName, context) {
  const property = object.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === propertyName) ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === propertyName)),
  );
  assert.ok(property, `${context} must define ${propertyName}`);
  return property.initializer;
}

function findVariableInitializer(sourceFile, variableName) {
  let initializer = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      initializer = node.initializer;
      return;
    }
    if (!initializer) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(initializer, `missing ${variableName} initializer`);
  return initializer;
}

function evaluateIdentifier(node, methodName, sourceFile, seen) {
  if (!sourceFile || seen.has(node.text)) {
    assert.fail(`Config.${methodName}() contains an unresolved identifier`);
  }
  seen.add(node.text);
  return evaluateNumericExpression(
    findVariableInitializer(sourceFile, node.text),
    methodName,
    sourceFile,
    seen,
  );
}

function evaluatePrefixUnary(node, methodName, sourceFile, seen) {
  const value = evaluateNumericExpression(node.operand, methodName, sourceFile, seen);
  if (node.operator === ts.SyntaxKind.PlusToken) return value;
  if (node.operator === ts.SyntaxKind.MinusToken) return -value;
  assert.fail(`Config.${methodName}() contains an unsupported unary operator`);
}

function evaluateBinaryExpression(node, methodName, sourceFile, seen) {
  const left = evaluateNumericExpression(node.left, methodName, sourceFile, seen);
  const right = evaluateNumericExpression(node.right, methodName, sourceFile, seen);
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return left / right;
    default:
      assert.fail(`Config.${methodName}() contains an unsupported binary operator`);
  }
}

function evaluateNumericExpression(node, methodName, sourceFile = null, seen = new Set()) {
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (ts.isBigIntLiteral(node)) return Number(node.text.slice(0, -1).replaceAll("_", ""));
  if (ts.isParenthesizedExpression(node)) {
    return evaluateNumericExpression(node.expression, methodName, sourceFile, seen);
  }
  if (ts.isIdentifier(node)) return evaluateIdentifier(node, methodName, sourceFile, seen);
  if (ts.isPrefixUnaryExpression(node)) {
    return evaluatePrefixUnary(node, methodName, sourceFile, seen);
  }
  if (ts.isBinaryExpression(node)) {
    return evaluateBinaryExpression(node, methodName, sourceFile, seen);
  }
  assert.fail(`Config.${methodName}() contains an unsupported numeric expression`);
}

function numericLiterals(node) {
  const values = [];
  function visit(current) {
    if (ts.isNumericLiteral(current)) values.push(Number(current.text.replaceAll("_", "")));
    if (ts.isBigIntLiteral(current)) {
      values.push(Number(current.text.slice(0, -1).replaceAll("_", "")));
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return values;
}

function normalizedNodeText(sourceFile, node) {
  return node.getText(sourceFile).replaceAll("_", "").replace(/\s+/gu, "");
}

function numericReturn(sourceFile, methodName) {
  const method = findMethod(sourceFile, methodName);
  const returnStatement = method.body?.statements.find((statement) =>
    ts.isReturnStatement(statement),
  );
  assert.ok(returnStatement?.expression, `Config.${methodName}() must return a numeric expression`);
  return evaluateNumericExpression(returnStatement.expression, methodName);
}

function mapIdsFromSource(source, marker, suffix) {
  const ids = new Set();
  for (const line of source.split("\n")) {
    const start = line.indexOf(marker);
    if (start === -1) continue;
    const valueStart = start + marker.length;
    const end = line.indexOf(suffix, valueStart);
    if (end !== -1) ids.add(line.slice(valueStart, end));
  }
  return ids;
}

function assertConfigContracts(configFile) {
  const numericContracts = {
    msPerTick: 100,
    SAMCooldown: 90,
    SiloCooldown: 90,
    donateCooldown: 100,
    emojiMessageCooldown: 50,
    targetCooldown: 150,
    defensePostRange: 30,
    defaultNukeTargetableRange: 150,
    defaultSamRange: 70,
    maxSamRange: 150,
    defaultSamMissileSpeed: 12,
    warshipTargettingRange: 130,
    warshipShellAttackRate: 20,
  };
  for (const [method, expected] of Object.entries(numericContracts)) {
    assert.equal(
      numericReturn(configFile, method),
      expected,
      `OpenFront Config.${method}() drifted; update runtime consumers and fallbacks together`,
    );
  }

  for (const [type, magnitude] of Object.entries({
    MIRVWarhead: { inner: 12, outer: 18 },
    AtomBomb: { inner: 12, outer: 30 },
    HydrogenBomb: { inner: 80, outer: 100 },
  })) {
    const result = findReturnExpression(configFile, "nukeMagnitudes", type);
    assert.ok(
      ts.isObjectLiteralExpression(result),
      `Config.nukeMagnitudes(${type}) must return an object`,
    );
    assert.equal(
      evaluateNumericExpression(
        propertyInitializer(result, "inner", `Config.nukeMagnitudes(${type})`),
        "nukeMagnitudes",
        configFile,
      ),
      magnitude.inner,
      `Config.nukeMagnitudes(${type}).inner drifted`,
    );
    assert.equal(
      evaluateNumericExpression(
        propertyInitializer(result, "outer", `Config.nukeMagnitudes(${type})`),
        "nukeMagnitudes",
        configFile,
      ),
      magnitude.outer,
      `Config.nukeMagnitudes(${type}).outer drifted`,
    );
  }

  for (const [type, expected] of Object.entries({
    AtomBomb: 10,
    HydrogenBomb: 10,
    MIRV: 15,
    MIRVWarhead: 22,
  })) {
    assert.equal(
      evaluateNumericExpression(
        findReturnExpression(configFile, "nukeSpeed", type),
        "nukeSpeed",
        configFile,
      ),
      expected,
      `Config.nukeSpeed(${type}) drifted`,
    );
  }

  const constructionContracts = {
    Port: 50,
    MissileSilo: 100,
    DefensePost: 50,
    SAMLauncher: 300,
    City: 20,
    Factory: 20,
  };
  for (const [type, expected] of Object.entries(constructionContracts)) {
    const initializer = propertyInitializer(
      findCaseObject(configFile, "unitInfo", type),
      "constructionDuration",
      `Config.${type}`,
    );
    const durationExpression = ts.isConditionalExpression(initializer)
      ? initializer.whenFalse
      : initializer;
    assert.equal(
      evaluateNumericExpression(durationExpression, "unitInfo", configFile),
      expected,
      `Config.${type} construction duration drifted`,
    );
  }

  const costContracts = {
    TransportShip: { numbers: [0] },
    Warship: { numbers: [1_000_000, 1, 250_000], text: "Math.min" },
    Shell: { numbers: [0] },
    SAMMissile: { numbers: [0] },
    Port: { numbers: [1_000_000, 125_000], text: "pow2" },
    AtomBomb: { numbers: [750_000], text: "costWrapper" },
    HydrogenBomb: { numbers: [5_000_000], text: "costWrapper" },
    MIRV: { numbers: [25_000_000, 15_000_000], text: "mirvsLaunched" },
    MIRVWarhead: { numbers: [0] },
    TradeShip: { numbers: [0] },
    MissileSilo: { numbers: [1_000_000], text: "costWrapper" },
    DefensePost: { numbers: [250_000, 1, 50_000], text: "Math.min" },
    SAMLauncher: { numbers: [3_000_000, 1, 1_500_000], text: "Math.min" },
    City: { numbers: [1_000_000, 125_000], text: "pow2" },
    Factory: { numbers: [1_000_000, 125_000], text: "pow2" },
    Train: { numbers: [0] },
  };
  for (const [type, contract] of Object.entries(costContracts)) {
    const initializer = propertyInitializer(
      findCaseObject(configFile, "unitInfo", type),
      "cost",
      `Config.${type}`,
    );
    const literals = numericLiterals(initializer);
    for (const expected of contract.numbers) {
      assert.ok(literals.includes(expected), `Config.${type} cost literal ${expected} drifted`);
    }
    if (contract.text) {
      assert.ok(
        normalizedNodeText(configFile, initializer).includes(contract.text),
        `Config.${type} cost formula drifted`,
      );
    }
  }
  return {
    numeric: Object.keys(numericContracts).length,
    magnitudes: 3,
    speeds: 4,
    construction: Object.keys(constructionContracts).length,
    costs: Object.keys(costContracts).length,
  };
}

function assertHelperFallbackContracts() {
  const suggestions = read("engine/ingame/nuke-suggestions.js");
  const prediction = read("engine/ingame/nuke-prediction.js");
  const landingZones = read("engine/ingame/nuke-landing-zones.js");
  const lifecycle = read("engine/ingame/auto-bot/lifecycle.js");
  const warship = read("engine/ingame/auto-bot/warshipBehavior.js");
  const tracker = read("engine/ingame/silo-sam-tracker.js");
  const buildTimer = read("engine/ingame/build-timer.js");
  const advisor = read("engine/ingame/advisor-intel.js");
  const autoDonate = read("engine/ingame/auto-donate.js");
  const signalScheduler = read("engine/ingame/signal-scheduler.js");

  assert.match(suggestions, /"Atom Bomb": 750000/u);
  assert.match(suggestions, /"Hydrogen Bomb": 5000000/u);
  for (const source of [suggestions, prediction, landingZones, warship, tracker]) {
    assert.match(source, /inner:\s*80,\s*outer:\s*100/u);
    assert.match(source, /inner:\s*12,\s*outer:\s*30/u);
  }
  assert.match(suggestions, /inner:\s*12,\s*outer:\s*18/u);
  assert.match(buildTimer, /"Missile Silo": 100/u);
  assert.match(buildTimer, /"SAM Launcher": 300/u);
  assert.match(advisor, /const ADV_ATOM_COST = 750000/u);
  assert.match(advisor, /const ADV_HYDROGEN_COST = 5000000/u);
  assert.match(autoDonate, /var DONATE_COOLDOWN_MS = 10000/u);
  assert.match(signalScheduler, /emojiMessageCooldown/u);
  assert.match(signalScheduler, /targetCooldown/u);
  assert.doesNotMatch(signalScheduler, /SIGNAL_COOLDOWN_TICKS/u);

  for (const [source, label] of [
    [prediction, "nuke prediction"],
    [suggestions, "nuke suggestions"],
    [landingZones, "legacy nuke zones"],
    [warship, "warship dodge"],
    [tracker, "silo/SAM tracker"],
    [lifecycle, "atom macro"],
  ]) {
    assert.doesNotMatch(
      source,
      /Hydrogen Bomb"?\s*\?\s*160/u,
      `${label} keeps the obsolete 160-tile fallback`,
    );
    assert.doesNotMatch(
      source,
      /defaultNukeSpeed[^\n]*\?\?\s*8/u,
      `${label} keeps the obsolete nuke speed fallback`,
    );
    assert.doesNotMatch(
      source,
      /maxSamRange[^\n]*:\s*200/u,
      `${label} keeps the obsolete SAM range fallback`,
    );
  }
}

export function assertRuntimeParity() {
  const upstreamUnitTypes = findEnum(
    parseTypeScript("openfront-engine/src/core/game/Game.ts"),
    "UnitType",
  );
  const helperUnits = findObject(parseTypeScript("engine/ingame/auto-bot/core.js"), "UNIT");
  for (const [name, value] of helperUnits) {
    assert.equal(
      upstreamUnitTypes.get(name),
      value,
      `UNIT.${name} no longer matches OpenFront UnitType.${name}`,
    );
  }
  const intentionallyUnmodeledUnitTypes = ["Shell", "Train"];
  const missingUnitTypes = [...upstreamUnitTypes.keys()]
    .filter((name) => !helperUnits.has(name))
    .sort();
  assert.deepEqual(
    missingUnitTypes,
    intentionallyUnmodeledUnitTypes,
    "the helper UnitType coverage changed; review projectile/train handling explicitly",
  );

  const upstreamMapIds = mapIdsFromSource(
    read("openfront-engine/src/core/game/Maps.gen.ts"),
    "// map-generator/assets/maps/",
    "/info.json",
  );
  const helperMapIds = mapIdsFromSource(read("engine/map-data.js"), 'id: "', '"');
  assert.deepEqual(
    [...helperMapIds].sort(),
    [...upstreamMapIds].sort(),
    "map-data.js must cover exactly the pinned OpenFront map manifest",
  );

  const configPath = "openfront-engine/src/core/configuration/Config.ts";
  const configSummary = assertConfigContracts(parseTypeScript(configPath));
  assertHelperFallbackContracts();

  process.stdout.write(
    `game runtime parity passed (${helperUnits.size} unit types, ${helperMapIds.size} maps, ` +
      `${
        configSummary.numeric +
        configSummary.magnitudes +
        configSummary.speeds +
        configSummary.construction +
        configSummary.costs
      } config rules)\n`,
  );
  return { unitTypes: helperUnits.size, maps: helperMapIds.size, config: configSummary };
}

assertRuntimeParity();
