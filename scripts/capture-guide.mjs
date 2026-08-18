// Capture the "how Onside works" walkthrough as fresh screenshots, so the guide can never rot.
// Logs in as the seeded demo account (staged slips/agents — no real user's data) at a mobile
// viewport and shoots each step of the golden path into public/guide/.
//
//   GUIDE_EMAIL=demo@onside.com.ng GUIDE_PASSWORD=... node scripts/capture-guide.mjs
//   (optional GUIDE_URL, default https://www.onside.com.ng)
//
// Re-run after any UI change, commit the new PNGs, done.
import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.GUIDE_URL ?? "https://www.onside.com.ng";
const EMAIL = process.env.GUIDE_EMAIL;
const PASSWORD = process.env.GUIDE_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Set GUIDE_EMAIL and GUIDE_PASSWORD (the demo account) first.");
  process.exit(1);
}

const OUT = "public/guide";
mkdirSync(OUT, { recursive: true });

// step name → route; shot as step-<n>-<name>.png in this order
const STEPS = [
  ["upload", "/add"],
  ["tracker", "/tracker"],
  ["agents", "/agent"],
  ["accas", "/accumulators"],
  ["performance", "/performance"],
];

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    ...devices["iPhone 13"],
    // the app is a dark product — match what users see
    colorScheme: "dark",
  });
  const page = await ctx.newPage();

  console.log(`→ signing in at ${URL}/login`);
  await page.goto(`${URL}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  console.log("✓ signed in");

  let n = 0;
  for (const [name, route] of STEPS) {
    n++;
    await page.goto(`${URL}${route}`, { waitUntil: "networkidle" });
    // let streamed sections (Suspense) and score ticks settle before shooting
    await page.waitForTimeout(2500);
    const file = `${OUT}/step-${n}-${name}.png`;
    await page.screenshot({ path: file, fullPage: false });
    console.log(`✓ ${file}`);
  }

  await browser.close();
  console.log("Done — screenshots in public/guide/. Commit them and /how-it-works updates itself.");
};

run().catch((e) => { console.error(e); process.exit(1); });
