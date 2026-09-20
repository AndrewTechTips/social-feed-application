// Visual regression — the screens, as pictures.
//
// The rest of this suite asserts behaviour: a class is on, a count is right, a
// route changed. None of it would notice a stylesheet that stopped loading, a
// token that resolved to `unset`, a column that collapsed at a breakpoint, or a
// card that lost its border. Those are the failures that are obvious to a
// person and invisible to every other spec in this directory — and the surface
// they can happen on got considerably larger the day this app grew two themes,
// three text sizes, two measures and a focus mode.
//
// ── what is deliberately *not* here ──────────────────────────────────────────
// This runs against **one project only**. The demo adapter and mock_api.py draw
// the same pixels from the same stylesheets, so a second set of identical
// screenshots would double the maintenance and catch nothing — the thing that
// differs between those two is data, which the rest of the suite covers.
//
// ── why these screens ────────────────────────────────────────────────────────
// One of each *kind* of layout rather than one of every route: a list, a
// reading column, a form, and the two chrome states. A route that reuses a
// layout already here (a profile is a feed, the shelf is a feed) adds a picture
// to approve and no coverage.
//
// ── keeping it from crying wolf ──────────────────────────────────────────────
// A flaky visual test is worse than none: it teaches people to run
// `--update-snapshots` without looking, which is the same as deleting the file.
// Four things are pinned so that it isn't:
//
//   * the data, seeded with fixed titles and vote counts;
//   * relative times, which say "just now" for a freshly seeded post and would
//     say "1m ago" a minute later — frozen by seeding immediately before;
//   * animation, disabled through the reduced-motion emulation, which this app
//     already honours everywhere;
//   * the aurora, which drifts on a keyframe loop and is the one thing on the
//     page that is *supposed* to never hold still. Hidden for the shot.
//
// `maxDiffPixelRatio` is small but not zero: font rasterisation differs by a
// hair between runs and a zero tolerance would mean these only ever pass on the
// machine that recorded them.
//
// ── and what happens in CI ───────────────────────────────────────────────────
// Playwright names a baseline after the platform that took it
// (`feed-dark-chromium-darwin.png`), because macOS and Linux do not rasterise
// type the same way — not by a hair, by whole pixels on every stem. A single
// shared baseline across the two is not a strict test, it is a broken one.
//
// So CI runs this file with `--ignore-snapshots`: every navigation, every
// control and every `page.evaluate` still executes, so a screen that throws or
// a selector that rots still turns the build red — only the pixel comparison is
// skipped, because CI has no baseline it could honestly compare against.
// The comparison is real on the machine where the design work happens, which is
// where a visual regression is introduced and where it can be looked at.
//
// Update them deliberately, never reflexively:  npm run test:visual:update

const { test, expect, CARD } = require("./support/fixtures");

// Only against the mock API. See the note above. As a beforeEach rather than a
// file-level `test.skip(fn)`, because the file-level form is handed the fixtures
// object and not a testInfo — the project name is only knowable once a test has
// started.
test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "the two API stand-ins draw identical pixels; a second copy of these would " +
      "double the pictures to approve and catch nothing"
  );
});

// Reduced motion is the app's own switch for "nothing moves", so this is not a
// test-only pathway — it is a state the app supports and a reader can be in.
test.use({ reducedMotion: "reduce" });

const SHOT = {
  maxDiffPixelRatio: 0.02,
  animations: "disabled",
  stylePath: require("path").join(__dirname, "support", "visual.css"),
};

/** Seed a small, fixed feed and land on it. */
async function feed(page, api) {
  await api.seed(1, "ada@commons.test", 0);
  await api.seed(1, "ada@commons.test", 4); // over WARM_AT, so a hairline shows
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
  // The masthead's type is the largest thing on this screen; waiting for the
  // face means the first shot isn't of the fallback serif.
  await page.evaluate(() => document.fonts.ready);
}

test("the feed, dark", async ({ page, api }) => {
  await feed(page, api);
  await expect(page).toHaveScreenshot("feed-dark.png", SHOT);
});

test("the feed, light", async ({ page, api }) => {
  await feed(page, api);
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await expect(page).toHaveScreenshot("feed-light.png", SHOT);
});

test("the feed on a phone", async ({ page, api }) => {
  // 390x844 is an iPhone 14. Below the 640px breakpoint, so this is the one
  // shot that covers the glass being dropped and the header becoming two rows.
  await page.setViewportSize({ width: 390, height: 844 });
  await feed(page, api);
  await expect(page).toHaveScreenshot("feed-mobile.png", SHOT);
});

test("a post", async ({ page, api }) => {
  await feed(page, api);
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("post.png", SHOT);
});

test("a post in focus mode, at the largest text", async ({ page, api }) => {
  // Three of the reading controls at once, because they compose: focus narrows
  // the measure, the size widens the line, and the interesting failure is the
  // two disagreeing.
  await feed(page, api);
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.textSize = "l";
    document.documentElement.dataset.focus = "on";
  });
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("post-focus-large.png", SHOT);
});

test("a post at the narrow measure", async ({ page, api }) => {
  await feed(page, api);
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail")).toBeVisible();
  await page.evaluate(() => (document.documentElement.dataset.measure = "narrow"));
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("post-narrow.png", SHOT);
});

test("the sign-in form", async ({ page }) => {
  await page.goto("/#/login");
  await expect(page.locator("#email")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("login.png", SHOT);
});

test("the screen that didn't load", async ({ page }) => {
  // The router's error boundary. It has no route of its own, so this is the
  // only way to see it — and a screen nothing can reach by accident is exactly
  // the kind that rots without a picture of it.
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.evaluate(() => {
    document.querySelector("#view").replaceChildren();
    location.hash = "#/__does-not-exist-and-throws";
  });
  // Nothing routes there, so the router sends them home — which is the *other*
  // half of the same code path and worth knowing still happens.
  await expect(page).toHaveURL(/#\/$/);
});
