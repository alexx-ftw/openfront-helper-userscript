// Build the standalone userscript.
//
//   metadata header
//   window.__OFH_ASSETS = { version, enLocale }
//   [shell IIFE]   esbuild(src/shell/index.ts) -> chrome shim, audio, launcher
//   [lobby IIFE]   concat(engine: map-data + shared + lobby)  (sloppy mode)
//   [ingame IIFE]  concat(engine/ingame/**)                   (sloppy mode)
//
// The two engine IIFEs are NOT "use strict" (the originals were classic scripts).
// The lobby layer is emitted before the in-game layer so auto-join survives an
// in-game fault.

import { build as esbuild, transform } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
const logBuild = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);

// Raw/debug build: skip all minification so the engine keeps its original
// formatting, identifiers, and console.log debug output for in-browser
// debugging. Trigger with `npm run build:raw` (--raw) or OFH_DEBUG=1.
const RAW = process.argv.includes("--raw") || Boolean(process.env.OFH_DEBUG);

// Lobby layer (formerly "content"): map data, shared settings/i18n, auto-join,
// and the floating auto-join panel.
const LOBBY_FILES = [
  "engine/map-data.js",
  "engine/shared/settings.js",
  "engine/shared/i18n.js",
  "__I18N_OVERRIDE__",
  "engine/lobby/core.js",
  "engine/lobby/floating-autojoin.js",
  "engine/lobby/auto-join.js",
];

// In-game layer (formerly "page-bridge"): overlays, helper panels, and the
// auto-bot. Order matters (see the auto-bot README).
const INGAME_FILES = [
  "anti-afk.js",
  "runtime.js",
  "intent-rate-limit.js",
  "round-logger.js",
  "ws-hook.js",
  "panel-layout.js",
  "shared-utils.js",
  "selective-trade-policy.js",
  "game-start-notification.js",
  "spawn-voice.js",
  "alliances.js",
  "alliance-requests-panel.js",
  "bot-markers.js",
  "gold-per-minute.js",
  "team-build-stats.js",
  "trade-balances.js",
  "nuke-prediction.js",
  "nuke-impact.js",
  "nuke-suggestions.js",
  "boat-prediction.js",
  "warship-routes.js",
  "boat-panel.js",
  "estate-panel.js",
  "auto-leave.js",
  "boat-macro.js",
  "heatmaps.js",
  "spawn-index.js",
  "spawn-objective.js",
  "auto-bot/core.js",
  "auto-bot/i18n.js",
  "auto-bot/helpers.js",
  "auto-bot/context.js",
  "auto-bot/sensing.js",
  "auto-bot/portutil.js",
  "auto-bot/gameApi.js",
  "auto-bot/earlyGame.js",
  "auto-bot/legendaryPlanner.js",
  "auto-bot/emojiBehavior.js",
  "auto-bot/allianceBehavior.js",
  "auto-bot/mirvBehavior.js",
  "auto-bot/naval-interception.js",
  "auto-bot/warshipBehavior.js",
  "auto-bot/structureBehavior.js",
  "auto-bot/attackBehavior.js",
  "auto-bot/nukeBehavior.js",
  "auto-bot/performance.js",
  "auto-bot/nationExecution.js",
  "auto-bot/engine.js",
  "auto-bot/panel.js",
  "auto-bot/lifecycle.js",
  "signal-scheduler.js",
  "helper-users-panel.js",
  "sos-defense.js",
  "map-overlay-scheduler.js",
  "tribe-cluster-overlay.js",
  "advisor-intel.js",
  "name-overlay.js",
  "attack-highlight.js",
  "nuke-trajectory.js",
  "advisor-panel.js",
  "retaliation-hud.js",
  "hide-ads.js",
  "attack-ratio-hotkey.js",
  "alliance-policy.js",
  "right-click-conquest.js",
  "network-logger.js",
  "runtime-diagnostics.js",
  "build-timer.js",
  "enemy-intent-intel.js",
  "spawn-heatmap.js",
  "game-time-alert.js",
  "silo-sam-tracker.js",
  "auto-donate.js",
  "companion/core.js",
  "companion/commands.js",
  "companion/actions.js",
  "companion/engine.js",
  "companion/panel.js",
  "quick-panel.js",
  "bootstrap.js",
].map((f) => `engine/ingame/${f}`);

