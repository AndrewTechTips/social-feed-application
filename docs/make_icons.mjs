// Renders the app icons and the Open Graph card from the same brand mark the
// header draws, so none of them can drift from the app they represent.
//
//   node docs/make_icons.mjs
//
// Outputs into frontend/assets/icons/ and frontend/assets/og.png. The results
// are committed — this is a generator, not a build step; nothing at runtime
// depends on it having been run.
//
// Chromium rather than a raster library because the mark is an SVG path and
// the OG card wants the app's real typeface. Playwright is already a dev
// dependency for the end-to-end suite, so this costs nothing extra.

// Same explicit path docs/capture.mjs uses: this script lives in docs/, and
// node_modules is under frontend/.
import { chromium } from "../frontend/node_modules/playwright/index.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "frontend", "assets");
const iconDir = path.join(assets, "icons");

// Straight out of tokens.css.
const BG = "#0c1315";
const INK = "#e7edec";
const ACCENT = "#f0a63c";

/** The brand mark, as index.html draws it. */
const mark = (stroke = INK, fill = ACCENT) => `
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" fill="none" stroke="${stroke}" stroke-width="1.6" />
    <circle cx="12" cy="10" r="2.6" fill="${fill}" />
    <path d="M10.7 11.6 L9.6 16.2 A0.6 0.6 0 0 0 10.2 17 h3.6 a0.6 0.6 0 0 0 0.6-.8 L13.3 11.6 Z" fill="${fill}" />
  </svg>`;

/**
 * One square icon.
 * @param {number} size
 * @param {"any" | "maskable"} purpose  maskable keeps the glyph inside the
 *   80% safe circle, because Android will crop the corners off to whatever
 *   shape the launcher prefers.
 * @param {boolean} transparent  for the favicon, which sits on browser chrome
 */
function iconHtml(size, purpose, transparent = false) {
  const inset = purpose === "maskable" ? 0.62 : 0.82;
  const radius = purpose === "maskable" ? 0 : Math.round(size * 0.22);
  return `<!doctype html><meta charset="utf-8">
  <style>
    html, body { margin: 0; background: transparent; }
    .plate {
      width: ${size}px; height: ${size}px;
      display: grid; place-items: center;
      background: ${transparent ? "transparent" : BG};
      border-radius: ${transparent ? 0 : radius}px;
    }
    .plate svg { width: ${Math.round(size * inset)}px; height: ${Math.round(size * inset)}px; }
  </style>
  <div class="plate">${mark()}</div>`;
}

/** The 1200x630 link preview. */
async function ogHtml() {
  const font = await readFile(path.join(assets, "fonts", "newsreader.woff2"));
  return `<!doctype html><meta charset="utf-8">
  <style>
    @font-face {
      font-family: "Newsreader";
      src: url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");
      font-weight: 200 700;
    }
    html, body { margin: 0; }
    .card {
      position: relative; overflow: hidden;
      width: 1200px; height: 630px;
      background: ${BG};
      display: flex; flex-direction: column; justify-content: center;
      padding: 0 96px; box-sizing: border-box;
      font-family: "Newsreader", Georgia, serif; color: ${INK};
    }
    /* The same two slow blooms that sit behind the app. */
    .bloom { position: absolute; border-radius: 50%; filter: blur(90px); }
    .warm { width: 620px; height: 620px; left: -260px; top: -240px;
            background: rgba(240,166,60,.14); }
    .cool { width: 820px; height: 820px; right: -260px; bottom: -300px;
            background: rgba(64,176,156,.15); }
    .row { position: relative; display: flex; align-items: center; gap: 20px;
           margin-bottom: 40px; }
    .row svg { width: 56px; height: 56px; }
    .wordmark { font-size: 44px; letter-spacing: .01em; }
    h1 { position: relative; margin: 0 0 28px; font-size: 82px; font-weight: 400;
         line-height: 1.05; letter-spacing: -.015em; max-width: 17ch; }
    p { position: relative; margin: 0; font-size: 30px; line-height: 1.45;
        color: #93a3a1; max-width: 40ch;
        font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
    .rule { position: relative; width: 76px; height: 3px; background: ${ACCENT};
            margin: 0 0 40px; border-radius: 2px; }
  </style>
  <div class="card">
    <span class="bloom warm"></span><span class="bloom cool"></span>
    <div class="row">${mark()}<span class="wordmark">Commons</span></div>
    <div class="rule"></div>
    <h1>A small public common.</h1>
    <p>A hand-written feed on a FastAPI backend. No framework, no build step.</p>
  </div>`;
}

const ICONS = [
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "icon-maskable-192.png", size: 192, purpose: "maskable" },
  { file: "icon-maskable-512.png", size: 512, purpose: "maskable" },
  { file: "apple-touch-icon.png", size: 180, purpose: "any" },
  { file: "favicon-32.png", size: 32, purpose: "any", transparent: true },
  { file: "favicon-16.png", size: 16, purpose: "any", transparent: true },
];

const browser = await chromium.launch();
await mkdir(iconDir, { recursive: true });

for (const { file, size, purpose, transparent } of ICONS) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(iconHtml(size, purpose, transparent));
  const buffer = await page.locator(".plate").screenshot({ omitBackground: true });
  await writeFile(path.join(iconDir, file), buffer);
  await page.close();
  console.log(`${file}  ${size}x${size}  ${purpose}`);
}

const og = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await og.setContent(await ogHtml());
await og.waitForTimeout(300); // let the embedded font settle before the shot
await writeFile(path.join(assets, "og.png"), await og.locator(".card").screenshot());
await og.close();
console.log("og.png  1200x630");

await browser.close();
