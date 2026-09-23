// Regenerates the screenshots and the GIF frames in docs/media/.
//
// These are real captures of the running app, not mockups — which means they
// need the app running. See docs/README-capture.md for the three commands.
//
//   node docs/capture.mjs
//
// Frames for the GIF land in docs/media/.frames/; docs/make_gif.py turns them
// into docs/media/tour.gif.

import { chromium } from "../frontend/node_modules/playwright/index.mjs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.join(HERE, "media");
const FRAMES = path.join(MEDIA, ".frames");
const APP = process.env.APP_URL || "http://localhost:5173";

// Narrower than a real desktop window on purpose. The app centres a 640px
// reading column inside a 1200px frame, so a true 1440px capture is mostly
// background — fine in use, poor as a README thumbnail. 1100px keeps the
// desktop layout (the header stays on one row) without the dead margins.
const DESKTOP = { width: 1100, height: 820 };
const READING = { width: 1100, height: 720 };
const PHONE = { width: 390, height: 844 };

// Everything here is deterministic on purpose: no animation mid-capture, no
// caret blinking into a screenshot, no half-finished entrance transition.
const SETTLE = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
  }
  .aurora-bloom { animation: none !important; }
  * { caret-color: transparent !important; }

  /* Except the scroll progress line, which is not that kind of animation.
     .progress is driven by animation-timeline: scroll(root block) — its
     "duration" is the document, not a clock — so collapsing it to 0s does not
     freeze it, it snaps it to its end state. Measured, at the top of the feed
     and at the bottom: without this exception scaleX reads 1 at both, against
     a true 0 and 0.846.

     The committed stills never showed it, because they were taken before the
     line existed. This is a trap laid for whoever regenerated them next — a
     progress bar reading 100% on a page nobody had scrolled, in every still,
     and a full amber bar across the whole length of the tour.

     chrome.css already makes exactly this exception, for exactly this reason,
     under prefers-reduced-motion. This is the same exception for the same
     cause: nothing here moves unless the page is scrolled, so there is no
     motion to settle. */
  @supports (animation-timeline: scroll()) {
    .progress { animation-duration: auto !important; }
  }
`;

async function page(browser, viewport, { theme = "dark" } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.addInitScript((t) => {
    try {
      localStorage.setItem("commons.theme", t);
    } catch (e) {}
  }, theme);
  return p;
}

async function ready(p) {
  await p.waitForSelector(".card", { timeout: 15000 });
  await p.addStyleTag({ content: SETTLE });
  await p.waitForTimeout(350);
}

async function shot(p, name) {
  const file = path.join(MEDIA, `${name}.png`);
  await p.screenshot({ path: file });
  console.log("  ", path.relative(HERE, file));
}

async function signIn(p, email = "maren.holt@example.com", pw = "commons-demo-pw") {
  await p.goto(`${APP}/#/login`);
  await p.getByLabel("Email").fill(email);
  await p.getByLabel("Password", { exact: true }).fill(pw);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/#\/$/);
}

const browser = await chromium.launch();
await mkdir(MEDIA, { recursive: true });

// — stills ------------------------------------------------------------------
console.log("stills:");
{
  const p = await page(browser, DESKTOP);
  await p.goto(`${APP}/#/`);
  await ready(p);
  await shot(p, "feed-dark");
  await p.context().close();
}
{
  const p = await page(browser, READING);
  await p.goto(`${APP}/#/`);
  await ready(p);
  // Cards below the fold carry content-visibility:auto, so their contents
  // aren't rendered — and aren't clickable — until they're scrolled in.
  const target = p.getByRole("heading", { name: "The library that stays open all night" });
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await p.waitForURL(/#\/posts\/\d+$/);
  await p.waitForSelector(".detail__content");
  await p.addStyleTag({ content: SETTLE });
  await p.waitForTimeout(300);
  await shot(p, "post-dark");
  await p.context().close();
}
{
  const p = await page(browser, DESKTOP, { theme: "light" });
  await p.goto(`${APP}/#/`);
  await ready(p);
  await shot(p, "feed-light");
  await p.context().close();
}
{
  const p = await page(browser, READING);
  await signIn(p);
  await p.goto(`${APP}/#/compose`);
  await p.getByLabel("Title", { exact: true }).fill("What I look for in a bench");
  await p.getByLabel("Body").fill(
    "Back support, obviously. But the thing I've come to care about more is " +
      "whether it faces something worth facing.\n\nA bench pointed at a car park " +
      "is a place to wait. A bench pointed at water is a place to sit."
  );
  await p.addStyleTag({ content: SETTLE });
  await p.waitForTimeout(250);
  await shot(p, "compose-dark");
  await p.context().close();
}
{
  const p = await page(browser, PHONE);
  await p.goto(`${APP}/#/`);
  await ready(p);
  await shot(p, "feed-mobile");
  await p.context().close();
}
{
  // The settings screen, which is three parts signed in and has no still of
  // its own until now. Framed on *This browser* rather than on the top of the
  // page: the account half is a name, an email and two dangerous buttons, and
  // the half worth showing is the one that is unusual — the theme as three
  // choices, the reading controls with a line of type set the way a post will
  // be, and the list of everything Commons keeps on your machine.
  const p = await page(browser, READING);
  await signIn(p);
  await p.goto(`${APP}/#/settings`);
  await p.waitForSelector(".settings__group");
  // Signing in raises a "Signed in." toast, and it outlives the navigation —
  // the first version of this shot had it sitting across the theme control.
  // Wait it out rather than hiding it: a toast hidden by a capture-only style
  // is a toast that could be covering something else next time.
  await p.locator(".toast").first().waitFor({ state: "detached", timeout: 15000 })
    .catch(() => {});
  await p.addStyleTag({ content: SETTLE });
  await p.evaluate(() => document.fonts.ready);
  // Put *This browser* just under the header rather than merely on screen.
  // scrollIntoViewIfNeeded stops as soon as the element is visible, which left
  // the frame led by the red Delete-your-account button from the part above —
  // a true picture of the screen and a poor picture of what is interesting
  // about it.
  await p.evaluate(() => {
    const head = [...document.querySelectorAll(".settings__group-head")].find((h) =>
      h.textContent.includes("This browser")
    );
    if (!head) throw new Error("no 'This browser' heading — did the parts rename?");
    const header = document.querySelector(".site-header");
    const offset = (header ? header.getBoundingClientRect().height : 0) + 24;
    scrollTo({ top: head.getBoundingClientRect().top + scrollY - offset });
  });
  await p.waitForTimeout(500);
  await shot(p, "settings-dark");
  await p.context().close();
}

// — GIF frames ---------------------------------------------------------------
// Smaller viewport and no deviceScaleFactor: this becomes an ~800px GIF and
// every frame is bytes in the README.
console.log("gif frames:");
await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });

