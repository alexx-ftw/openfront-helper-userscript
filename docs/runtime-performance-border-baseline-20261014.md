# Border-pressure overlay attribution — 2026-10-14

Status: **partial acceptance; overall not complete; pending human scope decision**. Paired diagnostic complete; both border predicates are false.

## Terminal paired evidence

The sanctioned native `apply_patch` route created `/tmp/ofh-border-baseline-20261014.mjs`.
Before the only execution, its manifest was bounded to source/harness/native/Europe-map inputs,
lockfiles and selected installed tool files. The executed script is 169 lines, SHA256
`f83bd1f7ba8ef86caf1ae65189a1e2e70f806c264a6b475496813bb5c38f74bf`.
No edits occurred during execution, no whole node_modules scan occurred, and no duplicate run occurred.
Native `node --check` exited 0. `node /tmp/ofh-border-baseline-20261014.mjs`, supervised session
98411, exited 0 after two sequential native scenarios and six parser self-checks.

| Evidence                   | HEAD-overlay baseline                                            | Current-overlay candidate                                        |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Build exit                 | 0                                                                | 0                                                                |
| Runner exit / signal       | 2 / null                                                         | 2 / null                                                         |
| Result phase               | present                                                          | present                                                          |
| Stop reason / tick         | bot_dead / 2379                                                  | bot_dead / 2379                                                  |
| won / intentBudgetViolated | false / false                                                    | false / false                                                    |
| constructionEvents         | []                                                               | []                                                               |
| Exact border predicate     | false                                                            | false                                                            |
| Full-bundle SHA256         | eb3f9f4d2b759b17e1292a450fbcde472df5c004b822e3868ed011ea7722caf3 | 00b094c1408913bc4faa13f4c4cb4c29b8097e205294029fca7b1ec6bbdfdb91 |

The two starts match exactly: seed legendary-audit-159-europe; Europe Normal; Free For All;
50 nations; 180 tribes; Impossible native difficulty; Legendary helper difficulty;
autoBuild true; startingGold 0; no modifiers; spawn immunity 50. The inherited environment
was captured once; only OFH_BUNDLE_PATH differed between runner arms. NODE_OPTIONS is
--max-old-space-size=768, an old-space cap rather than a total RSS cap.

The current inputs were copied once, then cloned into the control. Only estate-panel.js and
heatmaps.js were replaced with exact git-show Buffers from pinned HEAD
7703aa95f3c58a0903cf7ef6aa9c471f4b5defbf. The native engine HEAD was
f372cdf9451cd8c3dc113aaaf8641e2609e2d3cb. Both commits were rechecked after execution.
The full input manifests differ at exactly those two paths; both Auto-Bot and build-id artifacts
are identical. The current rebuilt full bundle matches the pre-existing integrated artifact.
The 919 guarded entries have identical pre/post digest
8a351722a506671ca528d9e1d4fe7caa0404dcbe5dc1a68900c656452561a973.

The exact receipt is [runtime-performance-border-baseline-20261014.json](runtime-performance-border-baseline-20261014.json).
Raw stdout/stderr, full start/result/exit records and per-file manifests remain in
/tmp/ofh-border-baseline-20261014-C8mM9b. Both generated build directories were removed;
only owned evidence remains. No repository code, package, versions, generated artifacts or Git state were written.

## Bounded interpretation and eLicit

FailureModeAnalysis: exit 2 is accepted only with a complete parsed non-winning result,
an allowed stop reason and no intent violation. Original execFile error codes are retained;
signals, malformed JSON, missing/duplicated result and nonnumeric overflow/error codes fail.
Six parser checks cover false/true predicates, signal, exit contradiction, malformed JSON and missing result.
The experiment's equality assertion passed; the original positive border assertion remains false in both arms.
This pair reproduces that failure without the two overlay patches. It does not identify the bot-policy
cause, qualify the whole suite, measure performance, or prove behavior across other scenarios.

RegressionAnalysis: procedural fixture copies preserve all foreign WIP. The guard covers build inputs,
headless harness code, native src/fullgame loader, Europe map files, root/native locks, selected tsx/esbuild/jsdom
tool manifests and launcher/binary files, and Node itself. Installed transitive dependency code is shared
and not exhaustively hashed; pre/post observations cannot exclude transient swap-and-restore or mutation.
No race-free claim is made. Native model inputs would be read-only and hashed if declared; none was inherited.

