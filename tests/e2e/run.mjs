/**
 * End-to-end tests in real Chrome with a fake camera (MJPEG feed of synthetic cards).
 * /api/identify is mocked, so no API keys or spend are involved.
 *
 *   npm run test:e2e
 *
 * Env: PLAYWRIGHT_CHROME_PATH (default: macOS Chrome), E2E_BASE_URL (use a running
 * server instead of starting `next dev`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcg-e2e-"));
const CHROME = process.env.PLAYWRIGHT_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 3123;
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
// Chrome's new headless mode is needed for fake-camera frames to decode.
const ARGS = ["--headless=new", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${err.message.split("\n").join("\n    ")}`);
  }
}

async function startServer() {
  if (process.env.E2E_BASE_URL) return null;
  const server = spawn("npx", ["next", "dev", "--turbopack", "-p", String(PORT)], { cwd: root, stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return server;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("dev server did not start");
}

async function bundleScenes() {
  const out = path.join(tmp, "scenes.js");
  await build({
    entryPoints: [path.join(root, "tests/e2e/scenes.ts")],
    bundle: true,
    format: "iife",
    outfile: out,
    define: { "process.env.NEXT_PUBLIC_OPENCV_URL": "undefined" },
    logLevel: "warning",
  });
  return fs.readFileSync(out, "utf8");
}

async function writeFeeds(scenesJs) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ["--headless=new"] });
  const page = await browser.newPage();
  await page.addScriptTag({ content: scenesJs });
  const feeds = { A: { title: "Lightning Bolt", hue: 10 }, B: { title: "Counterspell", hue: 210 }, Empty: { card: false } };
  for (const [name, opts] of Object.entries(feeds)) {
    const frames = await page.evaluate((o) => window.makeFrames(10, o), opts);
    fs.writeFileSync(path.join(tmp, `feed${name}.mjpeg`), Buffer.concat(frames.map((f) => Buffer.from(f, "base64"))));
  }
  await browser.close();
}

const identifyResponse = (title, extra = {}) => ({
  identification: { isCard: true, game: "Magic: The Gathering", title, subtitle: null, confidence: "high", cardType: "Instant", setCode: null, collectorNumber: null },
  match: null,
  pricingError: null,
  cache: "none",
  scannedAt: Date.now(),
  ...extra,
});

/** Open the app with a fake camera feed and a mocked /api/identify; returns page + call log. */
async function openApp(feed, { profile, respond, viewport = { width: 1200, height: 800 } }) {
  const ctx = await chromium.launchPersistentContext(path.join(tmp, profile), {
    executablePath: CHROME,
    headless: false,
    viewport,
    args: [...ARGS, `--use-file-for-fake-video-capture=${path.join(tmp, `feed${feed}.mjpeg`)}`],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const calls = [];
  await page.route("**/api/identify*", async (route) => {
    calls.push(route.request().url());
    await route.fulfill({ json: { ...respond(), scannedAt: Date.now() } });
  });
  await page.goto(BASE);
  return { ctx, page, calls };
}

const heading = (page, name) => page.getByRole("heading", { name, exact: true }).waitFor({ timeout: 45_000 });

async function main() {
  const server = await startServer();
  try {
    const scenesJs = await bundleScenes();
    await writeFeeds(scenesJs);

    console.log("detector (OpenCV in Chrome)");
    const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ["--headless=new"] });
    const page = await browser.newPage();
    await page.addScriptTag({ content: scenesJs });
    const r = await page.evaluate(() => window.detectorChecks());
    await browser.close();
    for (const [name, d] of Object.entries(r.detect)) {
      await test(`detect ${name}`, () => {
        if (name === "empty") assert.equal(d.found, false, "false positive on an empty scene");
        else if (name === "hand") assert.ok(!d.found || d.err < 0.08, "wrong quad when fingers cover the edge");
        else {
          assert.ok(d.found, "card not found");
          assert.ok(d.err < 0.08, `corner error ${(d.err * 100).toFixed(1)}% of diagonal`);
        }
      });
    }
    for (const [name, same] of Object.entries(r.sameCard)) await test(`same card: ${name}`, () => assert.equal(same, true));
    for (const [name, same] of Object.entries(r.differentCard)) await test(`different card: ${name}`, () => assert.equal(same, false));

    console.log("auto-scan + 24h device cache");
    const profile = "cache-profile";
    const run = async (feed, mockTitle, expectTitle = mockTitle, after) => {
      const app = await openApp(feed, { profile, respond: () => identifyResponse(mockTitle) });
      try {
        await heading(app.page, expectTitle);
        if (after) await after(app);
        await app.page.waitForTimeout(3000); // no repeat captures while the card stays in frame
        const cached = await app.page.getByText("cached", { exact: true }).count();
        return { calls: app.calls, cached };
      } finally {
        await app.ctx.close();
      }
    };
    await test("first scan calls the API once", async () => {
      const { calls, cached } = await run("A", "Lightning Bolt");
      assert.equal(calls.length, 1);
      assert.equal(cached, 0);
    });
    await test("same card after reload is served from the device cache", async () => {
      const { calls, cached } = await run("A", "WRONG: API called", "Lightning Bolt");
      assert.equal(calls.length, 0);
      assert.equal(cached, 1);
    });
    await test("a different card is not a false cache hit", async () => {
      assert.equal((await run("B", "Counterspell")).calls.length, 1);
    });
    await test("Rescan skips the cache and replaces the entry", async () => {
      const { calls } = await run("A", "Bolt (rescanned)", "Lightning Bolt", async ({ page }) => {
        await page.getByRole("button", { name: "Rescan (skip cache)" }).click();
        await heading(page, "Bolt (rescanned)");
      });
      assert.deepEqual(calls.map((u) => new URL(u).search), ["?fresh=1"]);
      const after = await run("A", "WRONG: API called", "Bolt (rescanned)");
      assert.equal(after.calls.length, 0);
    });

    console.log("card details + pricing");
    await test("condition, finish and set dropdowns change the price", async () => {
      const now = Math.floor(Date.now() / 1000);
      const v = (condition, printing, price) => ({ condition, printing, price, lastUpdated: now - 3 * 3600 });
      const printing = (id, setName, number, rarity, base) => ({
        id, name: "Jackie Welles - Mama's Favorite", setName, setCode: null, number, rarity, imageUrl: null, url: null,
        tcgplayerId: "555", scryfallId: null, priceSource: "JustTCG", priceAsOf: null, canRefinePrice: false,
        variants: [v("Near Mint", "Normal", base), v("Lightly Played", "Normal", +(base * 0.85).toFixed(2)), v("Moderately Played", "Normal", +(base * 0.7).toFixed(2)), v("Damaged", "Normal", null), v("Near Mint", "Foil", base * 3), v("Lightly Played", "Foil", base * 2.5)],
      });
      const response = identifyResponse("Jackie Welles", {
        identification: { isCard: true, game: "Cyberpunk TCG", title: "Jackie Welles", subtitle: "Mama's Favorite", confidence: "high", cardType: "Legend", setCode: null, collectorNumber: "007" },
        match: { method: "exact", catalog: "JustTCG", exactName: true, printings: [printing("a", "Pre-Release Beta", "007", "R", 4.25), printing("b", "Promo", "P-004", "Promo", 12)] },
      });
      const app = await openApp("A", { profile: "price-profile", respond: () => response });
      try {
        const { page } = app;
        const price = () => page.locator("span.text-3xl").textContent();
        await heading(page, "Jackie Welles - Mama's Favorite");
        assert.equal(await price(), "$4.25");
        await page.getByLabel("Condition").selectOption("Lightly Played");
        assert.equal(await price(), "$3.61");
        await page.getByLabel("Condition").selectOption("Damaged");
        assert.equal(await price(), "No price");
        await page.getByLabel("Condition").selectOption("Moderately Played");
        await page.getByLabel("Printing").selectOption("Foil");
        assert.equal(await page.getByLabel("Condition").inputValue(), "Near Mint", "falls back when the condition isn't offered");
        await page.getByLabel("Printing").selectOption("Normal");
        assert.equal(await price(), "$2.97", "preferred condition kept");
        await page.getByLabel("Set").selectOption("b");
        assert.equal(await price(), "$8.40");
        await page.reload();
        await heading(page, "Jackie Welles - Mama's Favorite");
        assert.equal(await page.getByLabel("Condition").inputValue(), "Moderately Played", "condition remembered across visits");
      } finally {
        await app.ctx.close();
      }
    });

    await test("picking another printing fetches its per-condition prices", async () => {
      const sf = (id, setName, setCode, number, nm) => ({
        id, name: "Counterspell", setName, setCode, number, rarity: "Uncommon", imageUrl: null, url: null, tcgplayerId: null,
        scryfallId: id, priceSource: "Scryfall (TCGplayer market)", priceAsOf: null, canRefinePrice: true,
        variants: [{ condition: "Near Mint", printing: "Normal", price: nm, lastUpdated: null }],
      });
      const top = { ...sf("sf-7ed", "Seventh Edition", "7ED", "67", 1.5), priceSource: "JustTCG", canRefinePrice: false,
        variants: [{ condition: "Near Mint", printing: "Normal", price: 1.75, lastUpdated: null }, { condition: "Lightly Played", printing: "Normal", price: 1.4, lastUpdated: null }] };
      const response = identifyResponse("Counterspell", {
        match: { method: "chosen", catalog: "Scryfall", exactName: true, printings: [top, sf("sf-ice", "Ice Age", "ICE", "64", 3)] },
      });
      const app = await openApp("A", { profile: "refine-profile", respond: () => response });
      const priceCalls = [];
      await app.page.route("**/api/price*", async (route) => {
        priceCalls.push(new URL(route.request().url()).search);
        await route.fulfill({ json: { tcgplayerId: "999", variants: [
          { condition: "Near Mint", printing: "Normal", price: 4.5, lastUpdated: null },
          { condition: "Lightly Played", printing: "Normal", price: 3.9, lastUpdated: null },
        ] } });
      });
      try {
        const { page } = app;
        const price = () => page.locator("span.text-3xl").textContent();
        await heading(page, "Counterspell");
        assert.equal(await price(), "$1.75");
        assert.ok(await page.getByText(/Matched by comparing the photo/).count(), "chosen note shown");
        assert.equal(priceCalls.length, 0, "top printing is already priced");
        await page.getByLabel("Set").selectOption("sf-ice");
        await page.getByText("$4.50").waitFor({ timeout: 5000 });
        assert.deepEqual(priceCalls, ["?scryfallId=sf-ice"]);
        assert.ok(await page.getByLabel("Condition").count(), "conditions available after refining");
      } finally {
        await app.ctx.close();
      }
    });

    console.log("overlay");
    await test("guide frame is drawn before any card is detected", async () => {
      const app = await openApp("Empty", { profile: "overlay-profile", respond: () => identifyResponse("x") });
      try {
        await app.page.waitForTimeout(2500);
        const painted = await app.page.evaluate(() => {
          const c = document.querySelector("canvas");
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
          return n;
        });
        assert.ok(painted > 0, "overlay canvas is empty");
      } finally {
        await app.ctx.close();
      }
    });
  } finally {
    if (server) process.kill(-server.pid);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
