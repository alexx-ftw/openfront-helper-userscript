// Raw/debug switch and engine-layer minification.

import { transform } from "esbuild";

// Raw/debug build: skip all minification so the engine keeps its original
// formatting, identifiers, and console.log debug output for in-browser
// debugging. Trigger with `npm run build:raw` (--raw) or OFH_DEBUG=1.
export const RAW = process.argv.includes("--raw") || Boolean(process.env.OFH_DEBUG);

// Minify an engine layer: strip whitespace/comments and mangle nested-local
// identifiers. Syntax folding is intentionally OFF — these are sloppy-mode
// classic scripts concatenated into a single scope, and minifySyntax is the
// transform most likely to perturb their semantics for only a ~2% size gain
// (measured). Top-level names are script-scope and preserved/consistently
// renamed within the layer, so cross-file bare-name references survive; the
// engine has no string-based name access (eval / window["…"] / .name), so
// mangling is safe. charset:"utf8" keeps emoji keys (⚔️ ☢️ ⛵) from bloating to
// \uXXXX. `npm run build:raw` (RAW) skips this for a debuggable build.
export async function minifyLayer(code) {
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