Fresh API research was supplied by parent research thread 01a13857-ac0c-7d23-9286-1e7486f184c2,
captured 02:57:21–02:58:05, consulting official Node 26.11.1 fs/child_process/performance documentation
through web and Exa. Context7 was unavailable. The existing parity code/test supplied the local procedure.
Challenger `01a13862-fef0-7dc0-a2f1-7b063d4e2fc3` CONFIRMED this bounded false/false claim.
Sniper `01a13863-0048-7360-bae7-51ad6f55811e` reported a diagnostic catch lint error and owned formatting failures.
The reviewed script now adds only the narrowly scoped catch lint exception, retaining error validation.
Original executed bytes are preserved at `/tmp/ofh-border-baseline-20261014-C8mM9b/executed-diagnostic.mjs`
with SHA256 `f83bd1f7ba8ef86caf1ae65189a1e2e70f806c264a6b475496813bb5c38f74bf`.
The current 170-line review script SHA256 is `316e6c352551721ade039660c1f7b4c31c61d8d87df88f49e9976b3a7b4256f2`.
Removing its single added lint comment reproduces every original byte. This current version did not run games.
Node syntax and scoped ESLint checks exit 0 with zero errors/warnings; the original six parser checks are inherited.
Source typecheck was not rerun because no source was changed. Final sniper
`01a1386c-3467-7b91-9ef9-084f3bcf0085`: **PASS bounded, zero owned errors**.
Trusted lead-provided receipt: syntax exit 0; raw scoped lint exit 0 with zero errors/warnings;
five-file formatting exit 0; JSON parse, semantic receipt and exact one-comment byte comparison exit 0.
This supersedes the diagnostic lint/format failure; it does not establish underlying cause or full green.
Original raw results remain unchanged; no games were rerun. Existing bot-gate repair scope awaits
the human decision; the human never answered that scope question.

The historical sections below describe earlier blocked attempts and are superseded by this terminal evidence.

## Verified existing evidence

`test/headless-simulation.mjs:262` launches the existing native runner:

```text
node node_modules/tsx/dist/cli.mjs --tsconfig openfront-engine/tsconfig.json scripts/headless/run-match.mts
```

The test inherits `process.env`, sets `GAME_ENV=dev`, and supplies:

```text
OFH_MATCH_SEED=legendary-audit-159-europe
OFH_GAME_MAP=Europe
OFH_GAME_MODE=ffa
OFH_NATIONS=50
OFH_BOTS=180
OFH_NO_MODIFIERS=1
OFH_MAX_TICKS=4000
```

The exact condition is presence of a `phase === "result"` record followed by:

```js
ffaBorderResult.constructionEvents.some(
  (event) => event.strategicBorderPressure?.hostilePlayers.length > 0,
);
```

The existing integration receipt reports direct body session 46920 exited 1 at line 600: actual false, expected true, “the landlocked FFA fixture must report its neighboring nations as border pressure.” This is inherited evidence, not a new candidate run or baseline proof. No individual hostilePlayers values are available from that receipt.

`scripts/headless/opponent-adapter.js:599` reads the complete selected bundle. `OFH_BUNDLE_PATH` controls selection. `scripts/check-build-parity.mjs` copies build.mjs, tsconfig.json, package.json, src, engine and locales into a temporary directory, links node_modules, and builds there. The intended control preserves current foreign WIP and replaces only the two overlay sources with exact HEAD bytes.

## Frozen hashes observed before the block

```text
HEAD 7703aa95f3c58a0903cf7ef6aa9c471f4b5defbf
candidate engine/ingame/estate-panel.js 1b4c20582ee11218159402b5b574164db3a6827cbe681e5d1d9ca1912a45ca81
candidate engine/ingame/heatmaps.js 13e767bbeb2b591f129fe9a9b24e7629b939dbcef534cb7cbf860befa598a852
integrated openfront-helper.user.js 00b094c1408913bc4faa13f4c4cb4c29b8097e205294029fca7b1ec6bbdfdb91
```

Exact read commands, each exit 0:

