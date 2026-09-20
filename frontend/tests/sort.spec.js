// Ordering the feed, and the two things that quietly assume it is in time
// order.
//
// The constants and how they were chosen are in
// docs/adr/0008-a-ranking-with-two-gravities.md. What these check is that both
// stand-in backends rank the same way the real one does, and that the feed's
// other furniture knows when it no longer applies.

const { test, expect, CARD } = require("./support/fixtures");

const OPTION = ".sortbar__option";
const current = (page) => page.locator(`${OPTION}[aria-current]`);

const titles = (page) =>
  page.locator(".card__title").evaluateAll((els) => els.map((e) => e.textContent.trim()));

/**
 * Wait for the screen the sort bar says you are on.
 *
 * `toHaveCount(n)` is not a wait here: two orderings of the same posts have
 * the same number of cards, so it is satisfied by the list still on screen
 * from the previous ordering and the titles read back are the old ones. The
 * marked option is the one thing that differs, so it is the thing to wait on.
 */
async function ordered(page, label, count) {
  await expect(current(page)).toHaveText(label);
  await expect(page.locator(CARD)).toHaveCount(count);
}

test.describe("the control", () => {
  test("three ways in, and the one you're on is marked", async ({ page, api }) => {
    await api.seed(3);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(3);

    await expect(page.locator(OPTION)).toHaveCount(3);
    await expect(current(page)).toHaveText("Newest");

    await page.locator(OPTION, { hasText: "Warmest" }).click();
    await expect(page).toHaveURL(/sort=warm/);
    await expect(page.locator(CARD)).toHaveCount(3);
    await expect(current(page)).toHaveText("Warmest");

    // A real address: Back undoes it.
    await page.goBack();
    await expect(current(page)).toHaveText("Newest");
  });

  test("it is not offered while searching, where relevance leads", async ({
    page,
    api,
  }) => {
    await api.seed(3);
    await page.goto("/#/?search=Seeded");
    await expect(page.locator(CARD).first()).toBeVisible();
    await expect(page.locator(".sortbar")).toHaveCount(0);
  });

  test("a sort nobody has heard of is the default, not an error", async ({
    page,
    api,
  }) => {
    await api.seed(2);
    await page.goto("/#/?sort=best");
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(current(page)).toHaveText("Newest");
  });
});

test.describe("the ranking", () => {
  test("warmest is not newest", async ({ page, api }) => {
    // Two posts, the older one liked. Newest puts the fresh one first;
    // warmest puts the liked one first, which is the entire point of having
    // two orderings.
    await api.seed(1, "ada@commons.test", 3);
    await api.seed(1, "bea@commons.test", 0);

    await page.goto("/");
    await ordered(page, "Newest", 2);
    const newest = await titles(page);

    await page.goto("/#/?sort=warm");
    await ordered(page, "Warmest", 2);
    const warmest = await titles(page);

    expect(warmest[0]).toBe(newest[1]);
    expect(warmest).not.toEqual(newest);
  });

  test("an unvoted feed ranks by recency, because every score is zero", async ({
    page,
    api,
  }) => {
    await api.seed(3, "ada@commons.test", 0);
    await page.goto("/");
    await ordered(page, "Newest", 3);
    const newest = await titles(page);

    await page.goto("/#/?sort=warm");
    await ordered(page, "Warmest", 3);
    // The tie-break is created_at DESC, so nothing moves — and nothing should.
    expect(await titles(page)).toEqual(newest);
  });

  test("discussed answers a different question from warmest", async ({ page, api }) => {
    await api.seed(1, "ada@commons.test", 5); // liked, not discussed
    await api.signIn(page, "ada@commons.test", "seedpassword");
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(1);
    const liked = (await titles(page))[0];

    // A second post, unliked, with a conversation on it.
    await api.seedLive(page, 1, "bea@commons.test", 0);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(2);
    const talked = (await titles(page))[0];

    await page.locator(`${CARD} .card__link`).first().click();
    await expect(page.locator(".detail__title")).toBeVisible();
    const box = page.locator(".composer .textarea");
    await box.fill("something to say");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.locator(".comment")).toHaveCount(1);

    await page.goto("/#/?sort=warm");
    await ordered(page, "Warmest", 2);
    expect((await titles(page))[0]).toBe(liked);

    await page.goto("/#/?sort=discussed");
    await ordered(page, "Discussed", 2);
    expect((await titles(page))[0]).toBe(talked);
  });
});

