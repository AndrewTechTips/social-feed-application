// The page's scrollbar (js/scrollbar.js) — the one this app draws for itself.
//
// The native bar is gone: hidden on `html` in base.css, which also gave back
// the eleven pixels of gutter that used to be reserved on every screen to stop
// the layout sliding sideways. Both halves of that are worth pinning down,
// because both are invisible to every other spec in this directory and both
// fail quietly — a returned gutter is a column that jumps, and a rail that
// stopped being drawn is a page with no way to see where you are in it.
//
// What is deliberately *not* asserted here is how it looks. The thumb's colour
// and its fade belong to tests/visual.spec.js, which has a picture of them.
// This file is about the arithmetic and the behaviour: is it the right size,
// does it point at the right place, does dragging it move the page, and does
// it keep clear of the column.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const RAIL = ".scrollbar";

/**
 * A feed with enough in it to be taller than any viewport here.
 *
 * `settled` is not politeness. The route cross-fade puts an opacity on the
 * whole screen while it runs, and anything measured through it — a colour, and
 * therefore axe's contrast ratio — is measured through a veil: the card meta
 * reads 4.36:1 at opacity 0.56 and 5.0:1 a frame later. Every number in this
 * file is taken after the page has stopped moving.
 */
async function longPage(page, api) {
  await api.seed(12, "ada@commons.test");
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await settled(page);
  // The rail sizes itself from a ResizeObserver, so it can be a frame behind
  // the cards arriving. Waiting on the class is waiting on that frame.
  await expect(page.locator(RAIL)).toHaveClass(/is-live/);
}

/**
 * The feed grows as you approach the end of it, which is right for a feed and
 * useless for measuring a scrollbar: the page is a different height by the
 * time the assertion reads it. The colophon is the longest screen in the app
 * that is simply *there* — no pagination, no fetch, no auth.
 */
async function longStaticPage(page) {
  await page.goto("/#/colophon");
  await expect(page.locator("h1")).toBeVisible();
  await settled(page);
  await expect(page.locator(RAIL)).toHaveClass(/is-live/);
}

const geometry = (page) =>
  page.evaluate(() => {
    const de = document.documentElement;
    const rail = document.querySelector(".scrollbar");
    const thumb = document.querySelector(".scrollbar__thumb");
    return {
      innerW: window.innerWidth,
      clientW: de.clientWidth,
      view: document.querySelector("#view").getBoundingClientRect().toJSON(),
      scrollH: de.scrollHeight,
      clientH: de.clientHeight,
      y: window.scrollY,
      rail: rail.getBoundingClientRect().toJSON(),
      thumb: thumb.getBoundingClientRect().toJSON(),
      live: rail.classList.contains("is-live"),
    };
  });

// ── the native one is gone ──────────────────────────────────────────────────

test("the page is centred in the window, not beside a reserved strip", async ({
  page,
  api,
}) => {
  await longPage(page, api);
  const { view, innerW, scrollH, clientH } = await geometry(page);

  // `scrollbar-gutter: stable` used to hold eleven pixels open down the right
  // of the page so the layout would not jump when a short screen followed a
  // tall one. It worked, and it cost something nobody had written down: the
  // reserved strip is part of the scroller's box, so everything centred inside
  // it was centred against 1269 pixels and drawn 5.5 short of the middle of a
  // 1280 window. The whole app sat very slightly to the left.
  //
  // Measured rather than asserted against `scrollbar-gutter` itself, because
  // the property is the mechanism and this is the consequence — and because
  // the gap is invisible to `clientWidth`, which reads the same either way
  // under a browser with overlay scrollbars. A test on the width alone passes
  // whether this was fixed or not; this one does not.
  expect(Math.round(view.left)).toBe(Math.round(innerW - view.right));

  // And the page genuinely does scroll, or the assertion above is passing for
  // the wrong reason.
  expect(scrollH).toBeGreaterThan(clientH);
});

test("the column is the same width on a tall screen and a short one", async ({
  page,
  api,
}) => {
  // The bug the reserved gutter was buying off, asserted from the outside: go
  // from a long feed to a screen that fits and back, and measure the column
  // each time. With a native scrollbar and no reservation these differ by the
  // scrollbar's width and every line of every card re-wraps.
  await longPage(page, api);
  const wide = await page.locator("#view").evaluate((el) => el.clientWidth);

  await page.goto("/#/login");
  await expect(page.locator("#email")).toBeVisible();
  const short = await page.locator("#view").evaluate((el) => el.clientWidth);

  expect(short).toBe(wide);
});

// ── the rail itself ─────────────────────────────────────────────────────────

test("it is drawn for the eye only, and never for the keyboard", async ({
  page,
  api,
}) => {
  await longPage(page, api);
  const rail = page.locator(RAIL);
  await expect(rail).toHaveAttribute("aria-hidden", "true");
  // It duplicates what the arrow keys already do. A tab stop that repeats a
  // key is a tab stop in the way.
  expect(await rail.evaluate((el) => el.querySelectorAll("[tabindex]").length)).toBe(0);
});

