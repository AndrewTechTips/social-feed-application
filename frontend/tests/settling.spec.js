// What the screen does *while* it changes.
//
// The suite already pins where you end up. This file pins the couple of
// hundred milliseconds in between, which is where three separate things were
// going wrong at once and reading, to anyone watching, as one vague "it feels
// rigid":
//
//   · the chrome changed on `hashchange` — a good tenth of a second before the
//     screen it belongs to existed — so on a phone the feed sat there wearing
//     the post's one-row header, forty pixels out of place, until the post
//     turned up;
//   · the comment list put up grey bars for every post, including the ones
//     whose comments came back in a hundred and fifty milliseconds;
//   · the page had no reserved scrollbar track, so a short post took the
//     scrollbar away with it and every line on the page re-wrapped.
//
// None of the three is visible in a screenshot of the finished screen, which
// is why they survived a suite this size. Each one gets a test here.

const { test, expect, CARD } = require("./support/fixtures");

// Record what the chrome and the screen were doing at the same instant.
//
// A MutationObserver callback runs as a microtask after the batch that caused
// it, so by the time this fires it can see everything the swap did — which is
// exactly the question: when the search row came or went, had the screen it
// belongs to already been put on the page?
const watchChrome = (page) =>
  page.addInitScript(() => {
    window.__chrome = [];
    addEventListener("DOMContentLoaded", () => {
      const search = document.querySelector(".search");
      const view = document.getElementById("view");
      if (!search || !view) return;
      new MutationObserver(() => {
        window.__chrome.push({
          searchHidden: !!search.hidden,
          screen: view.firstElementChild ? view.firstElementChild.className : null,
        });
      }).observe(search, { attributes: true, attributeFilter: ["hidden"] });
    });
  });

// Was a loading state ever *painted* under a post?
//
// Counted a frame at a time rather than with a MutationObserver, and that is
// not laziness. The comment list is built and filled while the screen it
// belongs to is still detached — mountView hands the swap to
// startViewTransition, which runs it a frame later — so nothing watching the
// document ever sees the skeleton go in. What a reader sees is what is on
// screen at a frame boundary, which is exactly what this asks.
//
// It fails safe: a machine stalled long enough to let the placeholder through
// is also a machine that painted no frames while it was up, so a hiccup here
// reads as a pass rather than as a phantom failure.
const watchCommentSkeletons = (page) =>
  page.addInitScript(() => {
    window.__commentSkeletons = 0;
    addEventListener("DOMContentLoaded", () => {
      const tick = () => {
        if (document.querySelector(".comments .sk")) window.__commentSkeletons += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });

test("the chrome changes with the screen, not ahead of it", async ({ page, api }) => {
  await watchChrome(page);
  await api.seed(3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  await page.locator(CARD).first().locator(".card__title").click();
  await expect(page.locator(".detail__title")).toBeVisible();

  // The search belongs to the feed. Every moment it was hidden, the post was
  // already the screen — never the feed with the post's header on.
  const hidden = (await page.evaluate(() => window.__chrome)).filter(
    (e) => e.searchHidden
  );
  expect(
    hidden.length,
    "the search should have been hidden on the way to a post"
  ).toBeGreaterThan(0);
  for (const entry of hidden) {
    expect(entry.screen, "search hidden while the feed was still up").toContain(
      "detail"
    );
  }

  // And back the other way: the row returns with the feed, not before it.
  await page.evaluate(() => (window.__chrome = []));
  await page.locator(".back").click();
  await expect(page.locator(CARD).first()).toBeVisible();

  const shown = (await page.evaluate(() => window.__chrome)).filter(
    (e) => !e.searchHidden
  );
  expect(shown.length, "the search should have come back on the feed").toBeGreaterThan(
    0
  );
  for (const entry of shown) {
    expect(entry.screen, "search shown while the post was still up").toContain("feed");
  }
});

test("a fast conversation never shows a loading state", async ({ page, api }) => {
  await watchCommentSkeletons(page);
  await api.seed(1, "ada@commons.test");
  await page.goto("/");
  await page.locator(CARD).first().locator(".card__title").click();

  await expect(page.locator(".comments")).toBeVisible();
  await expect(page.locator(".comments__status")).toHaveText(/Nothing said/);

  // The request goes out with the post's, so on anything this quick the answer
  // is in hand before the placeholder is due. Grey bars here would mean either
  // half of that had been undone.
  expect(await page.evaluate(() => window.__commentSkeletons)).toBe(0);
});

test("the scrollbar track is reserved, so screens don't shift sideways", async ({
  page,
  api,
}) => {
  await api.seed(12, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  // The mechanism, asserted directly: on a platform with overlay scrollbars —
  // which is what this runs on — the widths below are equal whatever the CSS
  // says, so the widths alone would pass against a page that still shifts.
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)
  ).toBe("scroll");
  // overflow-x has to be on the same element. Left on body it propagates to the
  // viewport, and setting overflow on html stops that propagation, hands body a
  // scroll container of its own and quietly breaks the sticky header.
  expect(await page.evaluate(() => getComputedStyle(document.body).overflowX)).toBe(
    "visible"
  );

  const feedWidth = await page.evaluate(() => document.documentElement.clientWidth);
  await page.locator(CARD).first().locator(".card__title").click();
  await expect(page.locator(".detail__title")).toBeVisible();

  const post = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(
    post.scrollHeight,
    "this post has to be short enough to test anything"
  ).toBeLessThan(post.clientHeight * 2);
  expect(post.width).toBe(feedWidth);
});

test("the header stays put while a post loads", async ({ page, api }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await api.seed(4, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  const header = page.locator(".site-header");
  const onFeed = (await header.boundingBox()).height;

  // Narrow enough that the search has a row to itself, so leaving the feed
  // costs the header real height. If that ever stops being true this test is
  // measuring nothing, so say so rather than passing quietly.
  await page.locator(".back, .card__title").first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  const onPost = (await header.boundingBox()).height;
  expect(onPost, "the narrow header should shed a row off the feed").toBeLessThan(
    onFeed
  );

  // The point being that it shed it *when the post arrived*, which is what the
  // first test in this file pins. Here we only check the two resting states are
  // the ones the layout expects, so that test keeps meaning something.
  expect(onFeed - onPost).toBeGreaterThan(20);
});
