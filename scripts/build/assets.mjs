// Locale inlining, userscript metadata header, and atomic artifact publication.

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./sources.mjs";

export function discoverLocales() {
  const localesDir = path.resolve(PROJECT_ROOT, "locales");
  const locales = {};
  for (const code of fs.readdirSync(localesDir)) {
    const p = path.join(localesDir, code, "common.json");
    if (fs.statSync(path.join(localesDir, code)).isDirectory() && fs.existsSync(p)) {
      locales[code] = JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  if (!locales.en) throw new Error("locales/en/common.json is required (English fallback)");
  return locales;
}

export function toAssetsLiteral(version, locales) {
  return `window.__OFH_ASSETS = ${JSON.stringify({ version, locales })};\n`;
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

export function metadataHeader(version) {
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
