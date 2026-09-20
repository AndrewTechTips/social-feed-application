// The composer: what it tells you about what you've written, and what it does
// with it if you leave.
//
// Two changes worth pinning. The counter used to read `1,234 / 5,000`, which is
// a number counting towards a wall; it now reads the post back in the terms the
// card will use, and only mentions the wall when the wall is close. And the
// words are kept as you type, because the app's worst papercut was a mistyped
// address taking a half-written post with it.

const { test, expect, CARD } = require("./support/fixtures");

const EMAIL = "ada@commons.test";
const DRAFT_KEY = "commons.draft";

const title = (page) => page.getByLabel("Title", { exact: true });
const body = (page) => page.getByLabel("Body");
const counter = (page) => page.locator(".counter:not(.counter--limit)");
const limit = (page) => page.locator(".counter--limit");

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

/**
 * Sign in and open a new-post composer.
 *
 * `posts` seeds them *before* signing in, deliberately: in demo mode the page
 * is handed a snapshot of the backend when the session is installed, so
 * anything seeded afterwards exists on the Node side and nowhere the app can
 * see it.
 *
 * The stop at the feed on the way is not decoration either. The demo adapter
 * only puts its control surface on `window` once something has actually gone
 * through it, and `#/compose` makes no requests — so a test that queued a
 * failure straight from the composer would be queueing it against a backend
 * the page is not using yet.
 */
async function composer(page, api, { posts = 0 } = {}) {
  if (posts) await api.seed(posts, EMAIL);
  else await api.register(EMAIL, "seedpassword", "ada");
  await api.signIn(page, EMAIL, "seedpassword");

  await page.goto("/");
  await expect(page.locator(".feed__status")).toBeVisible();

  await page.goto("/#/compose");
  await expect(page.locator(".compose__title")).toBeVisible();
}

const storedDraft = (page, key) =>
  page.evaluate((k) => {
    try {
      return JSON.parse(localStorage.getItem(k) || "null");
    } catch (e) {
      return null;
    }
  }, key);

// ── what it says about what you wrote ──────────────────────────────────────
test("an empty composer counts nothing", async ({ page, api }) => {
  await composer(page, api);

  // Not "0 words". A counter that starts at zero is the app talking about
  // itself before there is anything to talk about.
  await expect(counter(page)).toHaveText("");
  await expect(limit(page)).toBeHidden();
});

test("it counts words and says how long they take to read", async ({ page, api }) => {
  await composer(page, api);

  await body(page).fill("One two three.");
  await expect(counter(page)).toHaveText("3 words, about 1 min");

  // 440 words at 220 a minute is two — the same arithmetic, from the same
  // function, that puts "2 min" on the card.
  await body(page).fill(words(440));
  await expect(counter(page)).toHaveText("440 words, about 2 min");
});

test("one word is a word, not 1 words", async ({ page, api }) => {
  await composer(page, api);
  await body(page).fill("Hello");

  await expect(counter(page)).toHaveText("1 word, about 1 min");
});

test("the character limit shows up only when it is close", async ({ page, api }) => {
  await composer(page, api);

  await body(page).fill("x".repeat(4000));
  await expect(limit(page)).toBeHidden();

  await body(page).fill("x".repeat(4600));
  await expect(limit(page)).toBeVisible();
  await expect(limit(page)).toHaveText("4,600 / 5,000");
  await expect(limit(page)).not.toHaveClass(/counter--over/);

  await body(page).fill("x".repeat(5100));
  await expect(limit(page)).toHaveClass(/counter--over/);
});

// ── and what it keeps ──────────────────────────────────────────────────────
test("what you typed is still there after the page goes away", async ({
  page,
  api,
}) => {
  await composer(page, api);
  await title(page).fill("A half-written thing");
  await body(page).fill("I had got this far when the tab went.");
  await expect.poll(() => storedDraft(page, DRAFT_KEY)).not.toBeNull();

  await page.reload();
  await expect(page.locator(".compose__title")).toBeVisible();

  await expect(title(page)).toHaveValue("A half-written thing");
  await expect(body(page)).toHaveValue("I had got this far when the tab went.");
  await expect(page.locator(".compose__resumed-line")).toHaveText(
    "Picked up where you left off."
  );
});

