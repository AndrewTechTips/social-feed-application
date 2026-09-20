// Films the PWA story for the README: the app offering to install, the network
// going, and the reading carrying on without it.
//
//   node docs/capture-pwa.mjs && python docs/make_gif.py --frames .frames-pwa --out pwa.gif
//
// Frames land in docs/media/.frames-pwa/, which is scratch and gitignored;
// docs/media/pwa.gif beside it is committed.
//
// One command, nothing to start first — it serves frontend/ itself on an
// ephemeral port (docs/serve.mjs) and drives the demo build, so there is no
// database and no backend anywhere in this.
//
// ── the beat that is missing, and why ──────────────────────────────────────
// The plan this came from wanted a fourth shot: the app running in its own
// frameless window. It is not here, and it cannot be: `page.screenshot()`
// captures the page viewport and nothing else, so a tab and an installed
// window produce identical pixels. The only visible difference between them is
// the browser chrome *around* the page, which is the operating system's and
// which Playwright cannot see. Filming that would mean screen-recording a real
// window, which is a different tool and a permission prompt.
//
// So this films what is genuinely different and genuinely ours: the offer, the
// notice, and the reading that survives the connection.
//
// ── one thing here is triggered rather than waited for ─────────────────────
// `beforeinstallprompt` is dispatched below instead of being waited for.
// Chrome suppresses the install promotion under automation — see
// docs/adr/0010 and the note at the top of frontend/tests/install.spec.js,
// where the same thing is done for the same reason. What is on screen is the
// app's own control in the state a real Chrome visitor is shown; what is faked
// is only the browser's decision to offer it.

import { chromium } from "../frontend/node_modules/playwright/index.mjs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, "..", "frontend");
const FRAMES = path.join(HERE, "media", ".frames-pwa");

// The same shape as the tour, so the two GIFs sit at one width in the README.
const VIEWPORT = { width: 900, height: 620 };

const CARD = ".card:not(.card--skeleton)";

/** Chrome's event, as tests/install.spec.js makes it. */
const FIRE_INSTALL = `(() => {
  const ev = new Event("beforeinstallprompt", { cancelable: true });
  ev.prompt = () => Promise.resolve();
  ev.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" });
  window.dispatchEvent(ev);
})()`;

const server = process.env.APP_URL ? null : await serve(APP_DIR);
const APP = process.env.APP_URL || (server && server.origin);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("commons.theme", "dark");
  } catch (e) {}
});

await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });

let n = 0;
const frame = async (times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.screenshot({
      path: path.join(FRAMES, String(n++).padStart(3, "0") + ".png"),
    });
  }
};
/** Film for `ms`, one frame every `every`. */
const beat = async (ms, every = 90) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.waitForTimeout(every);
    await frame();
  }
};

// — 1. the feed, and the offer in the masthead ---------------------------------
await page.goto(`${APP}/?demo=1#/`);
await page.waitForSelector(CARD);
await page.addStyleTag({ content: `* { caret-color: transparent !important; }` });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await frame(6);

await page.evaluate(FIRE_INSTALL);
await page.waitForSelector(".masthead__install button");
await beat(900);
await frame(6); // hold on "It installs, too — it works on a plane."

// — 2. the same offer in the palette -------------------------------------------
await page.keyboard.press("Control+k");
await page.waitForSelector(".palette");
await frame(3);
await page.locator(".palette__input").type("install", { delay: 70 });
await frame(2);
await beat(500);
await frame(6); // hold on the row
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await frame(3);

// — 3. the network goes ---------------------------------------------------------
await ctx.setOffline(true);
await page.waitForSelector(".netband:not([hidden])");
await beat(900);
await frame(8); // hold on "Offline — what's already here still reads."

// — 4. and the reading carries on ----------------------------------------------
// Still offline. Every file comes from the service worker's cache and every
// answer from the demo adapter, which was itself served out of that cache.
await page.locator(`${CARD} .card__link`).first().click();
await page.waitForSelector(".detail__content");
await beat(1100);
// The strongest frame in the whole sequence: a post, set for reading, with the
// offline notice still above it. Held here rather than scrolled past — the
// band is in normal flow, so any real amount of scrolling takes the claim off
// the screen just as the shot is making it.
await frame(10);

for (let i = 0; i < 2; i++) {
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(90);
  await frame();
}
await frame(8); // and it loops back to the feed from here

await ctx.setOffline(false);
console.log(`   ${n} frames in ${path.relative(path.join(HERE, ".."), FRAMES)}`);

await ctx.close();
await browser.close();
if (server) await server.close();
