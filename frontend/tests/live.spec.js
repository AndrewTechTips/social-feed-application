// "Three new posts" — the feed noticing that something arrived while you were
// reading it.
//
// Polling, not a socket, and the reasoning is in the note beside POLL_MS in
// js/views/feed.js. What these check is the behaviour that reasoning has to
// produce: the count is right, pressing it puts the posts at the top, and —
// the part that took an ADR amendment to make possible — the pages below don't
// renumber themselves when it does.

const { test, expect, CARD } = require("./support/fixtures");

const PILL = ".feed__new";

/**
 * Ask the feed to poll now rather than in forty-five seconds.
 *
 * On `window`, which is where feed.js listens. The real event is fired at
 * `document` and reaches window by bubbling; a synthetic one does not bubble
 * unless it is told to, so dispatching it at the document quietly does nothing
 * and every test here passes for the wrong reason.
 */
const pollNow = (page) =>
  page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));

const idsOnScreen = (page) =>
  page
    .locator(`${CARD} .card__link`)
    .evaluateAll((els) => els.map((el) => el.getAttribute("href")));

test("nothing arrives, nothing is said", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  await pollNow(page);
  await page.waitForTimeout(400);
  await expect(page.locator(PILL)).toBeHidden();
});

test("a post written while you're reading is offered, not forced", async ({
  page,
  api,
}) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const before = await idsOnScreen(page);

  await api.seedLive(page, 2, "bea@commons.test");
  await pollNow(page);

  await expect(page.locator(PILL)).toBeVisible();
  await expect(page.locator(PILL)).toHaveText("Two new posts");
  // Offered. Nothing has moved under the reader until they say so.
  expect(await idsOnScreen(page)).toEqual(before);

  await page.locator(PILL).click();
  await expect(page.locator(CARD)).toHaveCount(5);
  await expect(page.locator(PILL)).toBeHidden();

  // At the top, above what was already there, in one piece.
  const after = await idsOnScreen(page);
  expect(after.slice(2)).toEqual(before);
});

test("one is singular", async ({ page, api }) => {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await api.seedLive(page, 1, "bea@commons.test");
  await pollNow(page);
  await expect(page.locator(PILL)).toHaveText("One new post");
});

test("taking them does not renumber the pages below", async ({ page, api }) => {
  // The whole reason ADR 0005 grew a third trigger. New rows go *above* the
  // paginated set; the window the pages are counted in stays where it was.
  await api.seed(13, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(10);

  await api.seedLive(page, 2, "bea@commons.test");
  await pollNow(page);
  await expect(page.locator(PILL)).toBeVisible();
  await page.locator(PILL).click();
  await expect(page.locator(CARD)).toHaveCount(12);

  // Now scroll on. Nothing may come back twice.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(250);
    const done = await page
      .locator(".feed__status")
      .evaluate((el) => el.textContent.includes("That's everything"))
      .catch(() => false);
    if (done) break;
  }
  const all = await idsOnScreen(page);
  expect(new Set(all).size).toBe(all.length);
  expect(all.length).toBe(15);
});

test("it is not offered on a ranking or on a search", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/#/?sort=warm");
  await expect(page.locator(CARD)).toHaveCount(3);
  await api.seedLive(page, 2, "bea@commons.test");
  await pollNow(page);
  await page.waitForTimeout(400);
  // A ranking is not in time order, so there is no anchor to ask "since" of —
  // and nothing to prepend it above.
  await expect(page.locator(PILL)).toBeHidden();

  await page.goto("/#/?search=Seeded");
  await expect(page.locator(CARD).first()).toBeVisible();
  await pollNow(page);
  await page.waitForTimeout(400);
  await expect(page.locator(PILL)).toBeHidden();
});

test("what it brought in is part of the list the post screen reads on from", async ({
  page,
  api,
}) => {
  await api.seed(2, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await api.seedLive(page, 1, "bea@commons.test");
  await pollNow(page);
  await page.locator(PILL).click();
  await expect(page.locator(CARD)).toHaveCount(3);

  // Open the one that just arrived: it is the first of the list now, so it has
  // a next and no previous.
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await expect(page.locator(".onward__item--prev")).toHaveCount(0);
  await expect(page.locator(".onward__item--next")).toBeVisible();
});

test("leaving the feed stops it asking", async ({ page, api }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "demo mode makes no HTTP requests, so there is nothing to count"
  );
  const asked = [];
  await page.route(/\/posts\/\?.*since=/, (route) => {
    asked.push(route.request().url());
    return route.continue();
  });

  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  // The positive control first. Without it this test passes whether or not
  // anything was ever torn down, because a poll that never happened and a poll
  // that was stopped look identical from here.
  await pollNow(page);
  await expect.poll(() => asked.length).toBe(1);

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  await pollNow(page);
  await page.waitForTimeout(500);
  expect(asked.length).toBe(1);
});
