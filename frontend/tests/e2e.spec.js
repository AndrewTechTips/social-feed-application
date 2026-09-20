// The full journey the brief asks for:
// register -> sign in -> feed -> create -> vote -> edit -> delete -> sign out.

const {
  test,
  expect,
  CARD,
  usernameFor,
  accountButton,
  signOutViaMenu,
} = require("./support/fixtures");

const password = "hunter2pw";
const uniqueEmail = () => `person-${Date.now()}@commons.test`;

test("a person can join, post, vote, edit, delete, and sign out", async ({
  page,
  api,
}) => {
  await api.seed(3, "ada@commons.test"); // the feed isn't empty to begin with
  const email = uniqueEmail();

  // — feed, signed out ----------------------------------------------------
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.locator(CARD).first()).toBeVisible();

  // — register (auto-signs in) -----------------------------------------
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page.getByRole("heading", { name: "Make an account." })).toBeVisible();

  await page.getByLabel("Username").fill(usernameFor(email));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/#\/$/);
  await expect(accountButton(page)).toBeVisible();
  // The header names you by username now. The address is a credential and
  // shouldn't be on screen at all.
  await expect(accountButton(page)).toHaveAttribute(
    "aria-label",
    new RegExp(`^Your account, ${usernameFor(email)}\\b`)
  );
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);

  // — create a post ------------------------------------------------------
  await page.getByRole("link", { name: "Write a post" }).click();
  await expect(page.getByRole("heading", { name: "New post" })).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("My first note");
  await page.getByLabel("Body").fill("Hello from the test.\n\nSecond paragraph.");
  await page.getByRole("button", { name: "Post" }).click();

  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  await expect(page.getByRole("heading", { name: "My first note" })).toBeVisible();
  await expect(page.getByText("Second paragraph.")).toBeVisible();

  // — vote, then un-vote (optimistic) --------------------------------
  const vote = page.getByRole("button", { name: /upvote/i });
  await expect(vote).toHaveAttribute("aria-pressed", "false");
  await vote.click();
  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await expect(vote).toContainText("1");
  // The count updates optimistically, so it says 1 long before the request is
  // done — and a click that lands while one is in flight is deliberately
  // dropped. Wait for it to settle, otherwise this is testing double-clicking.
  await expect(vote).toHaveAttribute("aria-busy", "false");
  await vote.click();
  await expect(vote).toHaveAttribute("aria-pressed", "false");
  await expect(vote).toContainText("0");

  // — edit my own post ------------------------------------------------
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit your post" })).toBeVisible();
  const title = page.getByLabel("Title", { exact: true });
  await title.fill("My first note (edited)");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(
    page.getByRole("heading", { name: "My first note (edited)" })
  ).toBeVisible();
  await expect(page.getByText("edited", { exact: true })).toBeVisible();

  // — delete: inline confirm, Escape cancels, then confirm ----------
  await page.getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("There's no undo");
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByText("Post deleted.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "My first note (edited)" })
  ).toHaveCount(0);

  // — sign out; feed still readable ---------------------------------
  await signOutViaMenu(page);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.locator(CARD).first()).toBeVisible();
});

test("the feed paginates as you scroll and shows an end state", async ({
  page,
  api,
}) => {
  await api.seed(25, "ada@commons.test");
  await page.goto("/");

  await expect(page.locator(CARD)).toHaveCount(10); // first page

  // walk to the bottom; the IntersectionObserver pulls the next pages
  await expect(async () => {
    await page.mouse.wheel(0, 20000);
    await expect(page.getByText("That's everything for now.")).toBeVisible({
      timeout: 1000,
    });
  }).toPass();

  await expect(page.locator(CARD)).toHaveCount(25);
});

test("the feed keeps filling while the sentinel is still in view", async ({
  browser,
  api,
}) => {
  // The case that scrolling hides.
  //
  // An IntersectionObserver reports *changes*, not states. On a tall screen the
  // sentinel sits inside the prefetch margin from the first paint and stays
  // there, so it is reported exactly once — and if that one report lands while
  // the first page is still in flight, the load it asks for is declined by the
  // `loading` guard and no second report is ever coming. The feed stops at ten
  // posts and nothing the reader can do brings the rest back, because on a
  // screen that tall there is no scrolling left to do.
  //
  // Found on CI as a flaky pagination assertion, which is what this looks like
  // from the outside: on a shorter screen the sentinel does leave and come
  // back, so the missed report is usually covered by the next one — unless the
  // render and the scroll land inside one frame, in which case Blink never
  // observes the intermediate state either and the page is dropped for good.
  await api.seed(25, "ada@commons.test");

  // Seeded before the context exists: in demo mode the state reaches the page
  // through an init script captured when the context is created, so a context
  // built first would be built around an empty feed.
  const context = await browser.newContext({ viewport: { width: 1280, height: 2400 } });
  const page = await context.newPage();

  // Hold the feed request long enough that the observer's first report is
  // certain to arrive while it is still in flight — the condition the bug
  // needs, which otherwise happens only sometimes and only on some machines.
  // No-op against the demo adapter, which answers in the page and has ~150ms
  // of simulated latency of its own doing the same job.
  await page.route(/\/posts\/\?/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });

  await page.goto("/");

  // Two pages, with no scrolling at all. One is what the bug left behind.
  await expect(page.locator(CARD)).toHaveCount(20);
  expect(await page.evaluate(() => window.scrollY), "nothing was scrolled").toBe(0);

  // And it stopped for the right reason: the sentinel is finally out of reach,
  // not because a report went missing. Anything else would be a feed that fills
  // the whole thing on load, which is a different bug.
  const reach = await page.evaluate(() => {
    const top = document.querySelector(".feed__sentinel").getBoundingClientRect().top;
    return { top: Math.round(top), limit: window.innerHeight + 700 };
  });
  expect(reach.top, "it stopped with the sentinel still in view").toBeGreaterThan(
    reach.limit
  );

  // The rest are one scroll away, as they should be.
  await page.mouse.wheel(0, 20000);
  await expect(page.locator(CARD)).toHaveCount(25);
  await context.close();
});

test("search filters the feed and drives the query string", async ({ page, api }) => {
  await api.seed(5, "ada@commons.test");
  await page.goto("/");

  const search = page.getByRole("searchbox");
  await search.fill("Seeded post 2");
  await expect(page).toHaveURL(/search=Seeded/);
  await expect(page.locator(CARD)).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Seeded post 2" })).toBeVisible();

  await search.fill("nothing matches this");
  // scoped to the feed: the command palette has an empty state of its own
  // that opens with the same two words.
  await expect(page.locator(".feed__status")).toContainText("Nothing matches");
});
