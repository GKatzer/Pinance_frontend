// Regenerates the screenshots and GIFs in docs/media/ from a running Pinance frontend.
// The committed media were taken from `npm run dev` of this repository with
// VITE_DEV_API_PROXY pointing at the public backend (BASE_URL=http://127.0.0.1:5173).
//
//   npm i playwright-core            # in any scratch directory; no browser download needed
//   BASE_URL=https://pinance.katzer.ru CHROME_PATH=/usr/bin/google-chrome \
//     node capture-media.mjs <outDir> shots     # static PNGs
//   ... node capture-media.mjs <outDir> gifs    # needs ffmpeg on PATH
//   BASE_URL=http://127.0.0.1:5173 node capture-media.mjs <outDir> empty   # dev server with no backend
//
// Only reads public pages. Frames are plain page screenshots, so no Playwright video codec is needed.
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const BASE = (process.env.BASE_URL ?? "https://pinance.katzer.ru").replace(/\/$/, "");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const [outDir = "media", mode = "shots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const newPage = async (opts = {}) => (await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts })).newPage();
const open = async (p, query = "", settle = 9000) => {
  await p.goto(`${BASE}/${query}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(settle);
};

async function shots() {
  const p = await newPage();
  for (const [name, q] of [["live-prediction", ""], ["model-performance", "?tab=perf"], ["mlops", "?tab=ops"]]) {
    await open(p, q);
    await p.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  }

  await open(p);
  const box = await p.locator(".chart-panel").boundingBox();
  const at = async (fx, fy) => { await p.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 6 }); await p.waitForTimeout(600); };
  await at(0.62, 0.55);
  await p.screenshot({ path: `${outDir}/chart-tooltip-history.png`, clip: box });
  await at(0.93, 0.6);
  await p.screenshot({ path: `${outDir}/chart-tooltip-forecast.png`, clip: box });
  await p.getByRole("button", { name: "1W", exact: true }).click();
  await p.waitForTimeout(4000);
  await at(0.5, 0.5);
  await p.screenshot({ path: `${outDir}/chart-1w-rest.png`, clip: box });

  await open(p);
  await p.locator(".pair-select").click();
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${outDir}/pair-menu.png`, clip: { x: 900, y: 30, width: 540, height: 260 } });

  await open(p);
  await p.getByText("HRZN").click();
  await p.waitForTimeout(400);
  const log = await p.locator(".log").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y + window.scrollY, width: r.width };
  });
  await p.screenshot({ path: `${outDir}/prediction-log-horizon-filter.png`, fullPage: true,
    clip: { x: log.x - 10, y: log.y - 40, width: log.width + 20, height: 240 } });

  const m = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await open(m);
  await m.screenshot({ path: `${outDir}/mobile-live.png` });
}

async function empty() {
  const p = await newPage();
  await open(p, "", 6000);
  await p.screenshot({ path: `${outDir}/no-backend-live.png` });
  await open(p, "?tab=ops", 5000);
  await p.screenshot({ path: `${outDir}/no-backend-mlops.png` });
}

// Screenshot loop while `steps` drives the page, then ffmpeg palette GIF (900 px wide, 10 fps).
async function gif(name, steps) {
  const p = await newPage();
  await open(p, "", 7000);
  const dir = `${outDir}/_frames-${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let n = 0, running = true;
  const t0 = Date.now();
  const loop = (async () => { while (running) await p.screenshot({ path: `${dir}/f${String(n++).padStart(4, "0")}.jpg`, type: "jpeg", quality: 80 }); })();
  await steps(p);
  running = false;
  await loop;
  const fps = (n / ((Date.now() - t0) / 1000)).toFixed(2);
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", fps, "-i", `${dir}/f%04d.jpg`, "-vf",
    "fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    `${outDir}/${name}.gif`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed");
  rmSync(dir, { recursive: true, force: true });
}

async function gifs() {
  await gif("chart-tour", async (p) => {
    const box = await p.locator(".chart-panel").boundingBox();
    const y = box.y + box.height * 0.55;
    for (let i = 0; i <= 28; i++) { await p.mouse.move(box.x + box.width * (0.1 + i * 0.03), y); await p.waitForTimeout(60); }
    for (const tf of ["1W", "1M", "ALL", "24H"]) {
      await p.getByRole("button", { name: tf, exact: true }).click();
      await p.waitForTimeout(1200);
      await p.mouse.move(box.x + box.width * 0.55, y, { steps: 4 });
      await p.waitForTimeout(400);
    }
  });
  await gif("pair-and-tabs", async (p) => {
    for (const sym of ["ETH", "SOL"]) {
      await p.locator(".pair-select").click();
      await p.waitForTimeout(600);
      await p.locator(".dropdown-item", { hasText: sym }).click();
      await p.waitForTimeout(2500);
    }
    await p.locator(".tab", { hasText: "Model Performance" }).click();
    await p.waitForTimeout(2800);
    await p.mouse.wheel(0, 600);
    await p.waitForTimeout(1200);
    await p.locator(".tab", { hasText: "MLOps" }).click();
    await p.waitForTimeout(2800);
  });
}

if (mode === "shots" || mode === "all") await shots();
if (mode === "empty") await empty();
if (mode === "gifs" || mode === "all") await gifs();
await browser.close();
