// Onside page-speed harness.
//   1. launches one Chrome (chrome-launcher)
//   2. Playwright connects over CDP and logs in once (session persists in that browser)
//   3. per route: Lighthouse (mobile + desktop) + a Playwright Web-Vitals interaction pass
//   4. checks each result against budgets, prints a table, writes raw JSON to perf/results/
//
// Auth: (app) routes are gated server-side by Supabase cookies, so Lighthouse must keep the login.
// We pass disableStorageReset:true for authed routes and clear ONLY the HTTP cache via CDP first —
// cold cache, still signed in. Public routes run fully cold (default Lighthouse storage reset).
//
// Usage (see README): set PERF_URL/PERF_EMAIL/PERF_PASSWORD then `npm run perf`.
import * as ChromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

// ---------------- config ----------------
const BASE = (process.env.PERF_URL || "").replace(/\/$/, "");
const EMAIL = process.env.PERF_EMAIL || "";
const PASSWORD = process.env.PERF_PASSWORD || "";
const RUNS = Number(process.env.PERF_RUNS || 3);
const HEADLESS = process.env.PERF_HEADLESS !== "false";
const ONLY = process.env.PERF_ONLY ? process.env.PERF_ONLY.split(",").map((s) => s.trim()) : null;

if (!BASE) { console.error("Set PERF_URL (e.g. https://onside.example.com)"); process.exit(1); }

const PUBLIC_ROUTES = ["/", "/login", "/terms", "/privacy"];
const AUTH_ROUTES = ["/tracker", "/add", "/agent", "/accumulators", "/performance", "/community", "/strategies", "/profile"];
const ROUTES = [
  ...PUBLIC_ROUTES.map((r) => ({ path: r, auth: false })),
  ...AUTH_ROUTES.map((r) => ({ path: r, auth: true })),
].filter((r) => !ONLY || ONLY.includes(r.path));

// mobile budgets (ms / unitless / KB / score). Desktop is checked with tighter LCP/TBT.
const BUDGET = { lcp: 2500, inp: 200, cls: 0.1, ttfb: 800, tbt: 200, si: 3400, jsKB: 300, totalKB: 1200, score: 85 };
const BUDGET_DESKTOP = { ...BUDGET, lcp: 1500, tbt: 150, si: 1500 };

// a light, SAFE interaction per route so INP has something to measure (never mutates data)
const INTERACT = {
  "/add": async (p) => { await p.mouse.wheel(0, 1000); await clickFirst(p, ["button:has-text('Add')", "[role='button']"]); },
  "/tracker": async (p) => { await p.mouse.wheel(0, 800); await clickFirst(p, ["button:has-text('Live')", "button:has-text('All')", "[role='tab']"]); },
  "/agent": async (p) => { await p.mouse.wheel(0, 800); await clickFirst(p, ["button[aria-label='Why the agent picked this']", "[role='button']"]); },
  "/accumulators": async (p) => { await p.mouse.wheel(0, 800); },
  "/performance": async (p) => { await p.mouse.wheel(0, 800); await clickFirst(p, ["button[aria-label^='What']", "[role='button']"]); },
  "/community": async (p) => { await p.mouse.wheel(0, 1000); },
  "/": async (p) => { await p.mouse.wheel(0, 1200); await clickFirst(p, ["a:has-text('Get started')", "a[href='/login']"]); },
  "/login": async (p) => { await p.mouse.wheel(0, 300); },
};
async function clickFirst(page, selectors) {
  for (const s of selectors) {
    const el = page.locator(s).first();
    try { if (await el.count() && await el.isVisible()) { await el.click({ trial: false, timeout: 1500, noWaitAfter: true }); return; } } catch { /* try next */ }
  }
  await page.mouse.wheel(0, -400); // fallback interaction
}