const ctx = await browser.newContext({
  viewport: { width: 900, height: 620 },
  deviceScaleFactor: 1,
});
const p = await ctx.newPage();
await p.addInitScript(() => {
  try {
    localStorage.setItem("commons.theme", "dark");
  } catch (e) {}
});

let n = 0;
const frame = async (times = 1) => {
  for (let i = 0; i < times; i++) {
    await p.screenshot({
      path: path.join(FRAMES, String(n++).padStart(3, "0") + ".png"),
    });
  }
};
const beat = async (ms, every = 90) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await p.waitForTimeout(every);
    await frame();
  }
};

await p.goto(`${APP}/#/`);
await p.waitForSelector(".card");
await p.addStyleTag({ content: `* { caret-color: transparent !important; }` });
await p.waitForTimeout(500);
await frame(6); // hold on the feed

// Scroll down the feed. More steps and smaller ones than this used to take,
// because the amber line under the header is now filming truthfully (see
// SETTLE) and it is worth letting it travel far enough to read as a measure of
// the page rather than as a flicker.
for (let i = 0; i < 14; i++) {
  await p.mouse.wheel(0, 130);
  await p.waitForTimeout(60);
  await frame();
}
await frame(4);

// open a post
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(250);
await p.getByRole("heading", { name: "Notes on repairing a kettle" }).click();
await p.waitForURL(/#\/posts\/\d+$/);
await beat(900);
await frame(4);

// sign in, then upvote it
await p.goto(`${APP}/#/login`);
await p.waitForSelector(".auth__card");
await frame(3);
await p.getByLabel("Email").type("maren.holt@example.com", { delay: 28 });
await frame(2);
await p.getByLabel("Password", { exact: true }).type("commons-demo-pw", { delay: 28 });
await frame(2);
await p.getByRole("button", { name: "Sign in" }).click();
await p.waitForURL(/#\/$/);
await beat(800);

await p.getByRole("heading", { name: "Notes on repairing a kettle" }).click();
await p.waitForURL(/#\/posts\/\d+$/);
await p.waitForSelector(".vote");
await frame(4);
await p.locator(".vote").click();
await beat(700, 60); // catch the vote pop
await frame(5);

// write something
await p.goto(`${APP}/#/compose`);
await p.waitForSelector(".compose__panel");
await frame(3);
await p.getByLabel("Title", { exact: true }).type("What I look for in a bench", { delay: 34 });
await frame(2);
await p.getByLabel("Body").type(
  "Back support, obviously. But the thing I've come to care about more is whether it faces something worth facing.",
  { delay: 14 }
);
await frame(3);
await p.getByRole("button", { name: "Post" }).click();
await p.waitForURL(/#\/posts\/\d+$/);
await beat(1100);
await frame(10); // hold on the result

// and what the account menu opens onto
await p.getByRole("button", { name: /^Your account/ }).click();
await p.waitForSelector(".accmenu__panel");
await beat(600, 70);
await p.getByRole("menuitem", { name: "Settings" }).click();
await p.waitForURL(/#\/settings$/);
await p.waitForSelector(".settings__group");
await beat(900);
// down through the three parts, slowly enough to read what they are
for (let i = 0; i < 12; i++) {
  await p.mouse.wheel(0, 140);
  await p.waitForTimeout(60);
  await frame();
}
await frame(8); // hold on the data panel

console.log(`   ${n} frames`);
await ctx.close();
await browser.close();
