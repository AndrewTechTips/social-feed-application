// Renders the app icons, the shortcut glyphs, the Open Graph card and the
// install-dialog screenshots — all from the same sources the app itself draws
// from, so none of them can drift from the app they represent.
//
//   node docs/make_icons.mjs
//
// Outputs into frontend/assets/icons/, frontend/assets/screenshots/ and
// frontend/assets/og.png. The results are committed — this is a generator, not
// a build step; nothing at runtime depends on it having been run.
//
// Chromium rather than a raster library because the mark is an SVG path and
// the OG card wants the app's real typeface. Playwright is already a dev
// dependency for the end-to-end suite, so this costs nothing extra.
//
// The screenshots are captures of the app actually running, in demo mode,
// against a static server this script starts itself on an ephemeral port — so
// this stays one command with nothing to start first, and nothing to collide
// with a dev server already on 5173. Set APP_URL to use a server you already
// have running instead.

// Same explicit path docs/capture.mjs uses: this script lives in docs/, and
// node_modules is under frontend/.
import { chromium } from "../frontend/node_modules/playwright/index.mjs";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, "..", "frontend");
const assets = path.join(app, "assets");
const iconDir = path.join(assets, "icons");
const shotDir = path.join(assets, "screenshots");

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

// The sprite the header, the shelf button and the lamp all draw from. Read
// rather than copied: a shortcut icon that is a second copy of the pencil is a
// pencil that goes stale the first time the real one is redrawn.
const sprite = await readFile(path.join(assets, "icons.svg"), "utf8");

/**
 * One symbol out of assets/icons.svg, lifted into a standalone <svg> with its
 * own attributes intact — including the `currentColor` strokes, which is why
 * the plate below sets `color`.
 * @param {string} name  the id without the `i-` prefix
 */
function glyph(name) {
  const found = sprite.match(
    new RegExp(`<symbol id="i-${name}"([\\s\\S]*?)</symbol>`),
  );
  if (!found) throw new Error(`no glyph "i-${name}" in assets/icons.svg`);
  const rest = found[1];
  const close = rest.indexOf(">");
  return `<svg xmlns="http://www.w3.org/2000/svg"${rest.slice(0, close)}>${rest.slice(close + 1)}</svg>`;
}

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

/**
 * One manifest shortcut icon: a line glyph on the same plate the app icons use,
 * so the long-press menu looks like it belongs to the icon it came out of.
 *
 * The glyph sits at 56% rather than the app icon's 82%. Launchers mask these to
 * whatever shape they like — a circle on most of Android — and a glyph drawn to
 * the edge is a glyph with its corners taken off.
 * @param {number} size
 * @param {string} name
 */
