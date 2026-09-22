// The scroll indicator — the amber hairline on the header's bottom edge — and
// the absence it replaces.
//
// Two halves of one decision, which is why they are in one file. The native
// scrollbar is hidden on every scroller in the app, and this bar is what is
// there instead. Either one alone is a bug: a hidden scrollbar with no bar is
// a page with no way to see where you are in it, and a bar with a scrollbar
// beside it is the thing that was asked to go away.
//
// Both are pure CSS. Nothing here is driven by JavaScript, there is no scroll
// listener anywhere in the app, and that is the point — so the only way to
// know any of it still works is to measure it.

const { test, expect, CARD, settled } = require("./support/fixtures");

const BAR = ".progress";

const scrollDriven = (page) =>
  page.evaluate(() => CSS.supports("animation-timeline", "scroll()"));

/**
 * The bar is scaled with a transform, so its *painted* width is what matters —
 * which is what a bounding rect measures.
 */
const barWidth = (page) =>
  page.locator(BAR).evaluate((el) => el.getBoundingClientRect().width);

/** Scroll to a fraction of the page and let the timeline catch up. */
async function scrollTo(page, fraction) {
  await page.evaluate((f) => {
    const de = document.documentElement;
    window.scrollTo(0, Math.round((de.scrollHeight - de.clientHeight) * f));
  }, fraction);
}

const longFeed = async (page, api) => {
  await api.seed(12, "ada@commons.test");
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await settled(page);
};

// ── it is everywhere now, not only on a post ────────────────────────────────

test("every screen that scrolls gets a bar, not just a post", async ({ page, api }) => {
  test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");
  await api.seed(12, "ada@commons.test");

  // The feed and the colophon are the two this was never drawn on: one is a
  // list that grows, the other is a long static page. Neither is a post, and a
  // reader is just as lost in the middle of either.
  for (const [where, ready] of [
    ["/#/", CARD],
    ["/#/colophon", "h1"],
  ]) {
    await page.goto(where);
    await expect(page.locator(ready).first()).toBeVisible();
    await settled(page);

    await expect(page.locator(BAR), where).toHaveCSS("display", "block");
    // Put explicitly at the top first. The app restores where you were on
    // some navigations, and a bar that is still half full because the last
    // screen was is the bar working rather than failing — but it is not the
    // state this line is about.
    await scrollTo(page, 0);
    await expect
      .poll(() => barWidth(page), { message: `${where}: empty at the top` })
      .toBeLessThan(4);

    // Half way down, and asserted loosely on purpose: the feed appends as you
    // approach the end of it, so the page is longer by the time this reads the
    // bar and the exact fraction is not a number any test can pin. The claim
    // here is only that the bar is live on a screen that never had one. How
    // accurate it is gets measured on the colophon below, which holds still.
    await scrollTo(page, 0.5);
    const full = await page.evaluate(() => innerWidth);
    await expect
      .poll(() => barWidth(page), { message: `${where}: filling as you go` })
      .toBeGreaterThan(full * 0.15);
  }
});

test("it is exactly as far along as the page is", async ({ page, api }) => {
  test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");
  // The colophon rather than the feed: the feed appends as you approach the
  // end of it, so the page is a different length by the time the assertion
  // reads it. Nothing wrong with the bar — it is telling the truth about a
  // page that grew — but it is not a number a test can pin.
  await page.goto("/#/colophon");
  await expect(page.locator("h1")).toBeVisible();
  await settled(page);

  const full = await page.evaluate(() => innerWidth);
  for (const f of [0.25, 0.5, 0.75]) {
    await scrollTo(page, f);
    // Within two percent of the page's own progress. This is the whole claim
    // the bar makes, and a scroll-driven timeline makes it by construction —
    // which is exactly the kind of thing that stays true until somebody puts
    // an `overflow` on a wrapper and the timeline starts measuring that.
    await expect
      .poll(() => barWidth(page), { message: `${f * 100}% of the way down` })
      .toBeGreaterThan(full * (f - 0.02));
    expect(await barWidth(page)).toBeLessThan(full * (f + 0.02));
  }
});

test("a page that fits draws nothing, and is not asked to", async ({ page, api }) => {
  test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");
  await longFeed(page, api);
  await scrollTo(page, 0.5);
  // Polled, not read once: the timeline updates on the frame after the scroll,
  // and a bare read here returns the width the bar had before it moved.
  await expect.poll(() => barWidth(page)).toBeGreaterThan(0);

  // Emptying the view rather than finding a short screen, because there isn't
  // one: `body` is `min-height: 100dvh` with 96px of padding under `#view`, so
  // every route in this app is a little taller than the window whatever the
  // window is.
  await page.evaluate(() => document.querySelector("#view").replaceChildren());

  // No `:has()`, no class, no measuring, and nothing in JavaScript deciding
  // this. A scroll progress timeline whose scroller has no scrollable overflow
  // is *inactive*, and an animation with an inactive timeline holds its base
  // style — which here is scaleX(0). The bar puts itself away.
  await expect.poll(() => barWidth(page)).toBe(0);
  await expect(page.locator(BAR)).toHaveCSS("display", "block");
});