// ---------------- helpers ----------------
const median = (xs) => { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const kb = (bytes) => (bytes == null ? null : Math.round(bytes / 1024));
const ms = (x) => (x == null ? "—" : Math.round(x));
const fixed = (x, n = 3) => (x == null ? "—" : x.toFixed(n));

async function login(context) {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // robust selectors for the Supabase-style email/password form
  const email = page.locator("input[type='email'], input[name='email'], input[placeholder*='mail' i]").first();
  const pass = page.locator("input[type='password'], input[name='password']").first();
  await email.fill(EMAIL);
  await pass.fill(PASSWORD);
  const submit = page.locator("button[type='submit'], button:has-text('Sign in'), button:has-text('Log in')").first();
  await Promise.all([
    page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 }).catch(() => {}),
    submit.click(),
  ]);
  await page.waitForTimeout(1500);
  const ok = !/\/login/.test(new URL(page.url()).pathname);
  await page.close();
  return ok;
}

function extractLH(lhr) {
  const a = lhr.audits;
  const jsBytes = (a["network-requests"]?.details?.items || [])
    .filter((i) => i.resourceType === "Script")
    .reduce((s, i) => s + (i.transferSize || 0), 0);
  return {
    score: Math.round((lhr.categories.performance.score ?? 0) * 100),
    ttfb: a["server-response-time"]?.numericValue ?? null,
    fcp: a["first-contentful-paint"]?.numericValue ?? null,
    lcp: a["largest-contentful-paint"]?.numericValue ?? null,
    si: a["speed-index"]?.numericValue ?? null,
    tbt: a["total-blocking-time"]?.numericValue ?? null,
    cls: a["cumulative-layout-shift"]?.numericValue ?? null,
    totalKB: kb(a["total-byte-weight"]?.numericValue),
    jsKB: kb(jsBytes),
  };
}

async function runLighthouse(url, port, { desktop, keepSession, cdp }) {
  if (keepSession && cdp) { try { await cdp.send("Network.clearBrowserCache"); } catch { /* ignore */ } }
  const flags = { port, output: "json", logLevel: "error", onlyCategories: ["performance"], disableStorageReset: keepSession };
  const config = desktop ? desktopConfig : undefined; // undefined = default mobile config
  const result = await lighthouse(url, flags, config);
  return extractLH(result.lhr);
}

async function webVitals(context, url, routePath) {
  const page = await context.newPage();
  // web-vitals v4 doesn't export the iife path, so reference the physical file directly
  const vitalsPath = path.join(process.cwd(), "node_modules", "web-vitals", "dist", "web-vitals.iife.js");
  const cold = { lcp: null, cls: null, inp: null };
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.addScriptTag({ path: vitalsPath });
    await page.evaluate(() => {
      window.__v = {};
      // eslint-disable-next-line no-undef
      webVitals.onLCP((m) => (window.__v.lcp = m.value), { reportAllChanges: true });
      // eslint-disable-next-line no-undef
      webVitals.onCLS((m) => (window.__v.cls = m.value), { reportAllChanges: true });
      // eslint-disable-next-line no-undef
      webVitals.onINP((m) => (window.__v.inp = m.value), { reportAllChanges: true });
    });
    const fn = INTERACT[routePath];
    if (fn) { try { await fn(page); } catch { /* interaction best-effort */ } }
    await page.waitForTimeout(2500);
    Object.assign(cold, await page.evaluate(() => window.__v || {}));
  } catch { /* leave nulls */ }
  await page.close();
  return cold;
}

function checkBudget(metrics, desktop) {
  const b = desktop ? BUDGET_DESKTOP : BUDGET;
  const fails = [];
  const test = (name, val, limit, over = true) => { if (val != null && (over ? val > limit : val < limit)) fails.push(name); };
  test("LCP", metrics.lcp, b.lcp); test("CLS", metrics.cls, b.cls); test("TBT", metrics.tbt, b.tbt);
  test("TTFB", metrics.ttfb, b.ttfb); test("SI", metrics.si, b.si); test("JS", metrics.jsKB, b.jsKB);
  test("total", metrics.totalKB, b.totalKB); test("INP", metrics.inp, b.inp);
  if (metrics.score != null && metrics.score < b.score) fails.push("score");
  return fails;
}

