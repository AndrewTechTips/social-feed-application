// Drafts are private to their author.
//
// The feed used to filter on the search term and nothing else, so a post saved
// with the publish toggle off was still served to everyone, signed in or not —
// while the UI cheerfully labelled it "Draft". These tests walk that from the
// outside: write one, then look for it as someone else.

const { test, expect, CARD, usernameFor } = require("./support/fixtures");

const password = "hunter2pw";
const uniqueEmail = (tag) => `${tag}-${Date.now()}@commons.test`;

async function register(page, email) {
  await page.goto("/#/register");
  await page.getByLabel("Username").fill(usernameFor(email));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/#\/$/);
}

async function writeDraft(page, title) {
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Body").fill("Not finished yet.");
  await page.getByText("Publish now").click(); // toggle off -> "Save as a draft"
  await expect(page.getByText("Save as a draft")).toBeVisible();
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  return page.url().match(/#\/posts\/(\d+)$/)[1];
}

test("your draft is in your feed but nobody else's", async ({ page, api }) => {
  await api.seed(2, "ada@commons.test");
  const author = uniqueEmail("author");
  await register(page, author);

  const draftId = await writeDraft(page, "A quiet draft");

  // the author sees it, tagged as a draft
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "A quiet draft" })).toBeVisible();
  // .tag, not getByText("Draft") — the title contains the word "draft" too.
  const draftCard = page.locator(CARD, { hasText: "A quiet draft" });
  await expect(draftCard.locator(".tag")).toHaveText("Draft");

  // sign out, and it's gone
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.locator(CARD).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "A quiet draft" })).toHaveCount(0);

  // and it isn't reachable by guessing the URL either
  await page.goto(`/#/posts/${draftId}`);
  await expect(page.getByRole("heading", { name: "That post is gone." })).toBeVisible();
});

test("another signed-in person can't reach someone else's draft", async ({
  page,
  api,
}) => {
  await api.seed(2, "ada@commons.test");
  const author = uniqueEmail("author");
  await register(page, author);
  const draftId = await writeDraft(page, "Still thinking");

  await page.getByRole("button", { name: "Sign out" }).click();
  await register(page, uniqueEmail("stranger"));

  await expect(page.getByRole("heading", { name: "Still thinking" })).toHaveCount(0);

  await page.goto(`/#/posts/${draftId}`);
  await expect(page.getByRole("heading", { name: "That post is gone." })).toBeVisible();
});

test("publishing a draft puts it in everyone's feed", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");
  await register(page, uniqueEmail("author"));
  const draftId = await writeDraft(page, "Ready now");

  await page.goto(`/#/posts/${draftId}/edit`);
  await page.getByText("Save as a draft").click(); // toggle back on
  await expect(page.getByText("Publish now")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "Ready now" })).toBeVisible();
});
