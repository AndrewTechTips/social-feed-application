// What a visitor to the published site actually gets.
//
// Every other spec starts from an empty database and fills it itself, which is
// the right way to test behaviour but means none of them ever load
// js/demo/seed.json — the content the GitHub Pages link opens on. This one does
// exactly that: no fixture seeding, no injected state, just the page as a
// stranger finds it.
//
// Demo-only, because there is no such thing as "the seed" when the app is
// talking to a real backend.

const { test, expect, CARD } = require("./support/fixtures");
const seed = require("../js/demo/seed.json");

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "demo", "there is no seed without demo mode");
});

const published = seed.posts.filter((p) => p.published !== false);
const draft = seed.posts.find((p) => p.published === false);
const newest = seed.posts.reduce((a, b) => (a.minutes_ago <= b.minutes_ago ? a : b));
const longest = seed.posts.reduce((a, b) =>
  a.content.length >= b.content.length ? a : b
);

test("the published site opens on the seeded feed", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(CARD).first()).toBeVisible();
  await expect(page.locator(CARD)).toHaveCount(10); // one page
  await expect(
    page.getByRole("heading", { name: newest.title }).first()
  ).toBeVisible();

  // Real sentences, not "Seeded post 4" — the first English anyone reads.
  const preview = await page.locator(".card__preview").first().innerText();
  expect(preview.length).toBeGreaterThan(40);
});

test("the seeded feed paginates and ends", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(CARD)).toHaveCount(published.length);
  await expect(page.getByText("That's everything for now.")).toBeVisible();
});

test("the demo says what it is, on every visit", async ({ page }) => {
  await page.goto("/");

  // On the feed the masthead carries it; masthead.spec.js covers which of the
  // two placements wins where. What matters here is that the words are there.
  const notice = page.locator(".demo:visible");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("Demo mode");
  await expect(notice).toContainText("runs entirely in your browser");
  await expect(notice).toContainText("Nothing you post is saved anywhere");
  await expect(notice.getByRole("link", { name: "the API contract" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Reset the demo" })).toBeVisible();
});

test("folding the band is a per-tab convenience, not a dismissal", async ({ page }) => {
  // The band is what can be folded, and it shows anywhere the masthead doesn't.
  await page.goto("/#/login");
  const band = page.locator(".demo--band");
  await expect(band).toBeVisible();

  await band.getByRole("button", { name: /Hide the demo notice/ }).click();
  await expect(band).toHaveClass(/demo--folded/);

  // It must never reach localStorage, or the next visitor inherits a notice
  // they never chose to hide.
  const leaked = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.includes("strip"))
  );
  expect(leaked, "the folded state must not survive the session").toEqual([]);
  expect(
    await page.evaluate(() => sessionStorage.getItem("commons.demo.strip-folded"))
  ).toBe("1");
});

test("a seeded draft belongs to its author", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  // not in the anonymous feed
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(CARD)).toHaveCount(published.length);
  await expect(page.getByRole("heading", { name: draft.title })).toHaveCount(0);

  // but its author sees it, tagged
  const author = seed.users.find((u) => u.email === draft.author);
  await page.goto("/#/login");
  await page.getByLabel("Email").fill(author.email);
  await page.getByLabel("Password", { exact: true }).fill(author.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/#\/$/);

  await expect(page.getByRole("heading", { name: draft.title })).toBeVisible();
  await expect(
    page.locator(CARD, { hasText: draft.title }).locator(".tag")
  ).toHaveText("Draft");
});

test("the long post fills the reading column", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  // It's one of the older posts, so it's on the second page — and cards below
  // the fold carry content-visibility:auto, which means they aren't rendered
  // (or clickable) until they've been scrolled to.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(CARD)).toHaveCount(published.length);

  const heading = page.getByRole("heading", { name: longest.title });
  await heading.scrollIntoViewIfNeeded();
  await heading.click();

  await expect(page.locator(".detail__content")).toContainText(
    longest.content.slice(0, 60)
  );
  const paragraphs = longest.content.split("\n\n").length;
  expect(paragraphs, "the long post should show off the serif column").toBeGreaterThan(3);
});

test("what you write survives a refresh, and Reset puts it back", async ({ page }) => {
  const author = seed.users[0];
  await page.goto("/#/login");
  await page.getByLabel("Email").fill(author.email);
  await page.getByLabel("Password", { exact: true }).fill(author.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/#\/$/);

  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("Left here by a visitor");
  await page.getByLabel("Body").fill("Stored in localStorage, and nowhere else.");
  await page.getByRole("button", { name: "Post" }).click();
  await page.waitForURL(/#\/posts\/\d+$/);

  // a full reload, the thing that would lose it if state were memory-only
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Left here by a visitor" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Reset the demo" }).click();
  await expect(page.locator(CARD).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Left here by a visitor" })
  ).toHaveCount(0);
  // and it signs you out, because the accounts went with the data
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});