const AUTO_BOT_FILES = INGAME_FILES.filter((file) => file.includes("/auto-bot/"));
const HOT_RELOAD_BRIDGE = `
window.__OFH_HOT_RELOAD_AUTOBOT__ = function(source, buildId) {
  const previous = window.__OFH_autobot;
  if (typeof previous?.disposeForHotReload !== "function") return false;
  const candidateSource = String(source);
  const previousBuildId = window.__OFH_LOCAL_BUILD_ID__;
  const previousAtomDisposer = window.__OFH_disposeAtomMacroForHotReload;
  const previousActivationPending = window.__openfrontAutoBotActivationPending;
  let candidate = null;
  let previousDisposed = false;
  let committed = false;
  const finishStaging = () => {
    window.__OFH_HOT_RELOAD_IN_PROGRESS__ = false;
    delete window.__OFH_HOT_RELOAD_CANDIDATE_ATOM_MACRO__;
  };
  const settle = (operation) =>
    Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
  window.__OFH_HOT_RELOAD_IN_PROGRESS__ = true;
  return Promise.resolve()
    .then(async () => {
      // Compile before staging so a syntax error cannot touch the live runtime.
      Function(candidateSource);
      eval(candidateSource);
      candidate = window.__OFH_autobot;
      if (
        typeof candidate?.disposeForHotReload !== "function" ||
        typeof candidate?.activateForHotReload !== "function"
      ) {
        throw new Error("el candidato de Auto-Bot no expuso el contrato de hot reload");
      }
      const disposed = await previous.disposeForHotReload();
      if (disposed === false) {
        throw new Error("el runtime anterior no pudo cerrarse limpiamente");
      }
      previousDisposed = true;
      window.__OFH_HOT_RELOAD_IN_PROGRESS__ = false;
      if (!(await candidate.activateForHotReload())) {
        throw new Error("el candidato de Auto-Bot no pudo activarse");
      }
      window.__OFH_LOCAL_BUILD_ID__ = String(buildId);
      committed = true;
      return true;
    })
    .then(
      (result) => {
        finishStaging();
        return result;
      },
      async (error) => {
        const rollbackFailures = [];
        let candidateQuiescent = true;
        if (!committed && candidate && candidate !== previous) {
          const candidateOwnsAtom =
            window.__OFH_disposeAtomMacroForHotReload !== previousAtomDisposer;
          const cleanup = await settle(() =>
            candidate.disposeForHotReload?.({ skipAtomMacroCleanup: !candidateOwnsAtom }),
          );
          if (!cleanup.ok) {
            candidateQuiescent = false;
            rollbackFailures.push(cleanup.error);
          } else if (cleanup.value === false) {
            candidateQuiescent = false;
            rollbackFailures.push(
              new Error("el candidato de Auto-Bot no pudo cerrarse limpiamente"),
            );
          }
        }
        if (!committed) {
          window["__OFH_autobot"] = previous;
          window.__OFH_LOCAL_BUILD_ID__ = previousBuildId;
          window.__OFH_disposeAtomMacroForHotReload = previousAtomDisposer;
          window.__openfrontAutoBotActivationPending = previousActivationPending;
          finishStaging();
          if (previousDisposed && candidateQuiescent) {
            const rollback = await settle(() => previous.activateForHotReload());
            if (!rollback.ok) {
              rollbackFailures.push(rollback.error);
            } else if (rollback.value === false) {
              rollbackFailures.push(
                new Error("el runtime anterior no pudo reactivarse"),
              );
            }
          }
        }
        finishStaging();
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            "falló la activación del candidato de Auto-Bot y su rollback",
            { cause: error },
          );
        }
        throw error;
      },
    );
};
`;

