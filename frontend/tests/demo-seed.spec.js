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
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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

test("the long post opens on a conversation, not an empty state", async ({ page }) => {
  const onLongest = seed.comments.filter((c) => seed.posts[c.post - 1] === longest);
  expect(
    onLongest.length,
    "the seed should demonstrate comments on the post people actually open"
  ).toBeGreaterThan(2);

  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(CARD)).toHaveCount(published.length);

  const heading = page.getByRole("heading", { name: longest.title });
  await heading.scrollIntoViewIfNeeded();
  await heading.click();

  await expect(page.locator(".comment")).toHaveCount(onLongest.length);
  await expect(page.locator(".comments__count")).toHaveText(String(onLongest.length));
  // Oldest first, and written by people who exist in the seed.
  await expect(page.locator(".comment__text").first()).toHaveText(onLongest[0].content);
  const names = seed.users.reduce(
    (map, u) => Object.assign(map, { [u.email]: u.username }),
    {}
  );
  await expect(page.locator(".comment__author").first()).toHaveText(
    names[onLongest[0].author]
  );

  // A stranger can read the thread but has nothing to write with.
  await expect(page.getByLabel("Add a comment")).toHaveCount(0);
});

test("what you write survives a refresh, and Reset puts it back", async ({ page }) => {
  const author = seed.users[0];
  await page.goto("/#/login");
  await page.getByLabel("Email").fill(author.email);
  await page.getByLabel("Password", { exact: true }).fill(author.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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

// ── somebody who has been here a while ─────────────────────────────────────
// The published site has one visitor and nobody else awake. You cannot be
// notified by yourself, so a freshly registered account would find the lamp
// unlit for ever — which would make a feature that works on both backends
// invisible on the one deployment most people will ever open.
//
// So the seeded comments carry the notifications they would have caused, and
// the demo offers to sign you in as one of the people who received them.

/** The two rules the API applies, run over seed.json — the expected answer. */
const seededFor = (email) =>
  seed.comments.filter((c, i) => {
    const recipient =
      c.reply_to != null
        ? seed.comments[c.reply_to - 1]?.author
        : seed.posts[c.post - 1]?.author;
    return recipient === email && recipient !== c.author;
  });

const JO = "j.okafor@example.com";

test("the demo offers to sign you in as one of the people here", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  const offer = page.getByRole("button", { name: "Sign in as Jo" });
  await expect(offer).toBeVisible();

  await offer.click();

  await expect(page.locator(".account__email")).toHaveText("jokafor");
  await expect(page).toHaveURL(/#\/$/);
  // And the offer goes, because offering to make you somebody else while you
  // are already someone is a way to lose a half-written post.
  await expect(offer).toBeHidden();
});

test("that person has the notifications their conversation caused", async ({ page }) => {
  const expected = seededFor(JO);
  // Not a hard-coded number: if seed.json's conversation changes, the rules
  // still say what the answer should be. But it must not be zero, or this test
  // would pass on an app that seeds nothing at all.
  expect(expected.length).toBeGreaterThan(0);

  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign in as Jo" }).click();
  await expect(page.locator(".account__email")).toHaveText("jokafor");

  await expect(page.locator(".lamp__count")).toHaveText(String(expected.length));

  await page.goto("/#/notifications");
  await expect(page.locator(".notice")).toHaveCount(expected.length);
  // Both kinds, which is why this is the person the demo offers.
  await expect(page.locator(".notice__who", { hasText: "replied to you" })).toHaveCount(
    expected.filter((c) => c.reply_to != null).length
  );
  await expect(
    page.locator(".notice__who", { hasText: "commented on your post" })
  ).toHaveCount(expected.filter((c) => c.reply_to == null).length);
});

test("they are derived, not invented — nobody is notified by themselves", async ({
  page,
}) => {
  // The seed contains a comment somebody left on their own post. A seeded list
  // written by hand would have to remember to leave it out; one derived from
  // the same rule as the API cannot include it.
  const selfTalk = seed.comments.filter(
    (c) => c.reply_to == null && seed.posts[c.post - 1]?.author === c.author
  );
  test.skip(selfTalk.length === 0, "the seed has nobody talking to themselves");

  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign in as Jo" }).click();
  await expect(page.locator(".account__email")).toHaveText("jokafor");
  await page.goto("/#/notifications");

  const said = await page.locator(".notice__said").allTextContents();
  for (const c of selfTalk) {
    expect(said).not.toContain(c.content);
  }
});

test("the colophon says the staging is staged", async ({ page }) => {
  await page.goto("/#/colophon");

  const honest = page.locator(".colophon__section", { hasText: "What's honest" });
  await expect(honest).toContainText("worked out from the seeded comments");
  await expect(honest).toContainText("cannot be notified by yourself");
});