function shortcutHtml(size, name) {
  return `<!doctype html><meta charset="utf-8">
  <style>
    html, body { margin: 0; background: transparent; }
    .plate {
      width: ${size}px; height: ${size}px;
      display: grid; place-items: center;
      background: ${BG}; color: ${INK};
      border-radius: ${Math.round(size * 0.22)}px;
    }
    .plate svg { width: ${Math.round(size * 0.56)}px; height: ${Math.round(size * 0.56)}px; }
  </style>
  <div class="plate">${glyph(name)}</div>`;
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

// 96x96 is what Android asks for, and what every launcher scales from.
const SHORTCUT_SIZE = 96;
const SHORTCUTS = [
  { file: "shortcut-compose.png", glyph: "pencil" },
  { file: "shortcut-shelf.png", glyph: "bookmark" },
  { file: "shortcut-notifications.png", glyph: "lamp" },
];

// ── the static server ──────────────────────────────────────────────────────
// Enough of one to serve a directory of files that are already static. The
// only thing here that is not obvious is the MIME table: a module script
// served as application/octet-stream is a module script the browser refuses,
// so getting this wrong doesn't degrade, it blanks the page.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** @param {string} root */
async function serve(root) {
  const server = createServer((req, res) => {
    (async () => {
      let name = decodeURIComponent(
        new URL(req.url || "/", "http://x").pathname,
      );
      if (name.endsWith("/")) name += "index.html";
      const file = path.join(root, name);
      // path.join has already normalised away any `..`; this is what catches
      // one that climbed out of the directory before it did.
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Content-Length": info.size,
        // The app registers a service worker. Nothing here should be answered
        // out of a cache that a previous run warmed.
        "Cache-Control": "no-store",
      });
      createReadStream(file).pipe(res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done(undefined))),
  };
}

// ── the screenshots ────────────────────────────────────────────────────────
// Chrome's rich install dialog has rules, and a screenshot that breaks one is
// a screenshot it drops without saying so: 320–3840px on both axes, neither
// side more than 2.3x the other, and every screenshot of a given form factor
// the same aspect ratio as its siblings. 1100x800 (1.375) and 412x824 (2.0)
// are inside all three with room to spare.
//
// 1100 rather than a true desktop width for the reason docs/capture.mjs gives
// about the README thumbnails: the app centres a 640px reading column, so a
// 1440px capture is mostly background. 1100 keeps the desktop layout — the
// header stays on one row — without the dead margins either side of it.
//
// deviceScaleFactor 2 because the dialog is shown on the kind of display that
// notices; it doubles the stated sizes, which is what the manifest has to say
// and what tests/offline.spec.js reads back out of the PNG header.
const DPR = 2;
const WIDE = { width: 1100, height: 800 };
const NARROW = { width: 412, height: 824 };

// Nothing mid-animation, no caret blinked into a capture. The same block
// docs/capture.mjs uses, for the same reason.
const SETTLE = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
  }
  .aurora-bloom { animation: none !important; }
  * { caret-color: transparent !important; }
