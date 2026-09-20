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
          () =>
            getComputedStyle(document.querySelector(".detail__title"))
              .viewTransitionName
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
    expect(await started(page), "post → feed should transition too").toBeGreaterThan(
      before
    );
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

test("the chrome stays put instead of cross-fading with the page", async ({
  page,
  api,
}) => {
  await api.seed(1, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector(".site-header")).viewTransitionName
    )
  ).toBe("site-header");
});

// ── the lights coming up ───────────────────────────────────────────────────
// A theme change is the one transition that isn't a navigation. It gets its own
// recipe (a symmetric fade, no travel) and its own flag, and the flag is the
// part with teeth: it has to be on while the snapshots are taken and off again
// afterwards, or the *next* page change inherits a theme change's animation.

const themeButton = (page) => page.getByRole("button", { name: /Switch to .* theme/ });
const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);

test("changing the theme cross-fades the room", async ({ page, api }) => {
  await countTransitions(page);
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
  if (!(await supported(page))) test.skip();

  const before = await theme(page);
  await themeButton(page).click();

  expect(await started(page)).toBe(1);
  await expect.poll(() => theme(page)).not.toBe(before);
});

test("the flag it animates by does not outlive the transition", async ({
  page,
  api,
}) => {
  // It keys a different animation onto ::view-transition-*(root). Left behind,
  // every subsequent navigation would fade like a theme change — and it would
  // be invisible in review, because nothing about the theme would be wrong.
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await themeButton(page).click();
  await expect
    .poll(() => page.evaluate(() => "themeShift" in document.documentElement.dataset))
    .toBe(false);
});

test("the header joins the fade instead of sitting it out", async ({ page, api }) => {
  // It normally carries its own view-transition-name so that the chrome holds
  // still while the page under it changes. On a theme change the chrome changes
  // colour too, so it has to give the name up — and that has to happen before
  // the snapshot, which means it is checked while the transition is running.
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
  if (!(await supported(page))) test.skip();

  const named = page.evaluate(
    () =>
      new Promise((resolve) => {
        const real = document.startViewTransition.bind(document);
        document.startViewTransition = (cb) =>
          real(() => {
            // Inside the callback the old snapshot has been taken, so this is
            // the value it was taken with.
            resolve(
              getComputedStyle(document.querySelector(".site-header"))
                .viewTransitionName
            );
            cb();
          });
      })
  );
  await themeButton(page).click();
  expect(await named).toBe("none");
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

  test("and none for a theme change either, which still changes the theme", async ({
    page,
    api,
  }) => {
    await countTransitions(page);
    await api.seed(2);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(2);

    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByRole("button", { name: /Switch to .* theme/ }).click();

    // The decision is made before a transition is started, and the flip still
    // happens unwrapped — which is what it always was.
    expect(await started(page)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(
      before
    );
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

  const animated = await page.evaluate(
    () =>
      [...document.querySelectorAll(".card:not(.card--skeleton)")].filter(
        (c) => getComputedStyle(c).animationName !== "none"
      ).length
  );
  expect(animated, "per-card entrance animation should be gone").toBe(0);

  // ...including the pages that arrive later, where nothing has "arrived" at all
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(CARD)).toHaveCount(12);
  const afterPaging = await page.evaluate(
    () =>
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

// ── the other half of the journey: where "Back" says it goes ────────────────
// The morph carries the reader from whichever card they tapped and reverses on
// the way out. A Back link that always said "the feed" was the one thing that
// could make that journey feel like it lied — and, from a set of search
// results, it quietly threw the search away.
test.describe("the Back link names its destination", () => {
  test("from the feed, it's the feed", async ({ page, api }) => {
    await api.seed(2, "ada@commons.test");
    await page.goto("/");
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.locator(".card__title").first().click();
    await expect(page.locator(".detail__title")).toBeVisible();
    await expect(page.locator(".back")).toHaveText("Back to the feed");
    await expect(page.locator(".back")).toHaveAttribute("href", "#/");
  });

  test("from a profile, it's that person", async ({ page, api }) => {
    await api.seed(2, "ada@commons.test");
    await page.goto("/#/u/ada");
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.locator(".card__title").first().click();
    await expect(page.locator(".detail__title")).toBeVisible();
    await expect(page.locator(".back")).toHaveText("Back to ada");

    await page.locator(".back").click();
    await expect(page).toHaveURL(/#\/u\/ada$/);
  });

  test("from a search, it keeps the search", async ({ page, api }) => {
    await api.seed(3, "ada@commons.test");
    await page.goto("/");
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.locator("#search-input").fill("Seeded post 2");
    await expect(page).toHaveURL(/search=/);
    await expect(page.locator(CARD)).toHaveCount(1);

    await page.locator(".card__title").first().click();
    await expect(page.locator(".detail__title")).toBeVisible();
    await expect(page.locator(".back")).toHaveText("Back to the results");

    await page.locator(".back").click();
    await expect(page).toHaveURL(/search=/);
    await expect(page.locator(CARD)).toHaveCount(1);
  });

  test("arriving cold — a pasted link — goes to the feed", async ({ page, api }) => {
    const { created } = await (await api.seed(1, "ada@commons.test")).json();
    await page.goto(`/#/posts/${created[0]}`);
    await expect(page.locator(".detail__title")).toBeVisible();
    await expect(page.locator(".back")).toHaveText("Back to the feed");
  });
});
