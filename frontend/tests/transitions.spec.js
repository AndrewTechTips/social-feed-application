// The one orchestrated movement in the app.
//
// What's worth pinning here isn't "an animation played" — it's the three rules
// that keep it from becoming the thing it replaced: it only ever runs in answer
// to a tap, it never runs when the reader has asked for less motion, and it
// never leaves its name behind on a live element (two elements wearing the same
// view-transition-name make the *next* transition ambiguous, and the browser
// drops ambiguous transitions silently).

const { test, expect, CARD } = require("./support/fixtures");

// Count transitions by wrapping the API in the page.
const countTransitions = (page) =>
  page.addInitScript(() => {
    window.__transitions = 0;
    if (typeof document.startViewTransition === "function") {
      const real = document.startViewTransition.bind(document);
      document.startViewTransition = (cb) => {
        window.__transitions++;
        return real(cb);
      };
    }
  });

const started = (page) => page.evaluate(() => window.__transitions || 0);
const supported = (page) =>
  page.evaluate(() => typeof document.startViewTransition === "function");

test("the tapped title becomes the heading of the post", async ({ page, api }) => {
  await countTransitions(page);
  await api.seed(3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  // Scoped to the card that's about to be clicked, and read with textContent:
  // innerText depends on layout, which is still settling as the feed swaps its
  // skeletons for the real thing.
  const titleEl = page.locator(CARD).first().locator(".card__title");
  await expect(titleEl).not.toHaveText("");
  const title = (await titleEl.textContent()).trim();

  await titleEl.click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);

  await expect(page.locator(".detail__title")).toHaveText(title);

  if (await supported(page)) {
    expect(await started(page), "feed → post should transition").toBeGreaterThan(0);
    // The heading is the element that travels, so it's the one that's named.
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.querySelector(".detail__title")).viewTransitionName
        )
      )
      .toBe("post-title");
  }
});

test("going back reverses the journey", async ({ page, api }) => {
  await countTransitions(page);
  await api.seed(3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  await page.locator(".card__title").first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  const before = await started(page);

  await page.locator(".back").click();
  await expect(page.locator(CARD).first()).toBeVisible();

  if (await supported(page)) {
    expect(await started(page), "post → feed should transition too").toBeGreaterThan(before);
  }
});

test("the name is released once the transition is over", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(".card__title").first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.locator(".back").click();
  await expect(page.locator(CARD).first()).toBeVisible();

  // At most one element may wear the name at a time. Two would make the next
  // transition ambiguous and the browser would drop it without a word.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...document.querySelectorAll("*")].filter(
            (el) => getComputedStyle(el).viewTransitionName === "post-title"
          ).length
      )
    )
    .toBeLessThanOrEqual(1);
});

test("the chrome stays put instead of cross-fading with the page", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector(".site-header")).viewTransitionName
    )
  ).toBe("site-header");
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("starts no transition at all", async ({ page, api }) => {
    await countTransitions(page);
    await api.seed(3, "ada@commons.test");
    await page.goto("/");
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.locator(".card__title").first().click();
    await expect(page.locator(".detail__title")).toBeVisible();

    // The View Transitions API doesn't consult prefers-reduced-motion, and CSS
    // can't reach ::view-transition-* from the blanket rule in base.css — so
    // the decision has to be made before starting one, and this proves it is.
    expect(await started(page)).toBe(0);
  });
});

test("a browser without the API still navigates, and still cross-fades", async ({
  page,
  api,
}) => {
  await page.addInitScript(() => {
    delete Document.prototype.startViewTransition;
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await api.seed(3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  await page.locator(".card__title").first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  // the fallback the app always had
  await expect(page.locator(".detail")).toHaveClass(/route-enter/);
  expect(errors).toEqual([]);
});

test("cards no longer animate themselves in", async ({ page, api }) => {
  await api.seed(12, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  const animated = await page.evaluate(() =>
    [...document.querySelectorAll(".card:not(.card--skeleton)")].filter(
      (c) => getComputedStyle(c).animationName !== "none"
    ).length
  );
  expect(animated, "per-card entrance animation should be gone").toBe(0);

  // ...including the pages that arrive later, where nothing has "arrived" at all
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(CARD)).toHaveCount(12);
  const afterPaging = await page.evaluate(() =>
    [...document.querySelectorAll(".card:not(.card--skeleton)")].filter(
      (c) => getComputedStyle(c).animationName !== "none"
    ).length
  );
  expect(afterPaging).toBe(0);
});

test("no separator dots left in the card meta", async ({ page, api }) => {
  await api.seed(2, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await expect(page.locator(".card__meta .dot")).toHaveCount(0);
});
