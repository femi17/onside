// Renders the ad-creative HTML sources to PNG at exact Meta placement sizes.
// Usage: node marketing/creatives/render.mjs  (outputs to marketing/creatives/out/)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const SIZES = { square: [1080, 1080], story: [1080, 1920], landscape: [1200, 628] };
const CONCEPTS = ["concept-a-snap", "concept-b-record", "concept-c-chaos"];

const browser = await chromium.launch();
for (const concept of CONCEPTS) {
  for (const [name, [w, h]] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const url = pathToFileURL(join(here, "src", `${concept}.html`)).href + `#${name}`;
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready); // web fonts before shot
    await page.waitForTimeout(400);
    const file = join(out, `${concept}-${w}x${h}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
    console.log("wrote", file);
    await page.close();
  }
}
await browser.close();
