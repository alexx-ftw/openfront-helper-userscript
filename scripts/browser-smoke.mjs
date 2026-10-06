// In-environment smoke check for the committed artifact: boots
// openfront-helper.user.js on the live site and verifies the panel mounts,
// the bridge surface is exposed, and the auto-bot diagnostic hook answers.
// Requires a headed display — headless Chromium is Cloudflare-challenged
// (403 "Just a moment...") — and network access to openfront.io.
//
// Usage: node scripts/browser-smoke.mjs
import { chromium } from "playwright-core";

const EXECUTABLE =
  process.env.OFH_CHROMIUM ??
  "/home/eros/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto("https://openfront.io", { waitUntil: "domcontentloaded" });
for (let i = 0; i < 30; i++) {
  if (!(await page.title()).includes("Just a moment")) break;
  await page.waitForTimeout(2000);
}
if ((await page.title()).includes("Just a moment")) {
  console.error("browser-smoke: Cloudflare challenge did not clear");
  process.exit(1);
}
await page.addScriptTag({ path: new URL("../openfront-helper.user.js", import.meta.url).pathname });
await page.waitForTimeout(4000);
const result = await page.evaluate(() => ({
  diag: typeof window.__autoBotDiag,
  gameIconUrl: typeof window.__OFH_gameIconUrl,
  openPopup: typeof window.__OFH_openPopup,
  launcher: Boolean(document.getElementById("openfront-helper-launcher")),
  buildMenu: null,
}));
result.buildMenu =
  result.diag === "function"
    ? Boolean((await page.evaluate(() => window.__autoBotDiag({ silent: true })))?.buildMenu)
    : false;
await browser.close();
const pass =
  result.diag === "function" &&
  result.gameIconUrl === "function" &&
  result.openPopup === "function" &&
  result.launcher &&
  result.buildMenu &&
  errors.length === 0;
console.log(
  JSON.stringify({ pass, pageErrors: errors.length, ...result }, null, 2),
);
process.exit(pass ? 0 : 1);
