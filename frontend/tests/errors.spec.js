// The unhappy paths from the brief: wrong password, duplicate email, editing
// someone else's post, empty fields, backend unreachable.

const { test, expect, CARD, usernameFor } = require("./support/fixtures");

test("wrong password shows one friendly line and stays on the page", async ({
  page,
  api,
}) => {
  await api.register("ada@commons.test", "correcthorse");
  await page.goto("/#/login");

  await page.getByLabel("Email").fill("ada@commons.test");
  await page.getByLabel("Password", { exact: true }).fill("nope-that's-wrong");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByText("That email and password don't match.")).toBeVisible();
  await expect(page).toHaveURL(/#\/login$/);
});

test("registering a taken email is explained", async ({ page, api }) => {
  await api.register("taken@commons.test", "password123");
  await page.goto("/#/register");

  await page.getByLabel("Username").fill("somebodynew");
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
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByText("Enter your email.")).toBeVisible();
  await expect(page.getByText("Enter a password.")).toBeVisible();
});

test("you can't open the editor for someone else's post", async ({ page, api }) => {
  const seeded = await api.seed(1, "ada@commons.test");
  const { created } = await seeded.json();
  const postId = created[0];

  // sign in as a different person
  await page.goto("/#/register");
  const intruder = `intruder-${Date.now()}@commons.test`;
  await page.getByLabel("Username").fill(usernameFor(intruder));
  await page.getByLabel("Email").fill(intruder);
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

// ── the account exists and the sign-in behind it didn't ─────────────────────
// Registering is two requests. `/users/` allows ten an hour and `/login` only
// five a minute, so a handful of people registering from one office at once can
// land between them — and that is exactly what happened during a live pass:
// 201 on the account, 429 on the sign-in.
//
// What made it worth fixing wasn't the rate limit. It was that the screen still
// said "Make an account" while reporting a failure for an account that had just
// been made, and trying again answered "that username is taken" — which is true
// and reads like the first attempt failed.
test("a registration whose sign-in fails says so, and moves you to sign in", async ({
  page,
  api,
}) => {
  // Through the feed first: it's the screen that makes the demo adapter load,
  // and `api.failNext` can only queue a rule inside an adapter that exists.
  await page.goto("/");
  await expect(page.locator(".feed")).toBeVisible();

  await page.goto("/#/register");
  await page.getByLabel("Username").fill("latecomer");
  await page.getByLabel("Email").fill("latecomer@commons.test");
  await page.getByLabel("Password", { exact: true }).fill("a-good-passphrase");

  // The account gets made; the sign-in behind it hits the limiter.
  await api.failNext({ method: "POST", path: "^/login$", status: 429 });
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByText(/Your account is ready/)).toBeVisible();

  // The address carries over, so the second attempt isn't a retype — and the
  // cursor is on the half that's still empty.
  await expect(page.getByLabel("Email")).toHaveValue("latecomer@commons.test");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();

  // And it really was created, so signing in now works.
  await page.getByLabel("Password", { exact: true }).fill("a-good-passphrase");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("the carried-over address doesn't linger on a later visit", async ({
  page,
  api,
}) => {
  await page.goto("/");
  await expect(page.locator(".feed")).toBeVisible();

  await page.goto("/#/register");
  await page.getByLabel("Username").fill("passerby");
  await page.getByLabel("Email").fill("passerby@commons.test");
  await page.getByLabel("Password", { exact: true }).fill("a-good-passphrase");
  await api.failNext({ method: "POST", path: "^/login$", status: 429 });
  await page.getByRole("button", { name: "Create account" }).click();

  // Wait for the *sign-in* screen, not just for an Email field holding that
  // address — the register screen has one of those too, still full of what was
  // typed into it. Without this the assertion below passed on the screen we
  // were leaving, the test walked on while the navigation was still in flight,
  // and the login screen mounted *after* the two gotos — consuming the carried
  // address at exactly the moment the test was checking it had been consumed.
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue("passerby@commons.test");

  // Read once and cleared: coming back to the sign-in screen later is a blank
  // form like any other, not somebody else's address waiting in a shared browser.
  await page.goto("/#/");
  await expect(page.locator(".feed")).toBeVisible();
  await page.goto("/#/login");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue("");
});

// ── the router's error boundary ─────────────────────────────────────────────
// A throw inside a view used to be caught, written to the console, and that was
// all — which left the *previous* screen on the page, still interactive, with
// the address bar naming a screen that never rendered. Pressing back from there
// went somewhere that looked identical.
//
// The app has no view that throws on demand, so these register one. Importing
// js/router.js from the page gets the *same module instance* the app is running
// — ES modules are cached per document — so `route()` here pushes onto the same
// table `resolve()` reads, and the throw travels the real path.

const routeThatThrows = (page) =>
  page.evaluate(async () => {
    const { route } = await import("/js/router.js");
    route("/__boom", () => {
      throw new Error("a view that could not build itself");
    });
  });

test("a view that throws puts up a screen instead of leaving the last one", async ({
  page,
  api,
}) => {
  await api.seed(2, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await routeThatThrows(page);
  await page.evaluate(() => (location.hash = "#/__boom"));

  await expect(page.locator(".screen-error")).toBeVisible();
  await expect(page.getByText("This screen didn't load.")).toBeVisible();
  // The important half: the feed is *gone*. Leaving it on screen under a URL
  // that names something else is the failure this exists to prevent.
  await expect(page.locator(".feed__list")).toHaveCount(0);
});

test("the boundary offers a way back, and it works", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  await routeThatThrows(page);
  await page.evaluate(() => (location.hash = "#/__boom"));
  await expect(page.locator(".screen-error")).toBeVisible();

  await page.getByRole("link", { name: "Go to the feed" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(CARD).first()).toBeVisible();
});

test("a route that matches nothing goes home rather than to the boundary", async ({
  page,
  api,
}) => {
  // Not every miss is a failure. A mistyped fragment is not a screen that broke,
  // and sending somebody to an apology for it would be the app blaming itself
  // for a typo.
  await api.seed(1, "ada@commons.test");
  await page.goto("/#/not-a-route-at-all");

  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(".screen-error")).toHaveCount(0);
  await expect(page.locator(CARD).first()).toBeVisible();
});
