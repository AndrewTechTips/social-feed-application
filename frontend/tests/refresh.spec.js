// Staying signed in, from the browser's side.
//
// The backend suite proves the token flow is correct. What this proves is that
// the *app* never makes a person pay for it: a token that runs out mid-session
// is invisible, a reload doesn't sign you out, and the one case where you
// really have been signed out — a refresh cookie that's gone or forged — lands
// on the sign-in screen instead of a broken page.
//
// Both projects run it. Against the mock the cookie is a real one, with real
// flags, set over a real origin boundary; against the in-browser demo adapter
// there is no origin and so no cookie, and the same refresh token is kept in
// its own state instead. The frontend can't tell the two apart, which is the
// point — it never sees the value either way.

const { test, expect, CARD } = require("./support/fixtures");

const signedIn = (page) => page.getByRole("button", { name: "Sign out" });
const signedOut = (page) => page.getByRole("link", { name: "Sign in" });

const stored = (page) =>
  page.evaluate(() => ({
    identity: localStorage.getItem("commons.identity"),
    csrf: localStorage.getItem("commons.csrf"),
    legacy: localStorage.getItem("commons.session"),
  }));

test.beforeEach(async ({ page, api }) => {
  await api.register("ada@commons.test", "seedpassword", "ada");
  await api.seed(2, "ada@commons.test");
});

// ── what's in storage, and what isn't ───────────────────────────────────────
test("storage holds an identity and a CSRF nonce, and no credential", async ({
  page,
  api,
}) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(signedIn(page)).toBeVisible();

  const s = await stored(page);
  expect(JSON.parse(s.identity)).toEqual({ id: expect.any(Number), username: "ada" });
  // The nonce is here on purpose: the cookie survives a reload and memory
  // doesn't, so without it the app would hold a live session it could never
  // refresh. On its own it opens nothing.
  expect(s.csrf).toBeTruthy();
  // And the thing that *is* a credential is nowhere a script can reach.
  expect(JSON.stringify(s)).not.toContain("access_token");
  expect(s.legacy).toBeNull();
});

test("the access token lives in memory and nowhere else", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  // Whatever went out as a Bearer header must not be findable in storage.
  const leaked = await page.evaluate(() => {
    const haystack = JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    });
    return ["Bearer", "access_token"].filter((needle) => haystack.includes(needle));
  });
  expect(leaked).toEqual([]);
});

// ── the point of the whole exercise ─────────────────────────────────────────
test("an access token that expires mid-session is invisible", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  // Through the feed rather than straight to the composer: arriving on a
  // screen that asks the API for nothing is a state where the app has not
  // needed a token yet, and this test is about the one that has.
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.goto("/#/compose");
  await expect(page.locator("#post-title")).toBeVisible();

  // Sitting on a page long enough for the token to run out is the ordinary
  // case, not the exotic one.
  await api.expireAccess(page);

  await page.locator("#post-title").fill("Written after the token ran out");
  await page.locator("#post-content").fill("And nobody had to sign in again.");
  await page.getByRole("button", { name: "Post" }).click();

  // No bounce to the sign-in screen, no toast about an expired session, and
  // the work that was typed still went through.
  await expect(page.locator(".detail__title")).toHaveText(
    "Written after the token ran out"
  );
  await expect(page.getByText("Your session expired.")).toHaveCount(0);
  await expect(signedIn(page)).toBeVisible();
});

test("a reload keeps you signed in, with nothing in storage that could", async ({
  page,
  api,
}) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(signedIn(page)).toBeVisible();

  // Everything the app was holding is gone; only the cookie survives.
  await page.reload();

  await expect(signedIn(page)).toBeVisible();
  await expect(page.locator(CARD).first()).toBeVisible();
});

test("your own drafts are there on the first paint after a reload", async ({
  page,
  api,
}) => {
  // The reason the boot refresh happens *before* the feed request rather than
  // after a 401: a feed fetched without a token comes back without your
  // drafts, and by the time a retry landed it would already be on screen.
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/#/compose");
  await page.locator("#post-title").fill("Not finished");
  await page.locator("#post-content").fill("Still thinking about it.");
  await page.locator(".switch input").uncheck();
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".detail__title")).toHaveText("Not finished");

  await page.goto("/");
  await page.reload();

  await expect(page.getByRole("heading", { name: "Not finished" })).toBeVisible();
  await expect(page.locator(".tag", { hasText: "Draft" })).toHaveCount(1);
});

test("one refresh serves a whole screen's worth of requests", async ({ page, api }) => {
  // Every request starting its own refresh would be worse than useless:
  // rotation means the second one presents a secret the first has already
  // spent, which the server correctly reads as a stolen cookie and answers by
  // ending the session. A dozen honest requests would sign you out.
  await api.signIn(page, "ada@commons.test", "seedpassword");

  const refreshes = [];
  await page.route(/\/auth\/refresh/, (route) => {
    refreshes.push(route.request().url());
    route.continue();
  });

  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.goto("/#/posts/1");
  await expect(page.locator(".detail__title")).toBeVisible();

  expect(refreshes.length, "one boot refresh, not one per request").toBeLessThanOrEqual(
    1
  );
  await expect(signedIn(page)).toBeVisible();
});

