// The feed's keyboard cursor — j, k, Enter, u.
//
// The rule this suite defends is the one the implementation is built on: the
// cursor *is* focus. So the assertions are about where focus is, not about a
// class named "selected" — if those two ever come apart, the convention has
// stopped working for everyone who isn't looking at the screen.

const { test, expect, CARD } = require("./support/fixtures");

const cards = (page) => page.locator(`.feed__list ${CARD}`);

// Which card holds focus, by index. -1 when focus is off the list entirely.
const cursor = (page) =>
  page.evaluate(() => {
    const list = [...document.querySelectorAll(".feed__list .card:not(.card--skeleton)")];
    const card = document.activeElement && document.activeElement.closest(".card");
    return card ? list.indexOf(card) : -1;
  });

test.beforeEach(async ({ page, api }) => {
  await api.seed(4, "ada@commons.test");
  await page.goto("/");
  await expect(cards(page).first()).toBeVisible();
});

test("j walks down the feed and k walks back up", async ({ page }) => {
  expect(await cursor(page)).toBe(-1);

  await page.keyboard.press("j");
  expect(await cursor(page)).toBe(0);
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  expect(await cursor(page)).toBe(2);

  await page.keyboard.press("k");
  expect(await cursor(page)).toBe(1);
});

test("the cursor is focus, not a class of its own", async ({ page }) => {
  await page.keyboard.press("j");
  // The focused thing is the card's link — which is why Enter needs no
  // handler and a screen reader is told where it is.
  await expect(cards(page).first().locator(".card__link")).toBeFocused();
});

test("it stops at both ends rather than wrapping", async ({ page }) => {
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  expect(await cursor(page), "k at the top should stay at the top").toBe(0);

  const last = (await cards(page).count()) - 1;
  for (let i = 0; i < last + 3; i++) await page.keyboard.press("j");
  expect(await cursor(page), "j at the bottom should stay at the bottom").toBe(last);
});

test("Enter opens whatever the cursor is on", async ({ page }) => {
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  const title = (await cards(page).nth(1).locator(".card__title").textContent()).trim();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  await expect(page.locator(".detail__title")).toHaveText(title);
});

test("u upvotes the card under the cursor", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(cards(page).first()).toBeVisible();

  const vote = cards(page).first().locator(".vote");
  await expect(vote).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("j");
  await page.keyboard.press("u");

  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await expect(vote.locator(".vote__count")).toHaveText("1");
  // The request went through the same control a click would have used.
  await expect(vote).toHaveAttribute("aria-busy", "false");

  // And it's a toggle, exactly as the button is.
  await page.keyboard.press("u");
  await expect(vote).toHaveAttribute("aria-pressed", "false");
});

test("u does nothing with no cursor on the list", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(cards(page).first()).toBeVisible();

  await page.keyboard.press("u");
  await expect(cards(page).first().locator(".vote")).toHaveAttribute("aria-pressed", "false");
});

test("the keys keep out of the way while you're typing", async ({ page }) => {
  const search = page.locator("#search-input");
  await search.click();
  await search.type("jukebox");

  await expect(search).toHaveValue("jukebox");
  expect(await cursor(page), "nothing should have taken the cursor").toBe(-1);
});

test("and out of the way of the palette", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette__panel")).toBeVisible();

  await page.keyboard.press("j");
  await expect(page.locator(".palette__input")).toHaveValue("j");
  expect(await cursor(page)).toBe(-1);
});

test("it picks up from what's on screen, not from the top", async ({ page, api }) => {
  await api.reset();
  await api.seed(10, "ada@commons.test");
  await page.goto("/");
  await expect(cards(page)).toHaveCount(10);

  // Scroll past the first cards, then start the cursor: landing back at the
  // top of a list you have already scrolled past is the thing this avoids.
  await page.evaluate(() => window.scrollTo(0, 1400));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);

  await page.keyboard.press("j");
  expect(await cursor(page)).toBeGreaterThan(0);
});

test("it carries on into a page that loaded while you walked", async ({ page, api }) => {
  await api.reset();
  await api.seed(14, "ada@commons.test");
  await page.goto("/");
  await expect(cards(page)).toHaveCount(10); // one page

  for (let i = 0; i < 10; i++) await page.keyboard.press("j");
  expect(await cursor(page)).toBe(9);

  // The cards are read out of the DOM on each press, so the second page —
  // fetched by the sentinel while the cursor walked towards it — is simply
  // there to be walked onto. No bookkeeping, nothing to keep in step.
  await expect.poll(() => cards(page).count()).toBeGreaterThan(10);
  await page.keyboard.press("j");
  expect(await cursor(page)).toBe(10);
});

test("a profile is the same list, so it takes the same keys", async ({ page, api }) => {
  await page.goto("/#/u/ada");
  // Wait for the profile itself, not just for a card: until it has mounted,
  // the cards on screen are still the feed's.
  await expect(page.locator(".profile__name")).toHaveText("ada");
  await expect(cards(page).first()).toBeVisible();

  await page.keyboard.press("j");
  expect(await cursor(page)).toBe(0);
  await page.keyboard.press("j");
  expect(await cursor(page)).toBe(1);
});

test("the palette advertises it, and the row starts it", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  const row = page.locator(".palette__row", { hasText: "Move through the feed" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".palette__key")).toHaveText("J K");

  await page.locator(".palette__input").fill("move through");
  await page.keyboard.press("Enter");

  await expect(page.locator(".palette")).toBeHidden();
  await expect.poll(() => cursor(page)).toBe(0);
});

test("and doesn't advertise it where there's no list", async ({ page, api }) => {
  const { created } = await (await api.seed(1, "ada@commons.test")).json();
  await page.goto(`/#/posts/${created[0]}`);
  await expect(page.locator(".detail__title")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette__row", { hasText: "Move through the feed" })).toHaveCount(0);
});
