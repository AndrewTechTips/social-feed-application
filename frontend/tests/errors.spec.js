// The unhappy paths from the brief: wrong password, duplicate email, editing
// someone else's post, empty fields, backend unreachable.

const { test, expect, CARD } = require("./support/fixtures");

test("wrong password shows one friendly line and stays on the page", async ({
  page,
  api,
}) => {
  await api.register("ada@commons.test", "correcthorse");
  await page.goto("/#/login");

  await page.getByLabel("Email").fill("ada@commons.test");
  await page.getByLabel("Password", { exact: true }).fill("nope-that's-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("That email and password don't match.")).toBeVisible();
  await expect(page).toHaveURL(/#\/login$/);
});

test("registering a taken email is explained", async ({ page, api }) => {
  await api.register("taken@commons.test", "password123");
  await page.goto("/#/register");

  await page.getByLabel("Email").fill("taken@commons.test");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(
    page.getByText("There's already an account with that email.")
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/register$/);
});

test("empty sign-in fields get inline errors", async ({ page }) => {
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Enter your email.")).toBeVisible();
  await expect(page.getByText("Enter a password.")).toBeVisible();
});

test("you can't open the editor for someone else's post", async ({ page, api }) => {
  const seeded = await api.seed(1, "ada@commons.test");
  const { created } = await seeded.json();
  const postId = created[0];

  // sign in as a different person
  await page.goto("/#/register");
  await page.getByLabel("Email").fill(`intruder-${Date.now()}@commons.test`);
  await page.getByLabel("Password", { exact: true }).fill("hunter2pw");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/#\/$/);

  await page.goto(`/#/posts/${postId}/edit`);

  await expect(page.getByText("You can't edit that.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/posts/${postId}$`));
});

test("a dead backend shows a retry affordance, not a blank page", async ({
  page,
  api,
}) => {
  await api.seed(3, "ada@commons.test");
  // "the backend is unreachable", however that's arranged for this target:
  // an aborted route against the HTTP mock, a queued failure inside the
  // in-browser adapter. See tests/support/fixtures.js.
  await api.breakFeed();

  await page.goto("/");

  await expect(page.getByText("The feed didn't load.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