test.describe("what a ranking turns off", () => {
  // Two pieces of the feed's furniture quietly assume it is in time order.

  const plantVisit = (page, ms) =>
    page.addInitScript((at) => {
      try {
        localStorage.setItem(
          "commons.visit",
          JSON.stringify({ seen: Date.now(), since: at })
        );
      } catch (e) {}
    }, ms);

  test("the 'new since' line and its rule only belong on the newest feed", async ({
    page,
    api,
  }) => {
    await api.seed(4);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(4);
    const stamps = await page
      .locator(`${CARD} time`)
      .evaluateAll((els) => els.map((el) => el.getAttribute("datetime")));

    await plantVisit(page, Date.parse(stamps[2]));
    await page.goto("/");
    await expect(page.locator(".feed__since")).toBeVisible();
    await expect(page.locator(".bookmark")).toHaveCount(1);

    // "What arrived while you were away, and where that run ends" is only a
    // run if the list is in time order.
    await page.goto("/#/?sort=warm");
    await expect(page.locator(CARD)).toHaveCount(4);
    await expect(page.locator(".feed__since")).toBeHidden();
    await expect(page.locator(".bookmark")).toHaveCount(0);
  });

  test("the window anchor is not sent for a ranking", async ({ page, api }) => {
    const asked = [];
    await page.route(/\/posts\/\?/, (route) => {
      const q = new URL(route.request().url()).searchParams;
      asked.push({ sort: q.get("sort"), as_of: q.get("as_of") });
      return route.continue();
    });

    await api.seed(13, "ada@commons.test");
    await page.goto("/#/?sort=warm");
    await expect(page.locator(CARD)).toHaveCount(10);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator(CARD)).toHaveCount(13);

    test.skip(asked.length === 0, "no HTTP requests to observe in demo mode");
    expect(asked.length).toBeGreaterThan(1);
    // An anchor taken from the top of a ranking is not the newest post, so it
    // would cut posts out of the window rather than hold it still.
    expect(asked.every((a) => a.as_of === null)).toBe(true);
    expect(asked.every((a) => a.sort === "warm")).toBe(true);
  });

  test("each ordering is cached as its own list", async ({ page, api }) => {
    await api.seed(1, "ada@commons.test", 3);
    await api.seed(1, "bea@commons.test", 0);

    await page.goto("/#/?sort=warm");
    await ordered(page, "Warmest", 2);
    const warmest = await titles(page);

    await page.goto("/");
    await ordered(page, "Newest", 2);
    const newest = await titles(page);
    expect(newest).not.toEqual(warmest);

    // Back to warm: served from its own cache entry, not from the feed's.
    await page.goto("/#/?sort=warm");
    await ordered(page, "Warmest", 2);
    expect(await titles(page)).toEqual(warmest);
  });
});

test.describe("changing the order is not going anywhere", () => {
  // ── re-ordering is not a journey ──────────────────────────────────────────
  //
  // Pressing Warmest used to be served exactly like following a link to another
  // screen: the page-level view transition faded and raised every pixel, and
  // five skeleton cards went up in place of a list that was about to be
  // replaced by the same posts in a different order. Both are sentences about
  // having gone somewhere, and nobody went anywhere — which is why it read as
  // the whole page reloading. See the notes on `sameScreen` and `reordering`
  // in js/views/feed.js.

  /** Watch for the two things a re-order must not do. */
  async function watchTheSwap(page) {
    await page.evaluate(() => {
      window.__swap = { transitions: 0, maxSkeletons: 0 };
      const original = document.startViewTransition?.bind(document);
      if (original) {
        document.startViewTransition = (callback) => {
          window.__swap.transitions++;
          return original(callback);
        };
      }
      const count = () => {
        window.__swap.maxSkeletons = Math.max(
          window.__swap.maxSkeletons,
          document.querySelectorAll(".card--skeleton").length
        );
      };
      new MutationObserver(count).observe(document.getElementById("view"), {
        childList: true,
        subtree: true,
      });
      count();
    });
  }

  const swapped = (page) => page.evaluate(() => window.__swap);

  test("a re-order does not replay the page-change animation", async ({ page, api }) => {
    await api.seed(3);
    await page.goto("/");
    await ordered(page, "Newest", 3);

    await watchTheSwap(page);
    await page.locator(OPTION, { hasText: "Warmest" }).click();
    await ordered(page, "Warmest", 3);

    // Not a journey, so nothing travels. startViewTransition is what draws the
    // whole screen fading and rising, and it belongs to going somewhere.
    expect((await swapped(page)).transitions).toBe(0);
  });

  test("a re-order does not flash skeletons over a list it already has", async ({
    page,
    api,
  }) => {
    await api.seed(3);
    await page.goto("/");
    await ordered(page, "Newest", 3);

    await watchTheSwap(page);
    await page.locator(OPTION, { hasText: "Warmest" }).click();
    await ordered(page, "Warmest", 3);

    // The old order stays up until the new one is in hand. Both lists hold the
    // same posts, so nothing on screen during the wait is untrue.
    expect((await swapped(page)).maxSkeletons).toBe(0);
  });

  test("the cards never go away while the order changes", async ({ page, api }) => {
    await api.seed(3);
    await page.goto("/");
    await ordered(page, "Newest", 3);

    // Sampled every frame across the swap: if the list were ever emptied or
    // replaced by placeholders, the count would dip below three.
    await page.evaluate(() => {
      window.__low = Infinity;
      const tick = () => {
        window.__low = Math.min(
          window.__low,
          document.querySelectorAll(".feed__list .card:not(.card--skeleton)").length
        );
        window.__raf = requestAnimationFrame(tick);
      };
      window.__raf = requestAnimationFrame(tick);
    });

    await page.locator(OPTION, { hasText: "Warmest" }).click();
    await ordered(page, "Warmest", 3);
    const low = await page.evaluate(() => {
      cancelAnimationFrame(window.__raf);
      return window.__low;
    });
    expect(low).toBe(3);
  });

  test("a search keeps its skeletons, because the posts really do change", async ({
    page,
    api,
  }) => {
    await api.seed(6);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(6);

    await watchTheSwap(page);
    // Held cards are live cards — clickable, and still what the post screen
    // reads its "more from" list out of. On a re-order that is honest, because
    // both lists hold the same posts. On a search it would leave the reader
    // able to open a result that does not match what they just typed, so the
    // loading state is the truthful thing to show.
    await page.goto("/#/?search=Seeded");
    await expect(page.locator(CARD).first()).toBeVisible();

    const { transitions, maxSkeletons } = await swapped(page);
    expect(maxSkeletons).toBeGreaterThan(0);
    // Still the same screen, though, so it still doesn't travel.
    expect(transitions).toBe(0);
  });
});