test("it lies on the header's bottom edge, wherever that is", async ({ page, api }) => {
  test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");
  await longFeed(page, api);

  const { barTop, headerBottom } = await page.evaluate(() => ({
    barTop: document.querySelector(".progress").getBoundingClientRect().top,
    headerBottom: document.querySelector(".site-header").getBoundingClientRect().bottom,
  }));
  // Sitting *on* the 1px border rather than under it — measured, not assumed
  // from --header-h, because a notch moves the header and this must follow it.
  expect(Math.abs(barTop - (headerBottom - 1))).toBeLessThanOrEqual(1.5);
});

test("it is drawn, never spoken", async ({ page, api }) => {
  await longFeed(page, api);
  await expect(page.locator(BAR)).toHaveAttribute("aria-hidden", "true");
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("keeps telling the truth instead of snapping to full", async ({ page, api }) => {
    test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");
    await longFeed(page, api);

    // base.css collapses every animation-duration to 0.01ms under reduced
    // motion. With a progress-based timeline that would fill the bar at the
    // first pixel of scroll — a lie, and the one failure mode this exemption
    // exists to prevent.
    expect(
      await page.locator(BAR).evaluate((el) => getComputedStyle(el).animationDuration)
    ).toBe("auto");
    await expect.poll(() => barWidth(page)).toBeLessThan(4);
  });
});

// ── and the scrollbar it replaced ───────────────────────────────────────────

test("no scroller in the app draws a scrollbar", async ({ page, api }) => {
  test.skip(!(await scrollDriven(page)), "the fallback keeps its scrollbar, by design");
  await longFeed(page, api);
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette__list")).toBeVisible();

  // The page, and the two panels that scroll inside it. `scrollbar-width` is
  // the standard property every current engine answers to; the WebKit
  // pseudo-element is the same instruction in the older dialect and cannot be
  // read back from script, so it is covered by the width check below instead.
  const widths = await page.evaluate(() =>
    [
      document.documentElement,
      document.querySelector(".palette__list"),
      document.querySelector(".palette__input"),
    ]
      .filter(Boolean)
      .map((el) => getComputedStyle(el).scrollbarWidth)
  );
  expect(
    widths.every((w) => w === "none"),
    widths.join(", ")
  ).toBe(true);
});

test("hiding it takes no width, so nothing can shift", async ({ page, api }) => {
  test.skip(!(await scrollDriven(page)), "the fallback keeps its scrollbar, by design");
  await longFeed(page, api);

  const wide = await page.evaluate(() => {
    const de = document.documentElement;
    const view = document.querySelector("#view").getBoundingClientRect();
    return {
      gutter: window.innerWidth - de.clientWidth,
      left: Math.round(view.left),
      right: Math.round(window.innerWidth - view.right),
      width: Math.round(view.width),
    };
  });

  // Nothing between the window and the page.
  expect(wide.gutter).toBe(0);
  // And the page is centred in the window rather than beside a reserved strip.
  // `scrollbar-gutter: stable` used to hold eleven pixels open here so the
  // layout would not jump between a tall screen and a short one — but the
  // reserved strip is part of the scroller's box, so everything centred inside
  // it was drawn a few pixels left of the middle of the window. `overflow-y:
  // scroll` was already making the same promise without that cost.
  expect(wide.left).toBe(wide.right);

  // The promise the gutter was bought for, kept without it: go to a screen of
  // a completely different height and the column has not moved.
  await page.goto("/#/login");
  await expect(page.locator("#email")).toBeVisible();
  await settled(page);
  const short = await page.evaluate(() => {
    const view = document.querySelector("#view").getBoundingClientRect();
    return { left: Math.round(view.left), width: Math.round(view.width) };
  });
  expect(short).toEqual({ left: wide.left, width: wide.width });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 720 }, isMobile: true, hasTouch: true });

  test("the same bar, the same absence, and no sideways scroll", async ({
    page,
    api,
  }) => {
    test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");
    // The colophon rather than the feed, for the reason given above: a list
    // that grows as you reach the end of it can never be scrolled to 100%.
    await page.goto("/#/colophon");
    await expect(page.locator("h1")).toBeVisible();
    await settled(page);

    // The header is two rows at this width, and the bar is pinned to whatever
    // the bottom of it turns out to be rather than to a token.
    const { barTop, headerBottom, overflow, gutter } = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        barTop: document.querySelector(".progress").getBoundingClientRect().top,
        headerBottom: document.querySelector(".site-header").getBoundingClientRect()
          .bottom,
        overflow: de.scrollWidth - de.clientWidth,
        gutter: window.innerWidth - de.clientWidth,
      };
    });
    expect(Math.abs(barTop - (headerBottom - 1))).toBeLessThanOrEqual(1.5);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(gutter).toBe(0);

    await scrollTo(page, 1);
    const full = await page.evaluate(() => innerWidth);
    await expect.poll(() => barWidth(page)).toBeGreaterThan(full * 0.95);
  });
});