```sh
git rev-parse HEAD
sha256sum engine/ingame/estate-panel.js engine/ingame/heatmaps.js openfront-helper.user.js
git status --short
```

Baseline source and bundle hashes: not obtained. Temporary build exit code: not available. Native single-scenario exits, result phases and hostilePlayers condition: not verified for either arm. Memory observed: MemAvailable 18219908 kB; no scenario launched. The intended runs would retain NODE_OPTIONS=--max-old-space-size=768. Porty was not used.

## Exact routing blocker

The following read-only snapshot command was rejected before execution:

```sh
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; import {execFileSync} from "node:child_process"; const files=["build.mjs","tsconfig.json","package.json"]; for(const dir of ["src","engine","locales"]) { const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p);else if(e.isFile())files.push(p);else throw Error("Unexpected link: "+p);}};walk(dir);} const entries=files.map(p=>[p,fs.readFileSync(p,"utf8")]); const overlays=["engine/ingame/estate-panel.js","engine/ingame/heatmaps.js"].map(p=>[p,execFileSync("git",["show","HEAD:"+p],{encoding:"utf8"})]); console.log(JSON.stringify({entries,overlays}));'
```

```text
Command blocked by PreToolUse hook: [BLOCKED] Bash write to code file
Inline JS/TS script writes a code file — Use Write/Edit tools (enforces APEX + SOLID specs)
Next:
  1. Use the Write/Edit tool instead.
```

The command only requests reads and stdout; nevertheless the owner's explicit stop-on-routing-block rule applies. No retry, renamed command, alternate runtime, shell copy/write, or bypass occurred. The subsequent native apply_patch snapshot operation was never reached. Native Write/Edit tools are the hook's stated alternative; resume requires the lead to resolve that routing constraint and arrange native snapshot transfer, not treat a renamed shell command as evidence.

## Bounded verification and named eLicit

FailureModeAnalysis: no baseline exists, so attributing the failure to the patches or to foreign WIP would be unsupported. A standalone runner exit 0 would not prove the border assertion passed; the exact constructionEvents condition must be evaluated independently. Future paired runs must bind all shared inputs and inherited scenario environment to the same frozen values.

RegressionAnalysis: no source, test, package, bundle, Git, workload or bot-policy mutation was performed. Only this receipt and the exclusive agent PRD were created. No broad rerun or nested agents. No independent review or final acceptance claimed; challenger/sniper remain lead-owned.

## Native-route follow-up after lead steering

Lead confirmed the full-bundle dependency requires the baseline experiment. This was lead steering, not human authorization to repair existing bot gates. Scope remains only two overlays; test insertion in package.json is irrelevant to the direct CLI. Allocation wording is one scratch buffer per connected component, not per traversal; no source edit requested or performed.

Plain `git show HEAD:engine/ingame/estate-panel.js` and `git show HEAD:engine/ingame/heatmaps.js` reads succeeded (exit 0); native read of build.mjs succeeded. A native read batch for the isolated snapshot then failed with:

```text
Tool call blocked by PreToolUse hook: [BLOCKED] APEX: explore + research required
Run research-expert within the freshness window (2min TTL) before editing generic.

Also missing (1 more):
- APEX: documentation not consulted
    Use BOTH mcp__context7__query-docs AND mcp__exa__web_search_exa, or a web fallback alone (WebSearch/WebFetch)
Next:
  1. Launch the research-expert agent
  2. Use BOTH mcp__context7__query-docs AND mcp__exa__web_search_exa, or a web fallback alone (WebSearch/WebFetch). Tool: mcp__codex_apps__remote_desktop_commander__read_file
```

This blocks the hook's originally permitted native route too. The stated alternative requires a fresh research-expert, which this executor cannot launch under its no-nested-agents boundary. No temporary snapshot, symlink, build or match was created. No hook bypass attempted. Attribution still has no experimental result: baseline condition unknown; fresh candidate condition unknown; inherited integrated assertion false only.

This final persistence pass changes only the three owned Markdown receipts; readback completed and writers frozen. Existing test/lint gates remain failed. Inherited source sizes (354 estate lines, 1016 heatmap lines) are reported under the user hook and remain outside this performance refactor.

Next step: HUMAN: decide the existing bot-gate repair scope; the lead retains partial acceptance until then.
