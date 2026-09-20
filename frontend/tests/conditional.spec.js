// Conditional requests, from the client's side.
//
// The API fingerprints the feed and one post; the client hands the fingerprint
// back and a `304` means "what you have is current". The saving is bytes and
// parsing, not database work — backend/app/etag.py is explicit about that.
//
// What matters here is the failure mode, which is nastier than the feature is
// valuable: a 304 is not `res.ok`, so before the client understood it, every
// unchanged feed would have looked like a failed request. And a client that
// answers a 304 out of the wrong cache entry shows one reader another's posts.

const { test, expect, CARD } = require("./support/fixtures");

const EMAIL = "ada@commons.test";

const feedRequests = (page) => {
  const seen = [];
  page.on("request", (r) => {
    if (/\/api\/v1\/posts\/(\?|$)/.test(r.url())) seen.push(r);
  });
  return seen;
};

// Coming back to the feed usually doesn't fetch it at all — the store keeps the
// last few lists, which is the whole point of that cache. The brand is what a
// reader presses when they want the feed *fresh*: it drops the snapshot, so the
// feed is fetched again rather than restored.
//
// It used to *have* to be pressed from somewhere else: the brand is an
// `<a href="#/">`, and pressing it while the hash was already `#/` fired no
// hashchange, so the router never heard and nothing was drawn. It goes through
// navigate() now and works from either side — see the brand tests in
// returning.spec.js. This still steps onto a post first, because that is what
// a reader would have been doing anyway, and because the journey back is the
// one that puts a conditional request on the wire.
const freshFeed = async (page) => {
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.locator(".brand").click();
};

test("a fresh feed asks conditionally, and still draws", async ({ page, api }) => {
  const seen = feedRequests(page);
  await api.seed(3, EMAIL);

  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  // Nothing to be conditional about yet.
  if (seen.length) expect(seen[0].headers()["if-none-match"]).toBeUndefined();

  await freshFeed(page);
  await expect(page.locator(CARD)).toHaveCount(3);

  // Demo mode has no network: the adapter answers in the page, so there is
  // nothing for page.on("request") to see. The behaviour is still exercised
  // there — the two tests below this one run against both — but the *headers*
  // can only be watched where there are headers.
  test.skip(seen.length === 0, "no HTTP requests to observe in demo mode");

  const conditional = seen.filter((r) => r.headers()["if-none-match"]);
  expect(conditional.length).toBeGreaterThan(0);

  // And the answer — 304, no body — still puts three cards on the page. This
  // is the assertion that would have caught the whole feature being a broken
  // request: a 304 is not `res.ok`.
  const replies = await Promise.all(conditional.map((r) => r.response()));
  expect(replies.some((res) => res && res.status() === 304)).toBe(true);
  await expect(page.locator(CARD)).toHaveCount(3);
});

test("a feed that changed is not answered from what you had", async ({ page, api }) => {
  await api.seed(2, EMAIL);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  // A third post arrives, then the feed is asked for again with the validator
  // from when there were two.
  await api.seedLive(page, 1, "bea@commons.test");
  await freshFeed(page);

  await expect(page.locator(CARD)).toHaveCount(3);
});

test("what one reader had is not served to the next", async ({ page, api }) => {
  // The client keys its cache by path, and the path is the same for everybody.
  // What keeps this honest is that the server fingerprints the body it *would*
  // send — so a signed-out reader presenting a signed-in validator gets a 200
  // — and that the cache is emptied when the session changes. Two belts; this
  // is the trousers.
  await api.seed(2, EMAIL);
  await api.signIn(page, EMAIL, "seedpassword");

  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("Nobody else's business");
  await page.getByLabel("Body").fill("A draft, and it should stay mine.");
  await page.getByText("Publish now").click();
  await expect(page.getByText("Save as a draft")).toBeVisible();
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".detail__title")).toBeVisible();

  await page.goto("/#/");
  await expect(page.locator(CARD)).toHaveCount(3);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".account")).toContainText("Sign in");
  await page.goto("/#/");

  await expect(page.locator(CARD)).toHaveCount(2);
  await expect(page.locator(".feed__list")).not.toContainText("Nobody else's business");
});

test("a post screen is conditional too, and a vote still lands", async ({ page, api }) => {
  await api.seed(2, EMAIL);
  await api.signIn(page, EMAIL, "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.locator(".back").click();
  await expect(page.locator(CARD)).toHaveCount(2);

  // Second visit: the validator goes out, and the screen still has to be built
  // from something.
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  const vote = page.locator(".detail__row .vote");
  await vote.click();
  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await expect(vote).toContainText("1");
});

test("nothing is asked conditionally that isn't a read", async ({ page, api }) => {
  // A conditional POST would be a very quiet way to drop somebody's post.
  const writes = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r);
  });

  await api.seed(1, EMAIL);
  await api.signIn(page, EMAIL, "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);
  await page.locator(`${CARD} .vote`).first().click();
  await expect(page.locator(`${CARD} .vote`).first()).toContainText("1");

  test.skip(writes.length === 0, "no HTTP requests to observe in demo mode");
  expect(writes.every((r) => !r.headers()["if-none-match"])).toBe(true);
});
