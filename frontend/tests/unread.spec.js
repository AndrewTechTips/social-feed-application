// What the app remembers about the reader: which posts they've opened, when
// they were last here, and how long a post will take.
//
// None of this has a backend — it is two keys in localStorage, read at boot by
// js/reading.js — so both projects exercise exactly the same code. The suite
// still runs it twice, because the *feed* around it differs (the demo adapter
// and mock_api.py each build their own pages) and the bookmark has to land in
// the right place either way.
//
// Two things are planted rather than acted out. `commons.visit` is planted
// because the honest way to produce it is to come back tomorrow, and
// `commons.read` is planted in the one test that needs a card already dimmed
// on arrival. Everything else goes through the app: the tests below open posts
// and read the storage the app wrote.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const SINCE = ".feed__since";
const BOOKMARK = ".bookmark";
const LIST_CHILDREN = ".feed__list > *";

// An init script, so it is in place before any app code reads it — and it runs
// on every document load, which matters because reading.js rewrites this key at
// boot. Planted *after* any api.seed() call in a test: seeding re-registers the
// demo fixture's own init script, and the last registration wins.
//
// `seen: now` says this is the same visit carrying on, which is what makes
// reading.js read `since` back rather than deciding the reader has returned
// after a gap and taking `seen` as the new mark. plantReturn below is the
// other half of that fork.
const plantVisit = (page, ms) =>
  page.addInitScript((at) => {
    try {
      localStorage.setItem(
        "commons.visit",
        JSON.stringify({ seen: Date.now(), since: at })
      );
    } catch (e) {}
  }, ms);

// Somebody who was last here `agoMs` ago and has been away since — past the
// thirty-minute session window, so where they got to becomes the new mark.
const plantReturn = (page, agoMs) =>
  page.addInitScript((ago) => {
    try {
      localStorage.setItem(
        "commons.visit",
        JSON.stringify({ seen: Date.now() - ago, since: null })
      );
    } catch (e) {}
  }, agoMs);

const plantRead = (page, ids) =>
  page.addInitScript((list) => {
    try {
      localStorage.setItem("commons.read", JSON.stringify(list));
    } catch (e) {}
  }, ids);

const readIds = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("commons.read") || "[]");
    } catch (e) {
      return [];
    }
  });

// The feed is newest first, and both backends stamp seeded posts one second
// apart — so the nth card's own timestamp is a cutoff that puts exactly n
// posts after it. Read out of the DOM rather than computed, so this can't
// drift from whatever the two seeders decide to do.
async function cutoffAfter(page, n) {
  const stamps = await page
    .locator(`${CARD} time`)
    .evaluateAll((els) => els.map((el) => el.getAttribute("datetime")));
  return Date.parse(stamps[n]);
}

