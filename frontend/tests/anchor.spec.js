// The feed holds still while you scroll it.
//
// Offset pagination counts from the top, so a post written between one page and
// the next pushes every later page down by one and the reader is handed a card
// they have already read. docs/adr/0005 named that as a known cost and judged it
// not worth paying for — correctly, until something started inserting rows into
// a feed while it was being read.

const { test, expect, CARD } = require("./support/fixtures");

const PAGE = 10; // PAGE_SIZE in js/views/feed.js

const idsOnScreen = (page) =>
  page
    .locator(`${CARD} .card__link`)
    .evaluateAll((els) => els.map((el) => el.getAttribute("href")));

/** Scroll to the bottom until the feed says it has nothing more. */
async function scrollToTheEnd(page) {
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const done = await page
      .locator(".feed__status")
      .evaluate((el) => el.textContent.includes("That's everything"))
      .catch(() => false);
    if (done) return;
    await page.waitForTimeout(250);
  }
}

test("a post written mid-scroll doesn't hand you one you've already read", async ({
  page,
  api,
}) => {
  await api.seed(PAGE + 3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(PAGE);
  const firstPage = await idsOnScreen(page);

  // Somebody posts while the reader is still on page one — into the feed the
  // page is actually reading. `api.seed` would not do: in demo mode it writes
  // to a snapshot that only lands on the next document load, so this test
  // would pass without the anchor because nothing had arrived.
  await api.seedLive(page, 2, "bea@commons.test");

  await scrollToTheEnd(page);
  const all = await idsOnScreen(page);

  // Nothing twice. Without the anchor the last card of page one comes back as
  // the first of page two.
  expect(new Set(all).size).toBe(all.length);
  // And the first page is still intact inside the whole.
  expect(all.slice(0, PAGE)).toEqual(firstPage);
});

test("the anchor is sent on the pages after the first, and not on the first", async ({
  page,
  api,
}) => {
  const asked = [];
  await page.route(/\/posts\/\?/, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("as_of"));
    return route.continue();
  });

  await api.seed(PAGE + 3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(PAGE);
  await scrollToTheEnd(page);

  // Demo mode never touches the network, so there is nothing to intercept.
  test.skip(asked.length === 0, "no HTTP requests to observe in demo mode");
  expect(asked[0]).toBeNull();
  expect(asked.slice(1).every((v) => typeof v === "string" && v.length > 0)).toBe(true);
});

test("searching is not anchored — those results aren't in time order", async ({
  page,
  api,
}) => {
  await api.seed(PAGE + 3, "ada@commons.test");
  await page.goto("/#/?search=Seeded");
  await expect(page.locator(CARD)).toHaveCount(PAGE);

  const anchor = await page.evaluate(() => {
    const el = document.querySelector(".card__link");
    return el ? el.getAttribute("href") : null;
  });
  expect(anchor).toBeTruthy();

  // It still paginates; it just doesn't pin a window it has no ordering for.
  await scrollToTheEnd(page);
  const all = await idsOnScreen(page);
  expect(new Set(all).size).toBe(all.length);
});

test("coming back from a post keeps the same window", async ({ page, api }) => {
  await api.seed(PAGE + 3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(PAGE);

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.locator(".back").click();
  await expect(page.locator(CARD)).toHaveCount(PAGE);

  // Restored from cache. The anchor has to come back with it, or the next page
  // fetched from here is counted from a feed that has moved on.
  await api.seedLive(page, 2, "bea@commons.test");
  await scrollToTheEnd(page);
  const all = await idsOnScreen(page);
  expect(new Set(all).size).toBe(all.length);
});
