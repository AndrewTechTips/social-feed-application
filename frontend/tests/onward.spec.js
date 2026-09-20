// Reading on: the two links at the end of a post, and the keys that follow them.
//
// The thing being pinned down is that this is *the list you arrived from*, not
// "the feed" — which is why it names where it came from, why it survives two
// steps in a row, and why it isn't there at all for somebody who pasted a link.

const { test, expect, CARD, signOutViaMenu } = require("./support/fixtures");

const ONWARD = ".onward";
const NEXT = ".onward__item--next";
const PREV = ".onward__item--prev";

const titleOf = (page, sel) => page.locator(`${sel} .onward__title`);

/** The feed's card titles, newest first — the order everything below is about. */
const feedTitles = (page) =>
  page
    .locator(`${CARD} .card__title`)
    .evaluateAll((els) => els.map((el) => el.textContent.trim()));

async function openCard(page, index) {
  await page.locator(`${CARD} .card__link`).nth(index).click();
  await expect(page.locator(".detail__title")).toBeVisible();
}

// ── what it offers ─────────────────────────────────────────────────────────
test("the end of a post offers both ways along the list", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const titles = await feedTitles(page);

  await openCard(page, 1);

  await expect(page.locator(ONWARD)).toBeVisible();
  await expect(page.locator(".onward__head")).toHaveText("More from the feed");
  await expect(titleOf(page, PREV)).toHaveText(titles[0]);
  await expect(titleOf(page, NEXT)).toHaveText(titles[2]);
});

test("the first post in the list has no previous", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const titles = await feedTitles(page);

  await openCard(page, 0);

  await expect(page.locator(PREV)).toHaveCount(0);
  await expect(titleOf(page, NEXT)).toHaveText(titles[1]);
});

test("the last loaded post has no next", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const titles = await feedTitles(page);

  await openCard(page, 2);

  await expect(page.locator(NEXT)).toHaveCount(0);
  await expect(titleOf(page, PREV)).toHaveText(titles[1]);
});

test("a post on its own offers nothing", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);

  await openCard(page, 0);
  await expect(page.locator(ONWARD)).toHaveCount(0);
});

test("a pasted link has no list, so there is nothing to read on from", async ({
  page,
  api,
}) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const href = await page.locator(`${CARD} .card__link`).first().getAttribute("href");

  // A *fresh document* at that address — the way a link out of somebody else's
  // message arrives. The reload is the whole point: this app is a hash router,
  // so navigating to "/#/posts/3" from a page that is already up changes the
  // fragment and nothing else, and the list would still be sitting in memory.
  await page.goto(`/${href}`);
  await page.reload();
  await expect(page.locator(".detail__title")).toBeVisible();
  await expect(page.locator(ONWARD)).toHaveCount(0);
});

// ── which list ─────────────────────────────────────────────────────────────
test("it names the profile you came from", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  await page.goto("/#/u/ada");
  await expect(page.locator(CARD)).toHaveCount(3);

  await openCard(page, 1);
  await expect(page.locator(".onward__head")).toHaveText("More from ada");
});

test("it names a set of results as results", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  await page.goto("/#/?search=post");
  await expect(page.locator(CARD).first()).toBeVisible();
  const found = await page.locator(CARD).count();
  test.skip(found < 2, "the seeded titles didn't produce a multi-post result set");

  await openCard(page, 0);
  await expect(page.locator(".onward__head")).toHaveText("More from these results");
});

// ── moving ─────────────────────────────────────────────────────────────────
test("two steps in a row keep working", async ({ page, api }) => {
  await api.seed(4);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(4);
  const titles = await feedTitles(page);

  await openCard(page, 0);
  await page.locator(NEXT).click();
  await expect(page.locator(".detail__title")).toHaveText(titles[1]);

  // The screen behind is now another post rather than the feed — the case that
  // would break if this read previousScreen() instead of the stored list.
  await page.locator(NEXT).click();
  await expect(page.locator(".detail__title")).toHaveText(titles[2]);
  await expect(titleOf(page, PREV)).toHaveText(titles[1]);
});

test("j and k walk the list from inside a post", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const titles = await feedTitles(page);

  await openCard(page, 1);
  await page.keyboard.press("j");
  await expect(page.locator(".detail__title")).toHaveText(titles[2]);

  await page.keyboard.press("k");
  await expect(page.locator(".detail__title")).toHaveText(titles[1]);
});

test("j at the end of the list does not double back", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const titles = await feedTitles(page);

  await openCard(page, 2);
  await page.keyboard.press("j");
  // Still here. A key that means "further down" in the middle of a list and
  // "back up" at the end of it would be worse than a key that does nothing.
  await expect(page.locator(".detail__title")).toHaveText(titles[2]);
});

test("the keys stay out of the way while you're writing a comment", async ({
  page,
  api,
}) => {
  await api.seed(3, "ada@commons.test");
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const titles = await feedTitles(page);

  await openCard(page, 1);
  const box = page.locator(".composer .textarea");
  await box.fill("");
  await box.pressSequentially("jk");
  await expect(box).toHaveValue("jk");
  await expect(page.locator(".detail__title")).toHaveText(titles[1]);
});

// ── the palette keeps its promise ──────────────────────────────────────────
test("the palette advertises it, and the row moves you", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const titles = await feedTitles(page);

  await openCard(page, 1);
  await page.keyboard.press("ControlOrMeta+k");
  const row = page.locator(".palette__row", {
    hasText: "Move to the next or previous post",
  });
  await expect(row).toBeVisible();
  await expect(row).toContainText("J K");

  await row.click();
  await expect(page.locator(".detail__title")).toHaveText(titles[2]);
});

test("the feed's own row is the one that shows there", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(
    page.locator(".palette__row", { hasText: "Move through the feed" })
  ).toBeVisible();
  await expect(
    page.locator(".palette__row", { hasText: "Move to the next or previous post" })
  ).toHaveCount(0);
});

// ── the morph is handed on, not shared ─────────────────────────────────────
test("exactly one element carries the morph name when you read on", async ({
  page,
  api,
}) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  await openCard(page, 1);

  const canMorph = await page.evaluate(
    () =>
      typeof document.startViewTransition === "function" &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  test.skip(!canMorph, "no View Transitions here, so there is no name to hand on");

  // The heading holds the name so that going back can reverse. Counted after
  // the link's own handler has run: two elements wearing one
  // view-transition-name is an ambiguous name, and pairOrStrip answers that by
  // dropping the morph entirely.
  await expect.poll(() => page.locator(".detail__title.is-morphing").count()).toBe(1);
  await page.evaluate(() => {
    window.__morphing = null;
    document.addEventListener("click", () => {
      window.__morphing = document.querySelectorAll(".is-morphing").length;
    });
  });

  await page.locator(NEXT).click();
  expect(await page.evaluate(() => window.__morphing)).toBe(1);
});

// ── the list is not left lying about ───────────────────────────────────────
test("signing out takes the list with it", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  // The palette searches whatever list was drawn last, and a list drawn for a
  // signed-in reader can hold that reader's own drafts. "Seeded" matches post
  // titles and none of the actions, so the rows are the list or nothing.
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette__input").fill("Seeded");
  await expect(page.locator(".palette__row")).toHaveCount(3);
  await page.keyboard.press("Escape");

  await signOutViaMenu(page);
  await expect(page.locator(".account")).toContainText("Sign in");

  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette__input").fill("Seeded");
  await expect(page.locator(".palette__empty")).toBeVisible();
});
