// Loads the unpacked extension in Chromium and checks detection, the hover card, the full view and the popup.
// Usage: node test/smoke.mjs [--screens]   (run from the pdb-peek folder)
import { chromium } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const storeDir = path.join(root, "store");
const screens = process.argv.includes("--screens");
const demoUrl = "https://en.wikipedia.org/wiki/PDB_Peek_demo";
const demoHtml = readFileSync(path.join(root, "test", "demo.html"), "utf8");
const failures = [];
const consoleErrors = [];

function check(condition, message) {
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
}

const userData = mkdtempSync(path.join(tmpdir(), "pdbpeek-"));
const context = await chromium.launchPersistentContext(userData, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  check(Boolean(extensionId), `extension loaded (${extensionId})`);

  await context.route(demoUrl, (route) => route.fulfill({ status: 200, contentType: "text/html", body: demoHtml }));
  const page = await context.newPage();
  page.on("console", (msg) => msg.type() === "error" && consoleErrors.push(`page: ${msg.text()}`));
  await page.goto(demoUrl);
  await page.waitForSelector("#p-dynamic .pdbpeek-id", { timeout: 10000 });

  const found = await page.$$eval(".pdbpeek-id", (spans) => spans.map((s) => s.dataset.pdbpeekId));
  const expected = ["1HHO", "6VXX", "6VYB", "6VSB", "1TIM", "3J3Q", "7K3G"];
  check(JSON.stringify(found) === JSON.stringify(expected), `text IDs found: ${found.join(", ")}`);
  check(await page.$eval("#link-deoxy", (a) => a.dataset.pdbpeek) === "4HHB", "RCSB link marked as 4HHB");
  check(await page.$$eval("#p-negative .pdbpeek-id", (s) => s.length) === 0, "no false matches for years, file names or PDB2PQR");

  // Hover card
  await page.hover('.pdbpeek-id[data-pdbpeek-id="1HHO"]');
  const cardHandle = await page.waitForSelector('iframe[title="PDB Peek structure preview"]', { state: "visible", timeout: 5000 });
  const card = await cardHandle.contentFrame();
  await card.waitForFunction(() => document.getElementById("peek-title").textContent.includes("oxyhaemoglobin"), null, { timeout: 15000 });
  await card.waitForFunction(() => document.getElementById("peek-status").textContent === "" && document.querySelector("#peek-3d canvas"), null, { timeout: 20000 });
  const cardMeta = await card.$eval("#peek-meta", (el) => el.textContent);
  check(cardMeta.includes("2.10") && cardMeta.includes("1983") && cardMeta.includes("Homo sapiens"), `card meta: ${cardMeta}`);
  check(await card.$eval("#peek-method", (el) => el.textContent) === "X-ray", "card method label");
  const cta = await card.$eval("#peek-cta", (a) => a.href);
  check(cta.startsWith("https://animiotics.com/molecular-animation-software?utm_source=pdb_peek"), "card CTA links to Animiotics with UTM");
  await page.waitForTimeout(1200);
  if (screens) await page.screenshot({ path: path.join(storeDir, "screenshot-1-hover-card.png") });

  // Moving away hides the card
  await page.mouse.move(1200, 780);
  await page.waitForTimeout(800);
  check(await cardHandle.evaluate((el) => getComputedStyle(el).display) === "none", "card hides when the pointer leaves");

  // Full view
  const full = await context.newPage();
  full.on("console", (msg) => msg.type() === "error" && consoleErrors.push(`full: ${msg.text()}`));
  full.on("pageerror", (err) => consoleErrors.push(`full: ${err.message}`));
  await full.goto(`chrome-extension://${extensionId}/viewer.html?mode=full&id=6VXX`);
  await full.waitForFunction(() => document.querySelector("#peek-facts dt") && document.querySelector("#peek-3d canvas") && document.getElementById("peek-status").textContent === "", null, { timeout: 30000 });
  const facts = await full.$$eval("#peek-facts dt", (dts) => dts.map((dt) => dt.textContent));
  check(facts.includes("Method") && facts.includes("Organism"), `full view facts: ${facts.join(", ")}`);
  check(await full.$eval("#peek-method", (el) => el.textContent) === "EM", "EM method label");
  await full.click('[data-style="sphere"]');
  check(await full.$eval('[data-style="sphere"]', (b) => b.getAttribute("aria-pressed")) === "true", "style switch");
  await full.click('[data-style="cartoon"]');
  await full.waitForTimeout(1500);
  if (screens) await full.screenshot({ path: path.join(storeDir, "screenshot-2-full-view.png") });
  await full.emulateMedia({ colorScheme: "dark" });
  await full.reload();
  await full.waitForFunction(() => document.querySelector("#peek-3d canvas") && document.getElementById("peek-status").textContent === "", null, { timeout: 30000 });
  await full.waitForTimeout(1500);
  if (screens) await full.screenshot({ path: path.join(storeDir, "screenshot-3-full-view-dark.png") });

  // Bad and missing IDs
  await full.goto(`chrome-extension://${extensionId}/viewer.html?mode=full&id=hello`);
  check((await full.textContent("#peek-title")) === "Not a PDB ID", "invalid ID message");
  // 9XQZ is well formed but had no entry on 2026-10-26.
  const missing = await context.newPage();
  await missing.goto(`chrome-extension://${extensionId}/viewer.html?mode=full&id=9XQZ`);
  let missingTitle = "";
  for (let i = 0; i < 30 && !missingTitle.startsWith("No PDB entry"); i++) {
    await missing.waitForTimeout(500);
    missingTitle = await missing.textContent("#peek-title");
  }
  check(missingTitle.startsWith("No PDB entry"), `missing entry message (${missingTitle} | ${await missing.textContent("#peek-status")})`);
  await missing.close();

  // Popup search
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height: 520 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill("#query", "hemoglobin");
  await popup.click('button[type="submit"]');
  await popup.waitForSelector("#results button", { timeout: 15000 });
  const hits = await popup.$$eval("#results button", (b) => b.length);
  check(hits > 0, `popup name search returned ${hits} entries`);
  if (screens) await popup.screenshot({ path: path.join(storeDir, "popup.png") });

  // Turning highlighting off removes the marks
  await popup.uncheck("#enabled");
  await page.waitForTimeout(500);
  check(await page.$$eval(".pdbpeek-id", (s) => s.length) === 0, "turning it off removes the highlights");
  await popup.check("#enabled");
  await page.waitForTimeout(500);
  check(await page.$$eval(".pdbpeek-id", (s) => s.length) > 0, "turning it on brings them back");

  // A real page
  const live = await context.newPage();
  await live.goto("https://en.wikipedia.org/wiki/Hemoglobin", { waitUntil: "domcontentloaded" });
  await live.waitForTimeout(2500);
  const liveCount = await live.$$eval(".pdbpeek-id, a[data-pdbpeek]", (els) => els.length);
  const liveIds = await live.$$eval(".pdbpeek-id, a[data-pdbpeek]", (els) => [...new Set(els.map((e) => e.dataset.pdbpeekId || e.dataset.pdbpeek))].slice(0, 12));
  check(liveCount > 0, `live Wikipedia Hemoglobin page: ${liveCount} marks (${liveIds.join(", ")})`);
} finally {
  await context.close();
  rmSync(userData, { recursive: true, force: true });
}

const relevantErrors = consoleErrors.filter((e) => !/favicon|ERR_BLOCKED_BY_CLIENT/i.test(e));
check(relevantErrors.length === 0, `console errors: ${relevantErrors.length ? relevantErrors.join(" | ") : "none"}`);
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
