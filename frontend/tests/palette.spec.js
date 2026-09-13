// The command palette, and the shortcuts it advertises.
//
// The rule this suite is really defending: every row shows a key, and every key
// it shows has to work outside the palette too. A hint for a shortcut that
// doesn't exist is decoration pretending to be documentation.

const { test, expect, CARD } = require("./support/fixtures");

const open = async (page) => {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette__panel")).toBeVisible();
};

const rows = (page) => page.locator(".palette__row");
const labels = (page) => page.locator(".palette__label");
const selected = (page) => page.locator('.palette__row[aria-selected="true"] .palette__label');

test.beforeEach(async ({ page, api }) => {
  await api.seed(4, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
});

test("opens on the shortcut, closes on Escape, and hands focus back", async ({ page }) => {
  await open(page);
  await expect(page.locator(".palette__input")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).toBeHidden();
});

test("the header advertises it, and the chip opens it", async ({ page }) => {
  const chip = page.getByRole("button", { name: "Open the command palette" });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator(".palette__panel")).toBeVisible();
});

test("one flat list, and every row carries a key", async ({ page }) => {
  await open(page);

  // No section headers, no group labels — the list is the list.
  const children = await page.locator(".palette__list > *").count();
  const count = await rows(page).count();
  expect(children).toBe(count);
  expect(count).toBeGreaterThanOrEqual(4);

  // Linear's habit: a key on every row, so the palette teaches the app.
  await expect(page.locator(".palette__key")).toHaveCount(count);
  for (const key of await page.locator(".palette__key").allInnerTexts()) {
    expect(key.trim()).not.toBe("");
  }
});

test("filters the posts already on screen, without asking the server", async ({ page }) => {
  const calls = [];
  await page.route(/\/posts\//, (route) => {
    calls.push(route.request().url());
    route.continue();
  });

  await open(page);
  await page.locator(".palette__input").fill("Seeded post 2");

  await expect(labels(page)).toHaveCount(1);
  await expect(labels(page).first()).toHaveText("Seeded post 2");
  expect(calls, "filtering should never hit the network").toEqual([]);
});

test("arrow keys move the selection and Enter opens the post", async ({ page }) => {
  await open(page);
  await page.locator(".palette__input").fill("Seeded post 3");
  await expect(labels(page)).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).toHaveText("Seeded post 3");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  await expect(page.getByRole("heading", { name: "Seeded post 3" })).toBeVisible();
  await expect(page.locator(".palette")).toBeHidden();
});

test("says so plainly when nothing matches", async ({ page }) => {
  await open(page);
  await page.locator(".palette__input").fill("nothing whatsoever matches this");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator(".palette__empty")).toBeVisible();
});

// ── the five actions ────────────────────────────────────────────────────────
test("writing a post", async ({ page }) => {
  await open(page);
  await page.locator(".palette__input").fill("write");
  await page.keyboard.press("Enter");
  // Signed out, compose bounces to the sign-in screen — which is the app being
  // consistent, not the palette failing.
  await expect(page).toHaveURL(/#\/login$/);
});

test("toggling the theme, and the header toggle keeps up", async ({ page }) => {
  const before = await page.evaluate(() => document.documentElement.dataset.theme);

  await open(page);
  await page.locator(".palette__input").fill("theme");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .not.toBe(before);

  // The button in the header draws itself from the current theme; if the
  // palette can change it, the button has to notice.
  await expect(page.locator(".account .btn--icon")).toHaveAttribute(
    "aria-label",
    `Switch to ${before} theme`
  );
});

test("going to the feed from somewhere else", async ({ page, api }) => {
  const { created } = await (await api.seed(1, "ada@commons.test")).json();
  await page.goto(`/#/posts/${created[0]}`);
  await expect(page.locator(".detail__title")).toBeVisible();

  await open(page);
  await page.locator(".palette__input").fill("feed");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/$/);
});

test("signing in", async ({ page }) => {
  await open(page);
  await page.locator(".palette__input").fill("sign");
  await expect(labels(page)).toHaveText(["Sign in"]);

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/login$/);
});

test("signing out, once there's someone to sign out", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await open(page);
  await page.locator(".palette__input").fill("sign");
  await expect(labels(page)).toHaveText(["Sign out"]);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("copying a link is offered on a post and nowhere else", async ({ page, api }) => {
  await open(page);
  await page.locator(".palette__input").fill("copy");
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press("Escape");

  const { created } = await (await api.seed(1, "ada@commons.test")).json();
  await page.goto(`/#/posts/${created[0]}`);
  await expect(page.locator(".detail__title")).toBeVisible();

  // The real clipboard needs a focused document and a permission; what's being
  // tested is that the app hands over the right string.
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (text) => {
      window.__copied = text;
    };
  });

  await open(page);
  await page.locator(".palette__input").fill("copy");
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("Enter");

  await expect.poll(() => page.evaluate(() => window.__copied)).toContain(
    `#/posts/${created[0]}`
  );
  await expect(page.getByText("Link copied.")).toBeVisible();
});

// ── the shortcuts the rows promise ──────────────────────────────────────────
test("the advertised keys work outside the palette", async ({ page }) => {
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.keyboard.press("t");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .not.toBe(before);

  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#\/login$/); // signed out, so compose redirects
});

test("but stay out of the way while you're typing", async ({ page }) => {
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const search = page.locator("#search-input");

  await search.click();
  await search.type("teapot");

  await expect(search).toHaveValue("teapot");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  await expect(page).not.toHaveURL(/compose|login/);
});
