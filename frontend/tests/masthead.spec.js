// The block that opens the feed for people who haven't signed in.
//
// Two things matter and both are easy to lose: it's for strangers only, and in
// demo mode it carries the demo notice — so the notice has to be said exactly
// once on that screen, not twice in two stacked banners.

const {
  test,
  expect,
  CARD,
  accountButton,
  signOutViaMenu,
} = require("./support/fixtures");

const feed = async (page) => {
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
};

test.beforeEach(async ({ api }) => {
  await api.seed(3, "ada@commons.test");
});

test("greets a stranger, quietly", async ({ page }) => {
  await feed(page);

  const masthead = page.locator(".masthead");
  await expect(masthead).toBeVisible();
  await expect(masthead.locator("h1")).toHaveText("A small public common.");
  await expect(masthead.locator(".masthead__line")).toContainText("Anyone can read");

  // No hero, no gradient, no call to action shouting at someone already reading.
  await expect(masthead.locator("img")).toHaveCount(0);
  await expect(masthead.locator(".btn--primary")).toHaveCount(0);
});

test("it's the page's h1, and the posts sit under it", async ({ page }) => {
  await feed(page);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator(".masthead")).toBeVisible();
  await expect(page.locator(".card__title").first()).toBeVisible(); // h2s
});

test("gone once you've signed in", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await feed(page);
  await expect(accountButton(page)).toBeVisible();
  await expect(page.locator(".masthead")).toHaveCount(0);
});

test("comes back when you sign out again", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await feed(page);
  await expect(page.locator(".masthead")).toHaveCount(0);

  await signOutViaMenu(page);
  await expect(page.locator(CARD).first()).toBeVisible();
  await expect(page.locator(".masthead")).toBeVisible();
});

test("out of the way while you're searching for something", async ({ page }) => {
  await feed(page);
  await expect(page.locator(".masthead")).toBeVisible();

  await page.locator("#search-input").fill("Seeded post 2");
  await expect(page).toHaveURL(/search=/);
  await expect(page.locator(CARD)).toHaveCount(1);
  await expect(page.locator(".masthead")).toHaveCount(0);
});

test("only on the feed", async ({ page }) => {
  await page.goto("/#/login");
  await expect(page.locator(".auth__card")).toBeVisible();
  await expect(page.locator(".masthead")).toHaveCount(0);
});

// ── how it shares the screen with the demo notice ──────────────────────────
test.describe("in demo mode", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "demo", "there is no notice to carry");
  });

  test("the masthead carries the notice, and says it once", async ({ page }) => {
    await feed(page);

    await expect(page.locator(".masthead .demo--inline")).toBeVisible();
    await expect(page.locator(".demo--band")).toBeHidden();
    // The sentence appears exactly once on screen.
    await expect(page.locator(".demo__text:visible")).toHaveCount(1);
    await expect(page.locator(".masthead")).toContainText("Demo mode");
  });

  test("the band takes over on every other screen", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator(".auth__card")).toBeVisible();

    await expect(page.locator(".demo--band")).toBeVisible();
    await expect(page.locator(".demo__text:visible")).toHaveCount(1);
  });

  test("and takes over again once you're signed in", async ({ page, api }) => {
    await api.signIn(page, "ada@commons.test", "seedpassword");
    await feed(page);

    await expect(page.locator(".masthead")).toHaveCount(0);
    await expect(page.locator(".demo--band")).toBeVisible();
    await expect(page.locator(".demo__text:visible")).toHaveCount(1);
  });

  test("Reset the demo is reachable from the masthead", async ({ page }) => {
    await feed(page);
    await expect(
      page.locator(".masthead").getByRole("button", { name: "Reset the demo" })
    ).toBeVisible();
  });
});