// ── when you were last here ────────────────────────────────────────────────
test.describe("new since your last visit", () => {
  test("a first visit has nothing to be new since", async ({ page, api }) => {
    await api.seed(3);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(3);

    await expect(page.locator(SINCE)).toBeHidden();
    await expect(page.locator(BOOKMARK)).toHaveCount(0);
  });

  test("counts what arrived, and draws the line where it stops", async ({
    page,
    api,
  }) => {
    await api.seed(5);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(5);

    await plantVisit(page, await cutoffAfter(page, 2));
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(5);

    await expect(page.locator(SINCE)).toHaveText(
      "Two new posts since you were last here."
    );

    // Two cards, then the line, then the rest.
    const kinds = await page
      .locator(LIST_CHILDREN)
      .evaluateAll((els) => els.map((el) => el.className));
    expect(kinds.filter((c) => c.includes("bookmark"))).toHaveLength(1);
    expect(kinds[2]).toContain("bookmark");
  });

  test("one is singular", async ({ page, api }) => {
    await api.seed(4);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(4);

    await plantVisit(page, await cutoffAfter(page, 1));
    await page.goto("/");
    await expect(page.locator(SINCE)).toHaveText(
      "One new post since you were last here."
    );
  });

  test("nothing new says nothing at all", async ({ page, api }) => {
    await api.seed(3);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(3);

    // A visit *after* every post there is.
    await plantVisit(page, Date.now() + 60_000);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(3);

    await expect(page.locator(SINCE)).toBeHidden();
    await expect(page.locator(BOOKMARK)).toHaveCount(0);
  });

  test("a set of search results is not the feed", async ({ page, api }) => {
    await api.seed(5);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(5);

    await plantVisit(page, await cutoffAfter(page, 2));
    await page.goto("/#/?search=post");
    await expect(page.locator(CARD).first()).toBeVisible();

    await expect(page.locator(SINCE)).toBeHidden();
    await expect(page.locator(BOOKMARK)).toHaveCount(0);
  });

  test("a refresh is not leaving", async ({ page, api }) => {
    await api.seed(5);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(5);

    await plantVisit(page, await cutoffAfter(page, 2));
    await page.goto("/");
    await expect(page.locator(SINCE)).toHaveText(
      "Two new posts since you were last here."
    );

    // Reloading writes "you were last here a moment ago" on the way out. If
    // that were the value the next document read, F5 would quietly throw the
    // line away before the reader had done anything about it.
    await page.reload();
    await expect(page.locator(CARD)).toHaveCount(5);
    await expect(page.locator(SINCE)).toHaveText(
      "Two new posts since you were last here."
    );
    await expect(page.locator(BOOKMARK)).toHaveCount(1);
  });

  test("being away long enough does move the mark", async ({ page, api }) => {
    // Last here 31 minutes ago, which is past the session window — so
    // everything seeded since is new, and there is no older run for the line to
    // sit above.
    await api.seed(5);
    await plantReturn(page, 31 * 60 * 1000);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(5);

    // The moment is named loosely here, and only here, because this is one of
    // the two tests that plants a visit *31 minutes* in the past to clear the
    // session window — and for the first 31 minutes of any day that timestamp
    // is genuinely yesterday. The app is right to say so; it is the assertion
    // that would be wrong. The count and the mark are what this test is about,
    // and both are still exact. The wording itself is pinned by the tests
    // above, which plant their visits seconds ago and cannot cross midnight.
    await expect(page.locator(SINCE)).toHaveText(
      /^Five new posts since (you were last here|yesterday)\.$/
    );
    await expect(page.locator(BOOKMARK)).toHaveCount(0);
  });

  test("a count it cannot yet know is given as a floor", async ({ page, api }) => {
    // Fifteen new posts and a page size of ten: the far edge of the new run is
    // not on screen, so the only honest number is the one loaded so far.
    await api.seed(15);
    await plantReturn(page, 31 * 60 * 1000);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(10);

    // Loose about the moment, exact about the floor — see the note above.
    await expect(page.locator(SINCE)).toHaveText(
      /^At least ten new posts since (you were last here|yesterday)\.$/
    );
  });

  test("coming back from a post keeps the line where it was", async ({ page, api }) => {
    await api.seed(5);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(5);

    await plantVisit(page, await cutoffAfter(page, 2));
    await page.goto("/");
    await expect(page.locator(SINCE)).toBeVisible();

    // Out to a post and straight back, which restores the feed from cache —
    // the path that used to skip the bookkeeping entirely.
    await page.locator(`${CARD} .card__link`).first().click();
    await expect(page.locator(".detail__title")).toBeVisible();
    await page.locator(".back").click();
    await expect(page.locator(CARD)).toHaveCount(5);

    await expect(page.locator(SINCE)).toHaveText(
      "Two new posts since you were last here."
    );
    await expect(page.locator(BOOKMARK)).toHaveCount(1);
  });
});

