// Searching the feed.
//
// The API behind this is a Postgres tsvector with a GIN index; the two
// stand-ins approximate it in about sixty lines each. These specs run against
// both, which is the only thing keeping the approximation honest — a demo
// where search behaves differently from the API is a demo that lies about the
// feature it is demonstrating.

const { test, expect, CARD, usernameFor } = require("./support/fixtures");

// Every test takes `api` even where it never calls it: asking for that fixture
// is what wipes the target between tests. Without it the posts written by the
// test before are still on the shelf, and a search that should find one thing
// finds two.

const password = "hunter2pw";
const uniqueEmail = (tag) =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@commons.test`;

async function register(page, email) {
  await page.goto("/#/register");
  await page.getByLabel("Username").fill(usernameFor(email));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/#\/$/);
}

async function write(page, title, body, { draft = false } = {}) {
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Body").fill(body);
  if (draft) {
    await page.getByText("Publish now").click();
    await expect(page.getByText("Save as a draft")).toBeVisible();
  }
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
}

/** The three-post shelf every test below searches. */
async function shelf(page) {
  await write(
    page,
    "Notes on repairing a kettle",
    "The element had gone, which I'm told is the usual thing."
  );
  await write(
    page,
    "The good mug",
    "Nine mugs in the cupboard and one of them is the good one. " +
      "I repaired the handle of another once."
  );
  await write(
    page,
    "Cold water, six in the morning",
    "The hard part isn't the water. It's the eleven minutes between the alarm."
  );
}

async function search(page, term) {
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator("#search-input").fill(term);
  if (term) await expect(page).toHaveURL(/search=/);
}

const headings = (page) => page.locator(`${CARD} .card__title`);

test("a word that's only in the body finds the post", async ({ page, api }) => {
  await register(page, uniqueEmail("writer"));
  await shelf(page);

  // "element" is in no title at all. Under the old title-only LIKE this post
  // could not be found by the word that says what it's about.
  await search(page, "element");
  await expect(headings(page)).toHaveText(["Notes on repairing a kettle"]);
});

test("any form of a word finds every other form", async ({ page, api }) => {
  await register(page, uniqueEmail("writer"));
  await shelf(page);

  // "repairing" is in a title, "repaired" in a different body. They share a
  // stem, so either one typed into the box turns up both.
  for (const term of ["repair", "repairing", "repaired"]) {
    await search(page, term);
    await expect(page.locator(CARD)).toHaveCount(2);
  }
});

test("a plural finds a singular", async ({ page, api }) => {
  await register(page, uniqueEmail("writer"));
  await shelf(page);

  await search(page, "kettles");
  await expect(headings(page)).toHaveText(["Notes on repairing a kettle"]);
});

test("a title match sits above a body match", async ({ page, api }) => {
  await register(page, uniqueEmail("writer"));
  await write(page, "Sourdough", "Nothing about bread here at all.");
  await write(page, "A morning routine", "It mostly involves sourdough, if I'm honest.");

  // setweight is what earns this: the title is stamped 'A' and the body 'B',
  // which is the difference ts_rank reads.
  await search(page, "sourdough");
  await expect(headings(page)).toHaveText(["Sourdough", "A morning routine"]);
});

test("two words narrow the search rather than widening it", async ({ page, api }) => {
  await register(page, uniqueEmail("writer"));
  await shelf(page);

  await search(page, "water");
  await expect(page.locator(CARD)).toHaveCount(1);

  await search(page, "water alarm");
  await expect(page.locator(CARD)).toHaveCount(1);

  await search(page, "water kettle");
  await expect(page.locator(".feed__status")).toContainText("Nothing matches");
});

test("a wildcard is a character, not a wildcard", async ({ page, api }) => {
  await register(page, uniqueEmail("writer"));
  await shelf(page);

  // `%` used to be a live LIKE metacharacter. It's now a character with no
  // word in it, so the query says nothing and the feed comes back whole —
  // which is also what an empty box does.
  await search(page, "%");
  await expect(page.locator(CARD)).toHaveCount(3);
});

test("searching never turns up somebody else's draft", async ({ page, api }) => {
  await register(page, uniqueEmail("author"));
  await write(page, "Beekeeping in secret", "Not finished yet.", { draft: true });

  // the author can find their own
  await search(page, "beekeeping");
  await expect(page.locator(CARD)).toHaveCount(1);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await register(page, uniqueEmail("stranger"));
  await write(page, "Something else entirely", "So the feed isn't empty.");

  await search(page, "beekeeping");
  await expect(page.locator(".feed__status")).toContainText("Nothing matches");
});


// ── the sentence it matched on ─────────────────────────────────────────────
//
// A result that shows *why* it is a result is worth more than the first 280
// characters of it. The API answers with `excerpt`, marked up in two control
// characters; ui.js splits on them and builds real <mark> elements, and the
// last test here is the reason that distinction is not decoration.

const EXCERPT = ".card__preview--excerpt";

test("a result shows the sentence it matched on, with the word marked", async ({
  page,
  api,
}) => {
  const email = uniqueEmail("excerpt");
  await register(page, email);
  await write(
    page,
    "Notes on a repair",
    "The handle came away in my hand on a Tuesday. I took the kettle apart " +
      "on the kitchen table and found one screw doing the work of three."
  );

  await page.goto("/#/?search=kettle");
  await expect(page.locator(CARD)).toHaveCount(1);

  const excerpt = page.locator(EXCERPT);
  await expect(excerpt).toBeVisible();
  await expect(excerpt.locator("mark")).toHaveText("kettle");
  // The part of the post that answers the question, not its opening words.
  await expect(excerpt).toContainText("kitchen table");
});

test("the mark follows the stem, not the letters", async ({ page, api }) => {
  const email = uniqueEmail("stemmark");
  await register(page, email);
  await write(page, "A repair", "I took the kettle apart and put it back together.");

  await page.goto("/#/?search=kettles");
  await expect(page.locator(CARD)).toHaveCount(1);
  await expect(page.locator(`${EXCERPT} mark`)).toHaveText("kettle");
});

test("no question, no excerpt — the card shows the post's opening", async ({
  page,
  api,
}) => {
  const email = uniqueEmail("noexcerpt");
  await register(page, email);
  await write(page, "A repair", "I took the kettle apart and put it back together.");

  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);
  await expect(page.locator(EXCERPT)).toHaveCount(0);
  await expect(page.locator(".card__preview")).toContainText("I took the kettle");
  await expect(page.locator(".card mark")).toHaveCount(0);
});

test("the excerpt is text, and is never parsed as markup", async ({ page, api }) => {
  // The one that matters. `excerpt` is somebody's post passed through a
  // Postgres function that is not a sanitiser and never claimed to be — it
  // drops part of a tag and leaves the rest, closing bracket and all. What
  // stops that being a stored-XSS hole with a search box in front of it is
  // that ui.js splits the string and appends text nodes, and that the markers
  // are control characters so nothing is tempted to parse them.
  const email = uniqueEmail("inert");
  await register(page, email);
  await write(
    page,
    "Nasty",
    'Before this. <img src=x onerror=alert(1)> A kettle, after this.'
  );

  await page.goto("/#/?search=kettle");
  await expect(page.locator(CARD)).toHaveCount(1);
  await expect(page.locator(`${EXCERPT} mark`)).toHaveText("kettle");

  // The precise statement: the only element an excerpt may contain is a mark.
  // Anything else in there was parsed out of somebody's post, whatever tag it
  // happens to be.
  await expect(page.locator(`${EXCERPT} *:not(mark)`)).toHaveCount(0);
  // And nothing landed elsewhere in the document either. Deliberately not
  // `svg` or `script`: the brand, the icons and the vote caret are all svg,
  // and index.html carries two scripts of its own. These four the app never
  // creates at all, so one appearing could only have been parsed out of text.
  await expect(page.locator("img, iframe, object, embed")).toHaveCount(0);
  // The payload did reach the page, as characters.
  await expect(page.locator(EXCERPT)).toContainText("onerror");
});