test("a page that stops overflowing loses its thumb", async ({ page, api }) => {
  await longPage(page, api);
  await expect(page.locator(RAIL)).toHaveClass(/is-live/);

  // Emptying the view rather than navigating to a short screen, and not for
  // convenience: there isn't a short screen. `body` is `min-height: 100dvh`
  // and `#view` carries 96px of bottom padding under it, so every route in
  // this app is a little taller than the window whatever the window is — the
  // sign-in form overruns a 2400px viewport by 57px. Taking the content out
  // is the only way to reach the state from a real page.
  //
  // It also exercises the path that matters. Nothing calls the scrollbar when
  // a view swaps; it finds out from a ResizeObserver on the body, and this is
  // the assertion that the observer is wired up at all.
  await page.evaluate(() => {
    document.querySelector("#view").replaceChildren();
  });

  // A control that cannot do anything should not be on the screen — the same
  // rule the install block and the data panel's sweep are built on.
  await expect(page.locator(RAIL)).not.toHaveClass(/is-live/);
  const { scrollH, clientH } = await geometry(page);
  expect(scrollH).toBeLessThanOrEqual(clientH + 1);
});

test("the thumb is as tall as the screen is of the page", async ({ page }) => {
  await longStaticPage(page);
  const g = await geometry(page);

  // The one thing a scrollbar says without being touched: how much of this is
  // on screen. Within a pixel of the ratio, and never below the 40px floor
  // that keeps it a handle rather than a dot.
  const want = (g.rail.height * g.clientH) / g.scrollH;
  expect(g.thumb.height).toBeGreaterThanOrEqual(40);
  if (want > 40) expect(Math.abs(g.thumb.height - want)).toBeLessThanOrEqual(1.5);
});

test("the thumb starts at the top and ends at the bottom", async ({ page }) => {
  await longStaticPage(page);

  const top = await geometry(page);
  expect(Math.round(top.thumb.top - top.rail.top)).toBe(0);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect
    .poll(async () => Math.round((await geometry(page)).thumb.bottom))
    .toBe(Math.round(top.rail.bottom));
});

test("it keeps clear of the column instead of hugging it", async ({ page, api }) => {
  // The complaint this replaced: the native bar sat a hair from the right-hand
  // edge of the text. Checked at both widths, because the phone is where the
  // side gutter is smallest and where an overlap actually happened.
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await longPage(page, api);
    const g = await geometry(page);
    const card = await page
      .locator(CARD)
      .first()
      .evaluate((el) => el.getBoundingClientRect().right);

    expect(g.thumb.left, `${width}px: thumb over the card`).toBeGreaterThan(card);
    expect(g.thumb.right, `${width}px: thumb off the screen`).toBeLessThanOrEqual(
      width
    );
  }
});

// ── it is a scrollbar, not a progress bar ───────────────────────────────────

test("dragging the thumb scrolls the page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await longStaticPage(page);

  const g = await geometry(page);
  const from = { x: g.thumb.left + g.thumb.width / 2, y: g.thumb.top + 8 };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 200, { steps: 10 });
  await page.mouse.up();

  const after = await geometry(page);
  expect(after.y).toBeGreaterThan(0);

  // Not just "it moved": the page should have travelled the same fraction of
  // its own height that the thumb travelled of the rail. That is the whole
  // difference between a scrollbar and a decoration that happens to be
  // draggable.
  const travel = g.rail.height - g.thumb.height;
  const want = (200 / travel) * (g.scrollH - g.clientH);
  expect(Math.abs(after.y - want)).toBeLessThan(24);
});

test("pressing the rail moves a screen at a time", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await longStaticPage(page);
  const g = await geometry(page);

  // Below the thumb, which on a page this long is most of the rail.
  await page.mouse.click(g.rail.left + g.rail.width / 2, g.rail.bottom - 20);
  await expect.poll(async () => (await geometry(page)).y).toBeGreaterThan(200);

  const down = (await geometry(page)).y;
  await page.mouse.click(g.rail.left + g.rail.width / 2, g.rail.top + 4);
  await expect.poll(async () => (await geometry(page)).y).toBeLessThan(down);
});

test.describe("on a touch screen", () => {
  // `isMobile`/`hasTouch` rather than a narrow viewport alone: the rule that
  // makes the rail inert is `(hover: hover) and (pointer: fine)`, and a
  // 375px-wide *desktop* Chrome still matches both of those. Without touch
  // emulation this test passes on the wrong evidence.
  test.use({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });

  test("a finger never lands on it", async ({ page, api }) => {
    await longPage(page, api);

    // 6px is not a target to hand a thumb, and a phone scrolls by dragging the
    // page rather than by dragging a bar. The rail is there to be read on a
    // touch screen and not to be pressed, so it must not be able to swallow a
    // tap meant for whatever is behind it.
    const reachable = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector(".scrollbar")).pointerEvents !== "none"
    );
    expect(reachable).toBe(false);
  });
});

// ── what was left alone ─────────────────────────────────────────────────────

test("the panels that scroll inside the page keep their own scrollbars", async ({
  page,
  api,
}) => {
  await longPage(page, api);
  await page.keyboard.press("Control+k");
  const list = page.locator(".palette__list");
  await expect(list).toBeVisible();

  // Hiding the native scrollbar was scoped to `html` on purpose. The palette
  // and the account menu are small panels where the bar is the only clue there
  // is more below, and a bare `::-webkit-scrollbar { width: 0 }` would have
  // taken theirs with it.
  const width = await list.evaluate((el) => getComputedStyle(el).scrollbarWidth);
  expect(width).not.toBe("none");
});

test("axe is clean with the rail on the page", async ({ page, api }) => {
  await longPage(page, api);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
