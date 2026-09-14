// Usernames, profiles, and knowing whose posts are whose.
//
// The one that matters most is the last block. Signing in hands back a token
// and nothing else; the feed no longer carries anyone's email to match on. So a
// browser that has never been here before has to *ask* who it just signed in
// as, or it can't tell your posts from anyone else's — and it would find out by
// showing you an Edit button that 403s.

const { test, expect, CARD, usernameFor } = require("./support/fixtures");

const PW = "hunter2pw";
const unique = (tag) => `${tag}-${Date.now()}@commons.test`;

async function register(page, email, username) {
  await page.goto("/#/register");
  await page.getByLabel("Username").fill(username || usernameFor(email));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/#\/$/);
}

async function write(page, title) {
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Body").fill("Something to put a name on.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  return page.url().match(/#\/posts\/(\d+)$/)[1];
}

// ── the form ────────────────────────────────────────────────────────────────
test("registering asks for a name, and holds you to the rule", async ({ page }) => {
  await page.goto("/#/register");
  const username = page.getByLabel("Username");
  await expect(username).toBeVisible();

  await username.fill("ab"); // too short
  await page.getByLabel("Email").fill(unique("short"));
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/#\/register$/);
  await expect(page.locator("#username-err")).not.toBeEmpty();
});

test("a taken username is named as the problem, not the email", async ({ page, api }) => {
  await api.register("firsthere@commons.test", PW, "contested");

  await page.goto("/#/register");
  await page.getByLabel("Username").fill("contested");
  await page.getByLabel("Email").fill(unique("second")); // a free address
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.locator("#username-err")).toContainText("taken");
  await expect(page.locator("#email-err")).toBeEmpty();
});

// ── the name is what's shown ────────────────────────────────────────────────
test("nobody's address is on screen", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  const email = unique("writer");
  await register(page, email, "writerhere");
  await write(page, "A post with a byline");

  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();

  const authors = await page.locator(".card__author").allTextContents();
  expect(authors.length).toBeGreaterThan(0);
  for (const name of authors) expect(name).not.toContain("@");

  // and the header names you, not your address
  await expect(page.locator(".account__email")).toHaveText("writerhere");
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);
});

// ── profiles ───────────────────────────────────────────────────────────────
test("an author's name opens everything they've written", async ({ page, api }) => {
  await api.seed(2, "ada@commons.test");
  await register(page, unique("owner"), "ownerhere");
  await write(page, "Mine, the first");
  await write(page, "Mine, the second");

  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(".card__author", { hasText: "ownerhere" }).first().click();

  await expect(page).toHaveURL(/#\/u\/ownerhere$/);
  await expect(page.locator(".profile__name")).toHaveText("ownerhere");
  await expect(page.locator(".profile__count")).toContainText("2 posts");

  // only theirs, nobody else's
  const authors = await page.locator(".card__author").allTextContents();
  expect(new Set(authors)).toEqual(new Set(["ownerhere"]));
  await expect(page.locator(CARD)).toHaveCount(2);
});

test("a profile paginates like the feed", async ({ page, api }) => {
  await api.seed(14, "ada@commons.test");
  await page.goto("/#/u/ada");

  await expect(page.locator(CARD)).toHaveCount(10); // one page
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(CARD)).toHaveCount(14);
  await expect(page.getByText("That's everything.")).toBeVisible();
});

test("a name nobody has says so", async ({ page }) => {
  await page.goto("/#/u/nobodyhere");
  await expect(page.getByText(/nobody here called nobodyhere/i)).toBeVisible();
});

test("a profile keeps that person's drafts to themselves", async ({ page, api }) => {
  await register(page, unique("drafter"), "drafterhere");

  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("Not finished");
  await page.getByLabel("Body").fill("Still thinking.");
  await page.getByText("Publish now").click(); // toggle to draft
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);

  // the author sees it on their own profile
  await page.goto("/#/u/drafterhere");
  await expect(page.getByRole("heading", { name: "Not finished" })).toBeVisible();

  // ...and a stranger doesn't
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await page.goto("/#/u/drafterhere");
  await expect(page.getByRole("heading", { name: "Not finished" })).toHaveCount(0);
});

// ── who am I, on a browser that has never been here ────────────────────────
test.describe("signing in somewhere new", () => {
  test("a plain login still knows which posts are yours", async ({ browser, api }, testInfo) => {
    // Real-backend only, and not because of a limitation worth working around:
    // in demo mode the accounts live in the browser that made them, so a second
    // browser has nobody to sign in as. "Somewhere new" only means something
    // when the account is somewhere else.
    test.skip(
      testInfo.project.name === "demo",
      "the demo's accounts live in this browser"
    );

    await api.seed(2, "ada@commons.test");

    // Write something, in one browser.
    const first = await browser.newContext();
    const p1 = await first.newPage();
    const email = unique("returning");
    await register(p1, email, "returninghere");
    const postId = await write(p1, "Written before signing in elsewhere");
    await first.close();

    // Now arrive somewhere with no local history at all and *sign in* — not
    // register, which is the path that used to hand the client its identity by
    // accident.
    const second = await browser.newContext();
    const p2 = await second.newPage();
    await p2.goto("/#/login");
    await p2.getByLabel("Email").fill(email);
    await p2.getByLabel("Password", { exact: true }).fill(PW);
    await p2.getByRole("button", { name: "Sign in" }).click();
    await expect(p2).toHaveURL(/#\/$/);

    // The session has to carry an identity, not just a key.
    const session = await p2.evaluate(() =>
      JSON.parse(localStorage.getItem("commons.session"))
    );
    expect(session.id, "a token alone can't answer 'which posts are mine'").toBeTruthy();
    expect(session.username).toBe("returninghere");

    await p2.goto(`/#/posts/${postId}`);
    await expect(p2.getByRole("link", { name: "Edit" })).toBeVisible();
    await second.close();
  });

  test("and doesn't offer to edit somebody else's", async ({ browser, api }) => {
    const { created } = await (await api.seed(1, "ada@commons.test")).json();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await register(page, unique("stranger"), "strangerhere");

    await page.goto(`/#/posts/${created[0]}`);
    await expect(page.locator(".detail__title")).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await ctx.close();
  });
});