// ── the failure cases, which are the ones worth testing ─────────────────────
test("a refresh cookie that's gone means signed out, cleanly", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(signedIn(page)).toBeVisible();

  await api.dropRefreshCookie(page);
  await page.reload();

  // Signed out, and it says so — not a broken screen, and not a page that
  // looks signed in until the first thing you try fails.
  await expect(signedOut(page)).toBeVisible();
  await expect(page.locator(CARD).first()).toBeVisible();
  expect((await stored(page)).identity).toBeNull();
});

test("a forged refresh cookie is rejected and doesn't leave you half signed in", async ({
  page,
  api,
}) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(signedIn(page)).toBeVisible();

  await api.forgeRefreshCookie(page);
  await page.reload();

  await expect(signedOut(page)).toBeVisible();
  const s = await stored(page);
  expect(s.identity).toBeNull();
  expect(s.csrf).toBeNull();
});

test("losing the session mid-session sends you to sign in, once", async ({
  page,
  api,
}) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.goto("/#/compose");
  await expect(page.locator("#post-title")).toBeVisible();

  // Both halves gone: the token has run out *and* the cookie can't replace it.
  // This is the only case that should ever reach a sign-in screen.
  await api.expireAccess(page);
  await api.forgeRefreshCookie(page);

  await page.locator("#post-title").fill("This one won't go through");
  await page.locator("#post-content").fill("Because there's nobody signed in.");
  await page.getByRole("button", { name: "Post" }).click();

  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByText("Your session expired.")).toBeVisible();
  await expect(signedOut(page)).toBeVisible();
});

test("a network failure is not a sign-out", async ({ page, api }) => {
  // The distinction the refresh path has to get right: a 401 means the session
  // is over, and anything else means the server is having a moment. Throwing
  // away a good identity because a request timed out would be the app
  // punishing a reader for its own bad connection.
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  // Wait for the feed, not just for the header: the header paints from the
  // stored identity before any request has been made, and ageing the token
  // while the boot refresh is still in flight would age the one it replaces
  // rather than the one it mints.
  await expect(page.locator(CARD).first()).toBeVisible();

  await api.expireAccess(page);
  await api.breakRefresh(page);

  await page.goto("/#/compose");
  await page.locator("#post-title").fill("Into the void");
  await page.locator("#post-content").fill("The network is down, not the session.");
  await page.getByRole("button", { name: "Post" }).click();

  await expect(page.getByText(/Can't reach the server|didn't go through/)).toBeVisible();
  await expect(page).not.toHaveURL(/#\/login$/);
  expect((await stored(page)).identity, "still signed in").not.toBeNull();
});

// ── signing out ─────────────────────────────────────────────────────────────
test("signing out ends the session everywhere, not just here", async ({ page, api }) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(signedIn(page)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(signedOut(page)).toBeVisible();
  await expect(page.getByText("Signed out.")).toBeVisible();

  const s = await stored(page);
  expect(s.identity).toBeNull();
  expect(s.csrf).toBeNull();

  // The request is fire-and-forget on purpose — nobody should wait on a server
  // to be allowed to leave — so wait for it to have landed before asking what
  // it did, rather than racing the thing being tested.
  await expect.poll(() => api.sessionCookie(page)).toBeNull();

  // And the session is dead, not merely forgotten here: a reload can't quietly
  // restore it.
  await page.reload();
  await expect(signedOut(page)).toBeVisible();
});

test("signing out looks immediate, even when the server is slow about it", async ({
  page,
  api,
}) => {
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(signedIn(page)).toBeVisible();

  // A spinner between "Sign out" and being signed out is the app asking a
  // server for permission to let you leave.
  await page.route(/\/auth\/logout/, async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    route.continue();
  });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(signedOut(page)).toBeVisible({ timeout: 1500 });
});

// ── what signing out leaves behind ──────────────────────────────────────────
test("signing out takes the upvote mirror with it", async ({ page, api }) => {
  // The mirror exists because the API has no "did I vote on this" flag, so the
  // vote control keeps a local record of what you pressed. Left behind on sign
  // out, it paints filled carets for the *previous* person on a shared browser
  // — somebody else's history, shown to a stranger, on posts they never
  // touched. Found on a live pass, not by a test.
  await api.register("bob@commons.test", "seedpassword", "bob");
  await api.seed(1, "ada@commons.test");
  await api.signIn(page, "bob@commons.test", "seedpassword");
  await page.goto("/");

  const vote = page.locator(`.feed__list ${CARD}`).first().locator(".vote");
  await vote.click();
  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("commons.votes")))
    .not.toBe(null);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(signedOut(page)).toBeVisible();

  expect(await page.evaluate(() => localStorage.getItem("commons.votes"))).toBeNull();
  // And the next person to open the page sees an unpressed control.
  await expect(vote).toHaveAttribute("aria-pressed", "false");
});
