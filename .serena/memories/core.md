# Project map
- Source is split under `engine/shared`, `engine/lobby`, and `engine/ingame`; `build.mjs` concatenates ordered modules into the distributable `openfront-helper.user.js`.
- Spawn planning/scoring lives in `engine/ingame/spawn-objective.js`; spatial indexing is in `spawn-index.js`, and visualization in `spawn-heatmap.js`.
- Auto-bot behavior is under `engine/ingame/auto-bot/`.
- Tests are standalone Node `.mjs` files under `test/`; package scripts are the authoritative test/build entry points.
- Build output is versioned and is expected to include the custom userscript marker/version name.