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
const selected = (page) =>
  page.locator('.palette__row[aria-selected="true"] .palette__label');

test.beforeEach(async ({ page, api }) => {
  await api.seed(4, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
});

test("opens on the shortcut, closes on Escape, and hands focus back", async ({
  page,
}) => {
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

test("filters the posts already on screen, without asking the server", async ({
  page,
}) => {
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

  await expect
    .poll(() => page.evaluate(() => window.__copied))
    .toContain(`#/posts/${created[0]}`);
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

// ── the numbered rows ──────────────────────────────────────────────────────
// ⌥1 to ⌥5 run the first five rows. Alt rather than a bare digit, because this
// is a text field and a bare digit would take the first character of every
// search that begins with a number.

test("the first five rows carry a number, and the rest do not", async ({ page }) => {
  await open(page);

  // Read what is painted, not what is in the DOM: past the fifth row the
  // element is still there — it holds the indent so the labels stay in one
  // column — and `visibility: hidden` is what makes it not a number.
  const shown = await page
    .locator(".palette__ordinal")
    .evaluateAll((els) =>
      els.map((el) =>
        getComputedStyle(el).visibility === "hidden" ? null : el.textContent
      )
    );
  expect(shown.length).toBeGreaterThan(5);
  expect(shown.slice(0, 5)).toEqual(["⌥1", "⌥2", "⌥3", "⌥4", "⌥5"]);
  expect(shown.slice(5).every((v) => v === null)).toBe(true);
});

test("pressing one runs that row", async ({ page }) => {
  await open(page);
  // Whatever the third row happens to be, rather than hard-coding a command
  // that may move: the promise is that the number and the row agree.
  const third = await page.locator(".palette__label").nth(2).textContent();
  expect(third).toBe("Go to the feed");

  await page.keyboard.press("Alt+Digit3");
  await expect(page.locator(".palette__panel")).toBeHidden();
  await expect(page).toHaveURL(/#\/$/);
});

test("a digit on its own is still just a digit", async ({ page }) => {
  // The whole reason the shortcut takes a modifier. Typing a number has to
  // search for it, or no post whose title starts with one is reachable here.
  await open(page);
  await page.keyboard.type("3");

  await expect(page.locator(".palette__input")).toHaveValue("3");
  await expect(page.locator(".palette__panel")).toBeVisible();
});

test("a number past the end of the list does nothing at all", async ({ page }) => {
  await open(page);
  await page.locator(".palette__input").fill("Go to the feed");
  await expect(rows(page)).toHaveCount(1);

  await page.keyboard.press("Alt+Digit4");

  // Not wrapped around to the one row that is there, and not closed. Running
  // it would have closed the palette, so the panel still being up is the
  // assertion — the URL is no use here, because the row leads to the feed and
  // the feed is where this test already is.
  await expect(page.locator(".palette__panel")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  // And the keystroke was swallowed rather than typed into the box.
  await expect(page.locator(".palette__input")).toHaveValue("Go to the feed");
});

test("the numbers follow the results rather than the commands", async ({ page }) => {
  await open(page);
  await page.locator(".palette__input").fill("Open your shelf");
  await expect(rows(page)).toHaveCount(1);

  // It was the fourth row a moment ago; filtered down it is the first, and ⌥1
  // is what runs it.
  await page.keyboard.press("Alt+Digit1");
  await expect(page).toHaveURL(/#\/shelf$/);
});