`;

// A real card, not one of the skeletons index.html stamps out while the feed
// loads. Waiting on `.card` alone is waiting for the loading state, which is
// how you end up with a committed screenshot of four grey bars.
const CARD = ".card:not(.card--skeleton)";

// Which post gets its picture taken, reached through the app's own search
// rather than by position in the feed.
//
// The obvious thing — click the heading you want — quietly depends on that
// post being on the first page, and the feed is ranked by votes *and* age
// (ADR 0008), so where any given post sits moves with the clock. It was on
// page one when this was written and it is not now. Searching asks the
// question the URL can actually answer: one word, one result, no ranking in
// the path. This one because it carries the longest thread in the seed, and a
// post screen with "Nothing said about this one yet." under it is a screenshot
// of an empty room.
const POST = {
  query: "rebuilding",
  title: "What I learned rebuilding a wall that didn't need rebuilding",
};

// What gets photographed, and how to get there. The names are half of each
// output filename; the *words* that go with them — the `label` on each entry
// in the manifest's `screenshots` array — live in manifest.webmanifest, which
// is the file a browser actually reads. tests/offline.spec.js checks that the
// sizes it declares are the sizes these files really are, so the two cannot
// drift the one way that matters.
const SCREENS = [
  {
    name: "feed",
    open: async (page, origin) => {
      await page.goto(`${origin}/?demo=1#/`);
      await page.waitForSelector(".masthead");
      await page.waitForSelector(CARD);
    },
  },
  {
    name: "post",
    // The band under the header is folded away — with the app's own control,
    // via the key it keeps it under, not by hiding an element. The feed shot
    // above still carries the demo notice in full inside the masthead, which
    // is where a first-time reader meets it anyway.
    fold: true,
    open: async (page, origin) => {
      await page.goto(`${origin}/?demo=1#/?search=${POST.query}`);
      await page.waitForSelector(CARD);
      const link = page.locator(`${CARD} .card__link`).first();
      // Loudly, here, rather than silently in the committed PNG: if the seed
      // moves under this, the screenshot is of the wrong post and nothing else
      // in the project would ever say so.
      const found = (await link.innerText()).split("\n")[0].trim();
      if (!found.startsWith(POST.title)) {
        throw new Error(
          `searching "${POST.query}" gave "${found}", not "${POST.title}" — ` +
            `has js/demo/seed.json changed?`,
        );
      }
      await link.click();
      await page.waitForURL(/#\/posts\/\d+$/);
      const id = (page.url().match(/#\/posts\/(\d+)/) || [])[1];

      // Then arrive at it the way a reader does. The back link names where you
      // came from, so a post opened out of a search says "Back to the results"
      // — which would make this a screenshot of how the generator found the
      // post rather than of the app.
      await page.goto(`${origin}/?demo=1#/`);
      await page.waitForSelector(CARD);
      await page.goto(`${origin}/?demo=1#/posts/${id}`);
      await page.waitForSelector(".detail__content");
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
  {
    name: "colophon",
    fold: true,
    open: async (page, origin) => {
      await page.goto(`${origin}/?demo=1#/colophon`);
      await page.waitForSelector(".colophon__title");
    },
  },
];

const FORM_FACTORS = [
  { form: "wide", viewport: WIDE },
  { form: "narrow", viewport: NARROW },
];

/**
 * @param {import("../frontend/node_modules/playwright/index.mjs").Browser} browser
 */
async function capture(browser, origin, screen, { form, viewport }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  await page.addInitScript((fold) => {
    try {
      localStorage.setItem("commons.theme", "dark");
      if (fold) sessionStorage.setItem("commons.demo.strip-folded", "1");
    } catch (e) {
      /* storage off — the capture is still correct, just not pre-set */
    }
  }, !!screen.fold);

  await screen.open(page, origin);
  await page.addStyleTag({ content: SETTLE });
  // A shot taken before the reading face has loaded is a shot of the fallback
  // serif, which is not the app.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const file = path.join(shotDir, `${screen.name}-${form}.png`);
  await page.screenshot({ path: file });
  await ctx.close();

  const { size } = await stat(file);
  console.log(
    `   ${path.basename(file)}  ${viewport.width * DPR}x${viewport.height * DPR}  ` +
      `${Math.round(size / 1024)}kB`,
  );
}

// ── run ────────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
await mkdir(iconDir, { recursive: true });
await mkdir(shotDir, { recursive: true });

console.log("icons:");
for (const { file, size, purpose, transparent } of ICONS) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(iconHtml(size, purpose, transparent));
  const buffer = await page
    .locator(".plate")
    .screenshot({ omitBackground: true });
  await writeFile(path.join(iconDir, file), buffer);
  await page.close();
  console.log(`   ${file}  ${size}x${size}  ${purpose}`);
}

console.log("shortcut icons:");
for (const { file, glyph: name } of SHORTCUTS) {
  const page = await browser.newPage({
    viewport: { width: SHORTCUT_SIZE, height: SHORTCUT_SIZE },
    deviceScaleFactor: 1,
  });
  await page.setContent(shortcutHtml(SHORTCUT_SIZE, name));
  const buffer = await page
    .locator(".plate")
    .screenshot({ omitBackground: true });
  await writeFile(path.join(iconDir, file), buffer);
  await page.close();
  console.log(`   ${file}  ${SHORTCUT_SIZE}x${SHORTCUT_SIZE}  i-${name}`);
}

const og = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await og.setContent(await ogHtml());
await og.waitForTimeout(300); // let the embedded font settle before the shot
await writeFile(
  path.join(assets, "og.png"),
  await og.locator(".card").screenshot(),
);
await og.close();
console.log("og.png  1200x630");

console.log("screenshots:");
const server = process.env.APP_URL ? null : await serve(app);
const origin = process.env.APP_URL || (server && server.origin);
try {
  for (const screen of SCREENS) {
    for (const factor of FORM_FACTORS) {
      await capture(browser, origin, screen, factor);
    }
  }
} finally {
  await browser.close();
  if (server) await server.close();
}