// ── what you've read ───────────────────────────────────────────────────────
test.describe("read state", () => {
  test("a post you sit with goes quiet on the feed", async ({ page, api }) => {
    await api.seed(2);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(page.locator(".card--read")).toHaveCount(0);

    await page.locator(`${CARD} .card__link`).first().click();
    await expect(page.locator(".detail__title")).toBeVisible();

    // The app decides this on a timer it owns; poll for the write rather than
    // sleeping for a guess at it.
    await expect.poll(() => readIds(page), { timeout: 10_000 }).toHaveLength(1);

    await page.locator(".back").click();
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(page.locator(CARD).first()).toHaveClass(/card--read/);
    await expect(page.locator(".card--read")).toHaveCount(1);
  });

  test("a mis-tap does not count as read", async ({ page, api }) => {
    await api.seed(2);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(2);

    await page.locator(`${CARD} .card__link`).first().click();
    await expect(page.locator(".detail__title")).toBeVisible();
    // Straight back out, well inside the two seconds reading.js waits.
    await page.locator(".back").click();
    await expect(page.locator(CARD)).toHaveCount(2);

    // Long enough that the timer would have fired if leaving hadn't cancelled it.
    await page.waitForTimeout(2500);
    expect(await readIds(page)).toEqual([]);
    await expect(page.locator(".card--read")).toHaveCount(0);
  });

  test("it survives a reload, and says so to a screen reader", async ({
    page,
    api,
  }) => {
    await api.seed(3);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(3);

    const ids = await page
      .locator(`${CARD} .card__link`)
      .evaluateAll((els) =>
        els.map((el) => Number(el.getAttribute("href").split("/").pop()))
      );
    await plantRead(page, [ids[1]]);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(3);

    await expect(page.locator(CARD).nth(1)).toHaveClass(/card--read/);
    await expect(page.locator(".card--read")).toHaveCount(1);
    // The dimmed title is the only channel a sighted reader needs and the one
    // channel a listening reader doesn't have.
    await expect(page.locator(CARD).nth(1)).toContainText("Already read");
    await expect(page.locator(CARD).first()).not.toContainText("Already read");
  });
});

// ── how long it takes ──────────────────────────────────────────────────────
test.describe("reading time", () => {
  test("every card says how long it is", async ({ page, api }) => {
    await api.seed(3);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(3);

    const mins = page.locator(`${CARD} .card__mins`);
    await expect(mins).toHaveCount(3);
    // "4 min" drawn, "4 min read" read out.
    for (const text of await mins.allTextContents()) {
      expect(text.trim()).toMatch(/^[1-9]\d* min read$/);
    }
    await expect(mins.first()).toHaveText(/min/);
  });
});

// ── the quality floor ──────────────────────────────────────────────────────
test.describe("the new furniture holds up", () => {
  test("axe is clean on a feed wearing all three", async ({ page, api }) => {
    await api.seed(5);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(5);

    const ids = await page
      .locator(`${CARD} .card__link`)
      .evaluateAll((els) =>
        els.map((el) => Number(el.getAttribute("href").split("/").pop()))
      );
    await plantRead(page, [ids[0], ids[3]]);
    await plantVisit(page, await cutoffAfter(page, 2));
    await page.goto("/");
    await expect(page.locator(BOOKMARK)).toHaveCount(1);
    await expect(page.locator(".card--read")).toHaveCount(2);

    // The dimmed title is the reason this scan exists: --text-dim on a card is
    // a contrast pair nothing measured before.
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      // .card transitions its background-colour, so scanning straight after
      // the flip measures a card halfway between the two themes — which is how
      // this first ran: a dark-theme --text-faint against a background still
      // most of the way to the light theme's white, reported as 3.46:1.
      await settled(page);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .include(".feed")
        .analyze();
      expect(result.violations, `${theme} theme`).toEqual([]);
    }
  });

  test.describe("at 320px", () => {
    test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

    test("the meta row still fits on one line and the page doesn't scroll sideways", async ({
      page,
      api,
    }) => {
      await api.seed(3);
      await page.goto("/");
      await expect(page.locator(CARD)).toHaveCount(3);
      await plantVisit(page, await cutoffAfter(page, 1));
      await page.goto("/");
      await expect(page.locator(BOOKMARK)).toHaveCount(1);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // One line: the row's height must not have grown past a single line box,
      // and the reading time must still be inside the card it belongs to.
      const fits = await page.evaluate(() => {
        const meta = document.querySelector(".card__meta");
        const mins = document.querySelector(".card__mins");
        if (!meta || !mins) return null;
        const m = meta.getBoundingClientRect();
        const t = mins.getBoundingClientRect();
        return {
          rows: Math.round(m.height / t.height),
          insideRight: Math.round(m.right - t.right),
        };
      });
      expect(fits).not.toBeNull();
      expect(fits.rows).toBe(1);
      expect(fits.insideRight).toBeGreaterThanOrEqual(0);
    });
  });
});