const I18N_OVERRIDE =
  "\n;(window.__OFH && window.__OFH.installI18nOverride && window.__OFH.installI18nOverride());\n";

function readLobbyFile(rel) {
  if (rel === "__I18N_OVERRIDE__") return I18N_OVERRIDE;
  return `\n// ===== ${rel} =====\n${read(rel)}\n`;
}

function wrapIife(body) {
  return `\n;(function(){\n${body}\n})();\n`;
}

// Minify an engine layer: strip whitespace/comments and mangle nested-local
// identifiers. Syntax folding is intentionally OFF — these are sloppy-mode
// classic scripts concatenated into a single scope, and minifySyntax is the
// transform most likely to perturb their semantics for only a ~2% size gain
// (measured). Top-level names are script-scope and preserved/consistently
// renamed within the layer, so cross-file bare-name references survive; the
// engine has no string-based name access (eval / window["…"] / .name), so
// mangling is safe. charset:"utf8" keeps emoji keys (⚔️ ☢️ ⛵) from bloating to
// \uXXXX. `npm run build:raw` (RAW) skips this for a debuggable build.
async function minifyLayer(code) {
  if (RAW) return code;
  const r = await transform(code, {
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: false,
    legalComments: "none",
    charset: "utf8",
  });
  return r.code;
}

export async function publishBuildArtifacts(outputDir, { full, autoBot, buildId }) {
  const stagingDir = fs.mkdtempSync(path.join(outputDir, ".ofh-build-"));
  const files = [
    ["openfront-helper.user.js", full],
    ["openfront-helper.autobot.js", autoBot],
    ["openfront-helper.build-id.js", buildId],
  ];
  const originals = new Set();
  const publish = Promise.resolve().then(() => {
    for (const [name, contents] of files) {
      const stagingPath = path.join(stagingDir, name);
      fs.writeFileSync(stagingPath, contents, "utf8");
      const fd = fs.openSync(stagingPath, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const destination = path.join(outputDir, name);
      if (fs.existsSync(destination)) {
        fs.copyFileSync(destination, path.join(stagingDir, `${name}.previous`));
        originals.add(name);
      }
    }
    // Each replacement is atomic, and the fingerprint is last: the loader can
    // never observe a new build id before both source artifacts are complete.
    for (const [name] of files) {
      fs.renameSync(path.join(stagingDir, name), path.join(outputDir, name));
    }
  });
  return publish
    .then(undefined, (error) => {
      // A failed replacement must not leave a new source paired with an old
      // fingerprint. Restore the exact prior set where one existed.
      for (const [name] of [...files].reverse()) {
        const destination = path.join(outputDir, name);
        const previous = path.join(stagingDir, `${name}.previous`);
        if (originals.has(name)) {
          if (fs.existsSync(destination)) fs.unlinkSync(destination);
          fs.renameSync(previous, destination);
        } else if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }
      }
      throw error;
    })
    .finally(() => {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    });
}

function metadataHeader(version) {
  const repo = "https://github.com/nguyenvancaokyfpt/openfront-helper-userscript";
  return `// ==UserScript==
// @name         OpenFront Helper (userscript) (CUSTOM)
// @namespace    openfront-helper
// @version      ${version}
// @description  Auto-join lobbies + in-game helper overlays and an auto-bot for OpenFront.io. Standalone userscript build with a multi-language UI.
// @author       nguyenvancaokyfpt (https://github.com/nguyenvancaokyfpt)
// @license      AGPL-3.0-or-later
// @homepageURL  ${repo}
// @supportURL   ${repo}/issues
// @contributionURL https://greasyfork.org/en/scripts/581664-openfront-tactical-assistant
// Credits: in-game overlays adapted from phil0010-gh/openfront-helper; several
// helper/auto-bot features (spawn scoring/heatmap, advisor, threat intel, map
// overlays) reference OpenFront Tactical Assistant:
//   https://greasyfork.org/en/scripts/581664-openfront-tactical-assistant
// @match        https://openfront.io/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==
`;
}