// ---------------- main ----------------
// use Playwright's bundled Chromium so we don't depend on a system Chrome install
const chromePath = process.env.PERF_CHROME || chromium.executablePath();
const chrome = await ChromeLauncher.launch({
  chromePath,
  chromeFlags: [HEADLESS ? "--headless=new" : "", "--no-sandbox", "--disable-gpu", "--no-first-run"].filter(Boolean),
});
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
const context = browser.contexts()[0] || (await browser.newContext());
const cdpPage = await context.newPage();
const cdp = await context.newCDPSession(cdpPage);

const results = [];
try {
  if (EMAIL && PASSWORD) {
    const ok = await login(context);
    console.log(ok ? "✓ logged in" : "⚠ login may have failed — authed routes will likely redirect to /login");
  } else {
    console.log("⚠ no PERF_EMAIL/PERF_PASSWORD — skipping authed routes");
  }

  console.log("routes to run:", ROUTES.map((r) => r.path).join(", ") || "(none)");
  for (const route of ROUTES) {
    if (route.auth && (!EMAIL || !PASSWORD)) continue;
    const url = BASE + route.path;
    console.log("→", route.path);
    for (const desktop of [false, true]) {
      const form = desktop ? "desktop" : "mobile";
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        try { runs.push(await runLighthouse(url, chrome.port, { desktop, keepSession: route.auth, cdp })); }
        catch (e) { console.error(`  LH fail ${route.path} ${form} run ${i + 1}: ${e.message}`); }
      }
      if (!runs.length) continue;
      const agg = {};
      for (const k of ["score", "ttfb", "fcp", "lcp", "si", "tbt", "cls", "totalKB", "jsKB"]) agg[k] = median(runs.map((r) => r[k]));
      // one Web-Vitals interaction pass (mobile viewport only — matches the product's primary target)
      let inp = null, wvLcp = null, wvCls = null;
      if (!desktop) { const wv = await webVitals(context, url, route.path); inp = wv.inp; wvLcp = wv.lcp; wvCls = wv.cls; }
      const metrics = { ...agg, inp, wvLcp, wvCls };
      metrics.fails = checkBudget(metrics, desktop);
      results.push({ route: route.path, form, auth: route.auth, runs: runs.length, ...metrics });
      console.log(`  ${route.path.padEnd(16)} ${form.padEnd(7)} score ${String(metrics.score).padStart(3)}  LCP ${ms(metrics.lcp)}ms  TBT ${ms(metrics.tbt)}  CLS ${fixed(metrics.cls)}  INP ${ms(inp)}  JS ${metrics.jsKB}KB  ${metrics.fails.length ? "✗ " + metrics.fails.join(",") : "✓"}`);
    }
  }
} catch (e) {
  console.error("RUN ERROR:", e?.stack || e);
} finally {
  try { await browser.close(); } catch { /* ignore */ }
  try { await chrome.kill(); } catch { /* ignore */ }
}

// ---------------- report ----------------
const outDir = path.join(process.cwd(), "results");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(outDir, `perf-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify({ base: BASE, runs: RUNS, at: stamp, budget: BUDGET, results }, null, 2));

console.log("\n=== SUMMARY (median of " + RUNS + " runs) ===");
console.log("route            form     score  LCP    TBT   CLS    INP   TTFB  JS(KB) total  budget");
for (const r of results) {
  console.log(
    r.route.padEnd(16),
    r.form.padEnd(8),
    String(r.score).padStart(4),
    (ms(r.lcp) + "").padStart(6),
    (ms(r.tbt) + "").padStart(5),
    fixed(r.cls).padStart(6),
    (ms(r.inp) + "").padStart(5),
    (ms(r.ttfb) + "").padStart(5),
    (r.jsKB + "").padStart(6),
    (r.totalKB + "").padStart(6),
    r.fails.length ? " ✗ " + r.fails.join(",") : " ✓",
  );
}
const failed = results.filter((r) => r.fails.length);
console.log(`\n${results.length - failed.length}/${results.length} within budget · raw JSON: ${jsonPath}`);
process.exit(failed.length ? 1 : 0); // non-zero = regression gate for CI