test("a mistyped address is survivable, which is the whole point", async ({
  page,
  api,
}) => {
  await composer(page, api);
  await title(page).fill("Nearly done");
  await body(page).fill("Three paragraphs of it.");
  await expect.poll(() => storedDraft(page, DRAFT_KEY)).not.toBeNull();

  // Off to an address that isn't a route at all, which is what the router
  // sends home — the fat-fingered hash this whole feature is named after.
  await page.goto("/#/composr");
  await expect(page).toHaveURL(/#\/$/);

  await page.goto("/#/compose");
  await expect(title(page)).toHaveValue("Nearly done");
  await expect(body(page)).toHaveValue("Three paragraphs of it.");
});

test("Start fresh empties the form and forgets the draft", async ({ page, api }) => {
  await composer(page, api);
  await title(page).fill("Second thoughts");
  await body(page).fill("On reflection, no.");
  await expect.poll(() => storedDraft(page, DRAFT_KEY)).not.toBeNull();
  await page.reload();
  await expect(page.locator(".compose__resumed")).toBeVisible();

  await page.getByRole("button", { name: "Start fresh" }).click();

  await expect(title(page)).toHaveValue("");
  await expect(body(page)).toHaveValue("");
  await expect(page.locator(".compose__resumed")).toBeHidden();
  expect(await storedDraft(page, DRAFT_KEY)).toBeNull();

  // And it stays gone.
  await page.reload();
  await expect(page.locator(".compose__resumed")).toBeHidden();
  await expect(title(page)).toHaveValue("");
});

test("an untouched composer offers nothing to pick up", async ({ page, api }) => {
  await composer(page, api);

  await expect(page.locator(".compose__resumed")).toBeHidden();
});

test("deleting what you wrote clears the draft rather than saving a blank", async ({
  page,
  api,
}) => {
  await composer(page, api);
  await body(page).fill("Actually, never mind.");
  await expect.poll(() => storedDraft(page, DRAFT_KEY)).not.toBeNull();

  await body(page).fill("");
  await expect.poll(() => storedDraft(page, DRAFT_KEY)).toBeNull();
});

test("posting it clears the draft", async ({ page, api }) => {
  await composer(page, api);
  await title(page).fill("Ready to go");
  await body(page).fill("And here it is.");
  await expect.poll(() => storedDraft(page, DRAFT_KEY)).not.toBeNull();

  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".detail__title")).toHaveText("Ready to go");

  expect(await storedDraft(page, DRAFT_KEY)).toBeNull();
  await page.goto("/#/compose");
  await expect(page.locator(".compose__resumed")).toBeHidden();
  await expect(title(page)).toHaveValue("");
});

test("a write that doesn't land keeps the words", async ({ page, api }) => {
  // The one path where clearing early would be unforgivable.
  await composer(page, api);
  await title(page).fill("Worth keeping");
  await body(page).fill("Especially when the server says no.");

  await api.failNext({ method: "POST", path: "^/posts/", status: 500 });
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".toast")).toBeVisible();

  await expect(page).toHaveURL(/#\/compose$/);
  expect(await storedDraft(page, DRAFT_KEY)).not.toBeNull();
  await page.reload();
  await expect(title(page)).toHaveValue("Worth keeping");
});

test("editing an existing post does not touch the draft slot", async ({
  page,
  api,
}) => {
  await composer(page, api, { posts: 1 });
  await title(page).fill("Keep me");
  await body(page).fill("I am unfinished.");
  await expect.poll(() => storedDraft(page, DRAFT_KEY)).not.toBeNull();
  // The fields only. Leaving the composer flushes the current text, so the
  // timestamp legitimately moves on the way out; what must not move is what
  // is in it.
  const fields = async () => {
    const d = await storedDraft(page, DRAFT_KEY);
    return d && { title: d.title, content: d.content, published: d.published };
  };
  const kept = await fields();

  // Something else of yours to edit — seeded up front by composer() above.
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.locator(".compose__title")).toHaveText("Edit your post");

  // No offer to restore over the top of a real post, and typing here writes
  // nothing to the slot the new-post composer is holding.
  await expect(page.locator(".compose__resumed")).toBeHidden();
  await body(page).fill("Edited, and this must not be remembered anywhere.");
  await page.waitForTimeout(800);
  expect(await fields()).toEqual(kept);
});