async function main() {
  const pkg = JSON.parse(read("package.json"));
  const version = pkg.version || "0.0.0";

  logBuild("[build] discovering locales…");
  // Auto-discover every locales/<code>/common.json and inline them all. Adding a
  // new language is just dropping in a folder — no code change. English is the
  // fallback (loadBundle layers DEFAULT_TRANSLATIONS + en + <lang>).
  const localesDir = path.resolve(__dirname, "locales");
  const locales = {};
  for (const code of fs.readdirSync(localesDir)) {
    const p = path.join(localesDir, code, "common.json");
    if (fs.statSync(path.join(localesDir, code)).isDirectory() && fs.existsSync(p)) {
      locales[code] = JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  if (!locales.en) throw new Error("locales/en/common.json is required (English fallback)");
  logBuild(`[build] locales: ${Object.keys(locales).join(", ")}`);
  const assetsLiteral = `window.__OFH_ASSETS = ${JSON.stringify({ version, locales })};\n`;

  logBuild("[build] bundling shell (esbuild)…");
  const shellResult = await esbuild({
    entryPoints: [path.resolve(__dirname, "src/shell/index.ts")],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: !RAW,
    charset: "utf8",
    write: false,
    legalComments: "none",
  });
  const shell = shellResult.outputFiles[0].text;

  logBuild("[build] concatenating lobby layer…");
  const lobbyPrelude =
    "const chrome = (window.__OFH && window.__OFH.chrome) || window.chrome;\n" +
    "const Audio = (window.__OFH && window.__OFH.Audio) || window.Audio;\n" +
    // floating-helpers.js was removed; stub the two functions core/auto-join call.
    "function syncFloatingHelpersPanel(){}\n" +
    "function positionFloatingHelpersPanel(){}\n";
  const lobby = lobbyPrelude + LOBBY_FILES.map(readLobbyFile).join("");

  logBuild("[build] concatenating in-game layer…");
  const autoBot = AUTO_BOT_FILES.map((rel) => `\n// ===== ${rel} =====\n${read(rel)}\n`).join("");
  const ingame =
    INGAME_FILES.map((rel) => `\n// ===== ${rel} =====\n${read(rel)}\n`).join("") +
    HOT_RELOAD_BRIDGE;

  logBuild(RAW ? "[build] minify OFF (raw/debug build)…" : "[build] minifying…");
  const autoBotOut = await minifyLayer(autoBot);
  const out =
    metadataHeader(version) +
    assetsLiteral +
    shell +
    wrapIife(await minifyLayer(lobby)) +
    wrapIife(await minifyLayer(ingame));

  const outPath = path.resolve(__dirname, "openfront-helper.user.js");
  const autoBotPath = path.resolve(__dirname, "openfront-helper.autobot.js");
  // The loader can safely replace only the Auto-Bot lifecycle without reloading
  // the game. Fingerprint that exact layer so an unrelated shell/overlay edit is
  // never reported as hot-applied while its old code remains live.
  const buildId = createHash("sha256").update(autoBotOut).digest("hex");
  const buildIdSource = `// Generated by npm run build.\nglobalThis.__OFH_LOCAL_BUILD_ID__ = "${buildId}";\n`;
  await publishBuildArtifacts(__dirname, {
    full: out,
    autoBot: autoBotOut,
    buildId: buildIdSource,
  });
  const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(0);
  logBuild(`[build] wrote ${outPath} (${kb} KB)`);
  logBuild(`[build] wrote ${autoBotPath} for hot reload`);

  {
    const { execSync } = await import("node:child_process");
    if (process.platform === "win32") {
      execSync(
        "powershell -Command \"Set-Clipboard -Value ([System.IO.File]::ReadAllText('" +
          outPath.replace(/\\/g, "\\\\") +
          "'))\"",
      );
      logBuild("[build] copied to clipboard");
    } else if (process.platform === "darwin") {
      execSync('pbcopy < "' + outPath + '"');
      logBuild("[build] copied to clipboard");
    }
  }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) main();
