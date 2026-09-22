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
  page
    .locator(".card__title")
    .evaluateAll((els) => els.map((e) => e.textContent.trim()));

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

  test("a re-order does not replay the page-change animation", async ({
    page,
    api,
  }) => {
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

test.describe("a re-order leaves the page where it is", () => {
  // ── the bar is not at the top of the page ─────────────────────────────────
  //
  // On a phone the masthead is four hundred-odd pixels of type, so reaching
  // Newest / Warmest / Discussed means scrolling down to them — and the press
  // used to throw the reader somewhere else the moment it landed:
  //
  //   · up to the top, on an order this visit hadn't shown yet. That is where
  //     mountView leaves an arrival, and a re-order was being mounted as one,
  //     so the bar they had just pressed ended up off-screen above them.
  //   · down, or up, to wherever they were when they last *left* that order,
  //     on one the feed cache still holds. That position is restored with the
  //     list, which is exactly right coming back from a post and exactly wrong
  //     under a control they are still pointing at.
  //
  // Both are the same mistake — a re-order treated as a journey — and both are
  // measured from the press rather than from the test's own scrolling. See
  // `holdingPlace` in js/views/feed.js.
  test.use({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });

  const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY));

  /**
   * Watch the press, and watch what the page does from the press onwards.
   *
   * Both halves start at `pointerdown` on purpose. What happens before it is
   * the test getting into position — and the browser's scroll anchoring moving
   * the page a hundred pixels while the first cards land is the test settling,
   * not the app misbehaving. The claim is about the press: from the moment the
   * reader touches the bar, the page holds still.
   */
  const watchFromPress = (page) =>
    page.addInitScript(() => {
      // Sampled three ways, because one is not enough to catch a jump that is
      // put back. Frames catch a position the page rests at; the scroll event
      // catches a move that is undone before the next one is painted; and the
      // read at the end folds in where the page actually ended up, which is
      // the one sample a swap that finishes between two frames would otherwise
      // hide. Miss that and a page that went to the top and stayed there reads
      // as a page that never moved.
      const sample = () => {
        window.__low = Math.min(window.__low, window.scrollY);
        window.__high = Math.max(window.__high, window.scrollY);
      };
      window.__sample = sample;
      addEventListener("scroll", () => window.__watching && sample(), {
        passive: true,
      });
      addEventListener(
        "pointerdown",
        () => {
          window.__pressedAt = Math.round(window.scrollY);
          window.__watching = true;
          window.__low = window.__high = window.scrollY;
          cancelAnimationFrame(window.__raf);
          const tick = () => {
            sample();
            window.__raf = requestAnimationFrame(tick);
          };
          window.__raf = requestAnimationFrame(tick);
        },
        true
      );
    });

  const pressedAt = (page) => page.evaluate(() => window.__pressedAt);
  const travelled = (page) =>
    page.evaluate(() => {
      cancelAnimationFrame(window.__raf);
      window.__sample();
      window.__watching = false;
      return Math.round(window.__high - window.__low);
    });

  /**
   * Scroll until the bar sits `gap` pixels below the sticky header.
   *
   * Measured from the header rather than from the top of the viewport because
   * the two backends seed posts of different heights, which puts the masthead
   * above the bar at 303px on one and 425px on the other — and because a press
   * has to land on the bar rather than on the header sitting over it.
   */
  const barBelowHeader = (page, gap) =>
    page.evaluate((below) => {
      const bar = document.querySelector(".sortbar");
      const header = document.querySelector(".site-header").getBoundingClientRect();
      window.scrollTo(
        0,
        bar.getBoundingClientRect().top + window.scrollY - header.height - below
      );
    }, gap);

  /**
   * Press an option where it is, without Playwright scrolling first.
   *
   * `locator.click()` brings its target into view before pressing it, and on a
   * page that is deliberately scrolled that moves the page out from under the
   * test — which is the one thing this whole describe block is measuring. The
   * mouse goes to the box as it stands instead, which is also what a thumb
   * does.
   */
  async function press(page, label) {
    const box = await page.locator(OPTION, { hasText: label }).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  /** Where the reader was when they pressed, and it must not be the top. */
  async function pressedWhileScrolled(page) {
    const y = await pressedAt(page);
    // Otherwise every assertion below would be satisfied by a page that jumped
    // to the top, which is the bug.
    expect(y).toBeGreaterThan(100);
    return y;
  }

  test("pressing an order does not move the page", async ({ page, api }) => {
    await watchFromPress(page);
    await api.seed(14);
    await page.goto("/");
    await ordered(page, "Newest", 10);

    await barBelowHeader(page, 40);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(100);

    await press(page, "Warmest");
    await ordered(page, "Warmest", 10);

    const y = await pressedWhileScrolled(page);
    // The mount can land a frame or two after the list does.
    await expect.poll(() => scrollY(page)).toBe(y);
  });

  test("and does not flinch to the top on the way", async ({ page, api }) => {
    await watchFromPress(page);
    await api.seed(14);
    await page.goto("/");
    await ordered(page, "Newest", 10);

    await barBelowHeader(page, 40);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(100);

    await press(page, "Warmest");
    await ordered(page, "Warmest", 10);
    await pressedWhileScrolled(page);

    // Landing in the right place is half the claim. The other half is that the
    // page never went anywhere else and came back — a scroll to the top and a
    // restore a fetch later is just as visible as one that stays there, and
    // sampling only the ends would call it still. Every frame since the press.
    expect(await travelled(page)).toBeLessThanOrEqual(2);
  });

  test("an order you have been on before does not bring its old position back", async ({
    page,
    api,
  }) => {
    await watchFromPress(page);
    await api.seed(14);
    await page.goto("/");
    await ordered(page, "Newest", 10);

    // Leave Newest from near the top. This is the position its cache entry
    // keeps, and the one that used to come back with the list.
    await barBelowHeader(page, 180);
    await press(page, "Warmest");
    await ordered(page, "Warmest", 10);
    const left = await pressedAt(page);

    // ...and come back to it from further down the page.
    await barBelowHeader(page, 40);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(left + 100);
    await press(page, "Newest");
    await ordered(page, "Newest", 10);

    const here = await pressedWhileScrolled(page);
    await expect.poll(() => scrollY(page)).toBe(here);
    // Not vacuous: the remembered position is far enough above this one that
    // restoring it would be plain to see, and would have failed the line
    // above.
    expect(here - left).toBeGreaterThan(100);
  });
});
