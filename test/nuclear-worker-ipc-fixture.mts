import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { GameRunner } from "../openfront-engine/src/core/GameRunner";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager";
import { PlayerInfo, PlayerType, UnitType } from "../openfront-engine/src/core/game/Game";
import { TurnSchema, type Intent } from "../openfront-engine/src/core/Schemas";
import { WorkerClient } from "../openfront-engine/src/core/worker/WorkerClient";
import { setup } from "../openfront-engine/tests/util/Setup";
import { restoreScriptedRunner } from "../openfront-engine/tests/util/ScriptedGame";
import { engineTestsUtil } from "./helpers/two-player-game.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const game = await setup(
  "big_plains",
  { instantBuild: true, spawnImmunityDuration: 0 },
  [
    new PlayerInfo("attacker", PlayerType.Human, "attacker", "attacker"),
    new PlayerInfo("defender", PlayerType.Human, "defender", "defender"),
  ],
  engineTestsUtil,
);
const attacker = game.player("attacker");
const source = game.ref(1, 1);
attacker.conquer(source);
attacker.addGold(100_000_000n);
game.player("defender").conquer(game.ref(80, 1));
const silo = attacker.buildUnit(UnitType.MissileSilo, source, {});
const gameStart = { gameID: "raceGame", listed: false } as any;
const runner = new GameRunner(game, new Executor(game, gameStart.gameID, "attacker"), () => {});
const snapshot = runner.snapshot();
const bundle = await build({
  stdin: {
    resolveDir: root,
    sourcefile: "nuclear-worker-test-entry.js",
    contents: String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    const { readFileSync } = require("node:fs");
    const path = require("node:path");
    globalThis.self = {
      postMessage: (message, transfers) => parentPort.postMessage(message, transfers),
      addEventListener: (type, listener) => {
        if (type === "message") parentPort.on("message", data => listener({ data }));
      },
    };
    globalThis.fetch = async url => {
      const match = String(url).match(/maps\/asia\/(map\.bin|map4x\.bin|manifest\.json)$/);
      if (!match) throw new Error("Unexpected fixture asset: " + url);
      return new Response(readFileSync(path.join(workerData.mapDirectory, match[1])));
    };
    import("./openfront-engine/src/core/worker/Worker.worker.ts")
      .then(() => parentPort.postMessage({ type: "fixture_ready" }));
  `,
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  define: { __ASSET_MANIFEST__: "{}" },
});
const worker = new Worker(bundle.outputFiles[0].text, {
  eval: true,
  workerData: { mapDirectory: `${root}openfront-engine/tests/testdata/maps/big_plains` },
});
worker.on("error", (error) => {
  throw error;
});
let deadline;
const timedOut = new Promise<never>((_, reject) => {
  deadline = setTimeout(
    () => reject(new Error("Nuclear worker IPC fixture exceeded 30 seconds")),
    30_000,
  );
});
try {
  await Promise.race([
    (async () => {
      const [ready] = await once(worker, "message");
      assert.equal(ready.type, "fixture_ready");
      const initialized = once(worker, "message");
      worker.postMessage({
        type: "init",
        id: "initRace",
        gameStartInfo: gameStart,
        clientID: "attacker",
        cdnBase: "https://fixture.invalid",
        snapshot,
      });
      assert.equal((await initialized)[0].type, "initialized");
      // Node supplies the transport; all query, correlation and turn handlers are native.
      const client = new WorkerClient(gameStart, "attacker", snapshot) as any;
      client.worker = { postMessage: (message) => worker.postMessage(message) };
      client.isInitialized = true;
      worker.on("message", (data) => client.handleWorkerMessage({ data }));
      const [upgradeResult, atomResult] = await Promise.all([
        client.playerBuildables("attacker", 1, 1, [UnitType.MissileSilo]),
        client.playerBuildables("attacker", 80, 1, [UnitType.AtomBomb]),
      ]);
      const upgrade = upgradeResult.find((bu) => bu.type === UnitType.MissileSilo);
      assert.equal(upgrade.canUpgrade, silo.id());
      assert.equal(typeof upgrade.cost, "bigint", "IPC preserves native gold values");
      assert.equal(atomResult.find((bu) => bu.type === UnitType.AtomBomb).canBuild, source);
      let tick = game.ticks();
      const sendTurn = async (intents: Intent[] = []) => {
        const update = new Promise<void>((resolve) =>
          client.start((gu) => {
            assert.ok(!("errMsg" in gu));
            assert.equal(gu.tick, tick + 1);
            resolve();
          }),
        );
        client.sendTurn(TurnSchema.parse({ turnNumber: tick, intents }));
        await update;
        tick++;
      };
      await sendTurn([
        {
          type: "upgrade_structure",
          unit: UnitType.MissileSilo,
          unitId: silo.id(),
          clientID: "attacker",
        },
      ]);
      await sendTurn([
        {
          type: "build_unit",
          unit: UnitType.AtomBomb,
          tile: game.ref(80, 1),
          rocketDirectionUp: true,
          clientID: "attacker",
        },
      ]);
      await sendTurn();
      await sendTurn();
      await sendTurn();
      const restored = await client.snapshot();
      assert.ok(restored instanceof Uint8Array);
      assert.equal(client.messageHandlers.size, 0, "all correlated IPC requests resolve");
      const replay = (await restoreScriptedRunner("big_plains", gameStart, restored)).game;
      assert.equal(replay.unit(silo.id()).level(), 2);
      assert.equal(replay.player("attacker").units(UnitType.AtomBomb).length, 1);
      assert.equal(replay.ticks(), tick);
      assert.ok(replay.player("attacker").gold() < attacker.gold());
    })(),
    timedOut,
  ]);
} finally {
  clearTimeout(deadline);
  await worker.terminate();
}
console.log("native nuclear worker IPC fixture passed");
