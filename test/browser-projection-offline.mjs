import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLegendaryPlannerSource } from "#test/helpers/legendary-planner-source.mjs";
import { readStructureBehaviorSource } from "#test/helpers/structure-behavior-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = process.env.OFH_BROWSER_ARTIFACT_DIR || join(tmpdir(), "ofh-browser-projection");
mkdirSync(directory, { recursive: true });
const baselineArgument = process.argv.find((argument) => argument.startsWith("--baseline-ref="));
const baselineRef =
  baselineArgument?.slice("--baseline-ref=".length) ?? "399ec4ff7c99f3a02165ce65b5b433a784c761db";
assert.match(baselineRef, /^[0-9a-f]{40}$/, "baseline must be an immutable full commit hash");
const baseline = process.argv.includes("--baseline") || Boolean(baselineArgument);
const withArtifact = process.argv.includes("--with-artifact");
const controlledGesture = withArtifact && !process.argv.includes("--raw-first-gesture");
const mode =
  (baseline ? `baseline-${baselineRef.slice(0, 7)}` : "cooperative") +
  (withArtifact ? "-artifact" : "");
const sourceAt = (path) =>
  execFileSync("/usr/bin/git", ["show", `${baselineRef}:${path}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
const planner = baseline
  ? Array.from({ length: 22 }, (_, i) =>
      sourceAt(
        `engine/ingame/auto-bot/legendary-planner/part-${String(i + 1).padStart(2, "0")}.js`,
      ),
    ).join("")
  : readLegendaryPlannerSource();
let artifact = "";
if (withArtifact)
  artifact = baseline
    ? sourceAt("openfront-helper.user.js")
    : readFileSync(join(root, "openfront-helper.user.js"), "utf8");
const structure = baseline
  ? execFileSync(
      "/usr/bin/git",
      [
        "ls-tree",
        "-r",
        "--name-only",
        baselineRef,
        "--",
        "engine/ingame/auto-bot/structure-behavior/",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter((path) => path.endsWith(".js"))
      .map(sourceAt)
      .join("")
  : readStructureBehaviorSource();
const setup = readFileSync(join(root, "test/legendary-economy-projection-budget.mjs"), "utf8")
  .split("const sharedConfig = ")[1]
  .split("const serializeValue")[0];
const fixtureSource = readFileSync(
  join(root, "test/helpers/legendary-structure-fixture.mjs"),
  "utf8",
);
const constants = fixtureSource.slice(
  fixtureSource.indexOf("  const UNIT ="),
  fixtureSource.indexOf("  const sandbox ="),
);
const script =
  constants +
  `\nconst state={settings:{enabled:true},tickGeneration:1,activeTickGeneration:null,tickInFlight:false};const WORKER_TIMEOUT_MS=50;\n` +
  planner +
  "\n" +
  structure +
  `\nconst behavior=Object.create(StructureBehavior.prototype);const sharedConfig = ${setup}\n` +
  String.raw`
let generation=0;
window.results=[];
window.longtasks=[];
window.inputs=[];
new PerformanceObserver(list=>window.longtasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
window.eventTimings=[];
new PerformanceObserver(list=>window.eventTimings.push(...list.getEntries().map(e=>({name:e.name,start:e.startTime,processingStart:e.processingStart,duration:e.duration})))).observe({type:'event',buffered:true,durationThreshold:16});
let previousFrame=performance.now();window.frameGaps=[];
function frame(now){window.frameGaps.push(now-previousFrame);previousFrame=now;requestAnimationFrame(frame)}
requestAnimationFrame(frame);
document.querySelector('#ping').onclick=e=>{window.inputs.push({name:'ping',delay:performance.now()-e.timeStamp});document.querySelector('#pings').textContent=window.inputs.length};
document.querySelector('#cancel').onclick=e=>{generation++;state.settings.enabled=false;state.tickGeneration++;window.inputs.push({name:'cancel',delay:performance.now()-e.timeStamp});document.querySelector('#status').textContent='Cancelled'};
window.runProjection=async(count=25)=>{
 if(state.tickInFlight)return false;
 state.settings.enabled=true;state.tickInFlight=true;state.activeTickGeneration=state.tickGeneration;
 const id=++generation;window.done=false;window.results=[];window.longtasks=[];window.eventTimings=[];window.inputs=[];window.frameGaps=[];
 const config=sharedConfig();const supply=fleetProducerSupply();const start=performance.now();
 window.timerProbe=null;setTimeout(()=>{window.timerProbe=performance.now()-start},10);
 document.querySelector('#status').textContent='Computing';
 for(let i=0;i<count;i++){
  if(generation!==id)break;
  const options={cost:1000,horizonTicks:102000,inputs:candidateInputs(i,supply),config};
  const value=typeof behavior.legendaryEconomyEvaluation==='function' ? await behavior.legendaryEconomyEvaluation('Port',options) : legendaryEconomyNetGold('Port',options);
  if(generation!==id)break;window.results.push(value);
 }
 window.elapsed=performance.now()-start;window.done=true;state.tickInFlight=false;state.activeTickGeneration=null;document.querySelector('#status').textContent=(generation===id?'Completed ':'Cancelled ')+window.results.length;
};
document.querySelector('#run').onclick=()=>window.runProjection(Number(document.querySelector('#count').value));
document.querySelector('#resume').onclick=()=>window.runProjection(Number(document.querySelector('#count').value));
window.ready=true;
`;
const html = `<!doctype html><html><head><title>OpenFront offline projection responsiveness</title><script>window.loadTasks=[];new PerformanceObserver(list=>window.loadTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});</script><style>body{font:18px system-ui;background:#f5f5f5;color:#222;padding:32px}button,input{font:inherit;padding:12px;margin:8px}#status{padding:20px;background:white}</style></head><body><h1>Offline projection fixture</h1><p>No game, no network actions. Real helper projection over synthetic inputs.</p><label>Candidates <input id=count type=number value=25></label><p><button id=run>Run</button><button id=ping>Interact</button><button id=cancel>Cancel</button><button id=resume>Resume</button></p><div id=status>Ready</div><p>Interactions: <span id=pings>0</span></p><script src=/planner.js></script></body></html>`;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url.endsWith(".js") ? "text/javascript" : "text/html");
  let content = html.replace(
    "<script src=/planner.js>",
    (withArtifact ? "<script src=/helper.user.js></script>" : "") + "<script src=/planner.js>",
  );
  if (req.url.endsWith(".js")) content = script;
  if (req.url === "/helper.user.js") content = artifact;
  res.end(content);
});
await new Promise((r) => {
  server.listen(0, "127.0.0.1", r);
});
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
let deadline;
const report = [];
try {
  browser = await chromium.launch({
    executablePath: process.env.OFH_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--enable-precise-memory-info"],
  });
  deadline = setTimeout(() => {
    void browser.close();
  }, 120_000);
  deadline.unref();
  for (const { count, action } of [
    { count: 1, action: "ping" },
    { count: 25, action: "ping" },
    { count: 25, action: "cancel" },
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === url ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    if (process.env.OFH_BROWSER_PROFILE === "1") {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    await page.goto(url);
    await page.waitForFunction(() => window.ready);
    if (process.env.OFH_BROWSER_PROFILE === "1") {
      const { profile } = await cdp.send("Profiler.stop");
      writeFileSync(
        join(directory, `${mode}-${count}-${action}-startup.cpuprofile`),
        JSON.stringify(profile),
      );
    }
    const load = await page.evaluate(() => ({
      navigation: performance.getEntriesByType("navigation")[0].toJSON(),
      longtasks: window.loadTasks,
      longtaskSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"),
      eventTimingSupported: PerformanceObserver.supportedEntryTypes.includes("event"),
      heading: document.querySelector("h1").textContent,
      helperLauncher: Boolean(document.querySelector("#openfront-helper-launcher")),
      helperDiagnostic: typeof window.__autoBotDiag,
    }));
    assert.ok(
      load.longtaskSupported && load.eventTimingSupported,
      "browser exposes real timing observers",
    );
    assert.equal(load.heading, "Offline projection fixture", "meaningful fixture renders");
    let firstGesture = null;
    if (controlledGesture) {
      await page.evaluate(() => {
        window.longtasks = [];
        window.inputs = [];
        window.frameGaps = [];
      });
      await page.locator("#ping").click();
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(resolve);
            });
          }),
      );
      firstGesture = await page.evaluate(() => ({
        longtasks: window.longtasks,
        inputs: window.inputs,
        frameMax: Math.max(...window.frameGaps),
      }));
    }
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await cdp.send("Performance.getMetrics");
    await page.locator("#count").fill(String(count));
    const points = await page.locator("#" + action).boundingBox();
    const profiling = process.env.OFH_BROWSER_PROFILE === "1" && action === "ping";
    if (profiling) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    await page.evaluate(() => setTimeout(() => document.querySelector("#run").click(), 0));
    const work = page.waitForFunction(() => window.done === true);
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    const inputAt = Date.now() / 1000;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: points.x + 10,
      y: points.y + 10,
      button: "left",
      clickCount: 1,
      timestamp: inputAt,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: points.x + 10,
      y: points.y + 10,
      button: "left",
      clickCount: 1,
      timestamp: inputAt,
    });
    await work;
    if (profiling) {
      const { profile } = await cdp.send("Profiler.stop");
      writeFileSync(join(directory, mode + "-" + count + ".cpuprofile"), JSON.stringify(profile));
    }
    await page.waitForFunction(() => window.inputs.length && window.timerProbe !== null);
    await new Promise((r) => {
      setTimeout(r, 120);
    });
    const data = await page.evaluate(() => ({
      elapsed: window.elapsed,
      longtasks: window.longtasks,
      eventTimings: window.eventTimings,
      inputs: window.inputs,
      timerProbe: window.timerProbe,
      frameMax: Math.max(...window.frameGaps),
      results: window.results,
      identity: {
        url: location.href,
        title: document.title,
        status: document.querySelector("#status").textContent,
      },
      memory: performance.memory
        ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize }
        : null,
    }));
    writeFileSync(
      join(directory, `${mode}-${count}-${action}-measurement.json`),
      JSON.stringify({ data, load, firstGesture, errors }, null, 2) + "\n",
    );
    await cdp.send("HeapProfiler.collectGarbage");
    const after = await cdp.send("Performance.getMetrics");
    const heap = (metrics) =>
      Object.fromEntries(
        metrics.metrics
          .filter((x) => /JSHeap|Nodes|Documents/.test(x.name))
          .map((x) => [x.name, x.value]),
      );
    let restart = null;
    const memoryRuns = [];
    if (action === "cancel") {
      assert.ok(
        data.inputs.some((e) => e.name === "cancel"),
        "trusted cancel click is processed",
      );
      if (!baseline)
        assert.ok(data.results.length < count, "cancellation interrupts real projection work");
      await page.locator("#resume").click();
      await page.waitForFunction(() => window.done === true);
      restart = await page.evaluate(() => ({
        results: window.results,
        elapsed: window.elapsed,
        status: document.querySelector("#status").textContent,
      }));
      assert.equal(restart.results.length, count, "restart finishes all candidates");
      for (let repeat = 0; repeat < 3; repeat++) {
        await page.evaluate(() => window.runProjection(25));
        await cdp.send("HeapProfiler.collectGarbage");
        const metrics = heap(await cdp.send("Performance.getMetrics"));
        const outcome = await page.evaluate(() => ({
          count: window.results.length,
          longtasks: window.longtasks,
        }));
        assert.equal(outcome.count, 25, "repeated restart completes all work");
        assert.ok(baseline || outcome.longtasks.length === 0, "repeated work stays cooperative");
        memoryRuns.push({ ...metrics, ...outcome });
      }
      assert.ok(
        memoryRuns.at(-1).JSHeapUsedSize - memoryRuns[0].JSHeapUsedSize < 4 * 1024 * 1024,
        "repeated completed/cancelled runs do not retain unbounded heap",
      );
    }
    assert.equal(data.identity.title, "OpenFront offline projection responsiveness");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    const goldens = JSON.parse(
      readFileSync(
        join(root, "test/fixtures/legendary-economy-projection-budget.golden.json"),
        "utf8",
      ),
    );
    const values = restart?.results ?? data.results;
    assert.deepEqual(
      values.map((value) => JSON.stringify(value)),
      goldens.warm.slice(0, count),
      "browser outputs retain all numerical goldens",
    );
    if (!baseline) {
      assert.equal(data.longtasks.length, 0, "fixture work must not create a >=50ms longtask");
      assert.ok(data.inputs[0].delay < 100, "trusted interaction is serviced within100ms");
      assert.ok(data.frameMax < 100, "fixture rendering keeps making progress");
    }
    report.push({
      count,
      action,
      load,
      firstGesture,
      ...data,
      restart,
      memoryRuns,
      errors,
      heapBefore: heap(before),
      heapAfter: heap(after),
    });
    await page.screenshot({ path: `${directory}/${mode}-${count}-${action}.png` });
    await context.close();
  }
  writeFileSync(
    `${directory}/${mode}.json`,
    JSON.stringify(
      { browser: browser.version(), baselineRef: baseline ? baselineRef : null, url, report },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    JSON.stringify(
      report.map(
        ({
          count,
          elapsed,
          longtasks,
          inputs,
          timerProbe,
          frameMax,
          heapBefore,
          heapAfter,
          errors,
        }) => ({
          count,
          elapsed,
          longtasks,
          inputs,
          timerProbe,
          frameMax,
          heapBefore,
          heapAfter,
          errors,
        }),
      ),
      null,
      2,
    ) + "\n",
  );
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await new Promise((r) => {
    server.close(r);
  });
}
