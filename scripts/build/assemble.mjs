// Layer assembly: shell esbuild bundle, lobby/in-game concatenation, and the
// Auto-Bot hot-reload bridge.

import path from "node:path";
import { build as esbuild } from "esbuild";
import { RAW } from "./minify.mjs";
import {
  AUTO_BOT_FILES,
  INGAME_FILES,
  LOBBY_FILES,
  PROJECT_ROOT,
  readEngineFilesGrouped,
  readLobbyFile,
} from "./sources.mjs";

export const HOT_RELOAD_BRIDGE = `
window.__OFH_HOT_RELOAD_AUTOBOT__ = function(source, buildId) {
  const previous = window.__OFH_autobot;
  if (typeof previous?.disposeForHotReload !== "function") return false;
  const previousSettings = typeof previous.get === "function" ? previous.get() : null;
  const activationOptions =
    typeof previousSettings?.enabled === "boolean"
      ? { enabled: previousSettings.enabled }
      : {};
  const candidateSource = String(source);
  const previousBuildId = window.__OFH_LOCAL_BUILD_ID__;
  const previousAtomDisposer = window.__OFH_disposeAtomMacroForHotReload;
  const previousActivationPending = window.__openfrontAutoBotActivationPending;
  let candidate = null;
  let previousDisposalStarted = false;
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
      // Disposal can reject after stopping the engine and removing its panel.
      previousDisposalStarted = true;
      const disposed = await previous.disposeForHotReload();
      if (disposed === false) {
        throw new Error("el runtime anterior no pudo cerrarse limpiamente");
      }
      window.__OFH_HOT_RELOAD_IN_PROGRESS__ = false;
      if (!(await candidate.activateForHotReload(activationOptions))) {
        throw new Error("el candidato de Auto-Bot no pudo activarse");
      }
      // Reassert the transferred master toggle through the replacement's public
      // API before committing. This starts its engine and refreshes its panel even
      // when lifecycle activation inherited the value but left either one idle.
      if (typeof activationOptions.enabled === "boolean" && typeof candidate.set === "function") {
        candidate.set({ enabled: activationOptions.enabled });
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
          if (previousDisposalStarted && candidateQuiescent) {
            const rollback = await settle(() =>
              previous.activateForHotReload(activationOptions),
            );
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

const LOBBY_PRELUDE =
  "const chrome = (window.__OFH && window.__OFH.chrome) || window.chrome;\n" +
  "const Audio = (window.__OFH && window.__OFH.Audio) || window.Audio;\n" +
  // floating-helpers.js was removed; stub the two functions core/auto-join call.
  "function syncFloatingHelpersPanel(){}\n" +
  "function positionFloatingHelpersPanel(){}\n";

export async function bundleShell() {
  const shellResult = await esbuild({
    entryPoints: [path.resolve(PROJECT_ROOT, "src/shell/index.ts")],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: !RAW,
    charset: "utf8",
    write: false,
    legalComments: "none",
  });
  return shellResult.outputFiles[0].text;
}

export function concatLobby() {
  return LOBBY_PRELUDE + LOBBY_FILES.map(readLobbyFile).join("");
}

export function concatAutoBot() {
  return readEngineFilesGrouped(AUTO_BOT_FILES);
}

export function concatIngame() {
  return readEngineFilesGrouped(INGAME_FILES) + HOT_RELOAD_BRIDGE;
}
