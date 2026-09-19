// "Have I voted on this?" — asked of the API now, not guessed at locally.
//
// The app used to keep a set of post ids in localStorage, because the API had
// no way of answering. That meant your own votes were invisible on a second
// device, invisible in a private window, and wrong after clearing site data.
// `PostOut.voted` replaced it, and these are the things the replacement has to
// get right that the guess could not.

const { test, expect, CARD } = require("./support/fixtures");

const firstVote = (page) => page.locator(`.feed__list ${CARD}`).first().locator(".vote");

const pressed = async (locator) =>
  (await locator.getAttribute("aria-pressed")) === "true";

// Let the write land before doing anything that throws the page away.
//
// The vote control is optimistic: the caret fills and the count moves the
// instant you click, and the request is still in flight behind it. Against a
// real server that is fine — a reload cannot un-send an HTTP request. Against
// the demo adapter the "server" is a module in this page, with a deliberate
// 150ms of simulated latency, so navigating out from under it kills the write
// rather than merely losing the answer.
//
// There is no signal to wait on: aria-busy goes up synchronously with the
// click and can come back down before an assertion can catch it. So this waits
// out the latency, with a margin, and says why.
const writeLanded = (page) => page.waitForTimeout(500);

async function signedInFeed(page, api, email = "ada@commons.test") {
  await api.seed(2, email);
  await api.signIn(page, email, "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
}

// ── it comes from the server ───────────────────────────────────────────────
test("a vote survives a reload, with nothing in storage to remember it", async ({
  page,
  api,
}) => {
  await signedInFeed(page, api);
  const vote = firstVote(page);
  await expect(vote).toHaveAttribute("aria-pressed", "false");

  await vote.click();
  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await expect(vote).toContainText("1");

  await writeLanded(page);
  await page.reload();
  await expect(page.locator(CARD)).toHaveCount(2);
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "true");
  await expect(firstVote(page)).toContainText("1");

  // The whole point: there is no local record for it to have come from. The
  // key the old mirror lived under is removed on boot rather than left alone.
  expect(await page.evaluate(() => localStorage.getItem("commons.votes"))).toBeNull();
});

test("a signed-out visitor sees the count but not a pressed caret", async ({
  page,
  api,
}) => {
  await signedInFeed(page, api);
  await firstVote(page).click();
  await expect(firstVote(page)).toContainText("1");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".account")).toContainText("Sign in");
  await expect(page.locator(CARD)).toHaveCount(2);

  // The count is the room's; the flag is the reader's.
  await expect(firstVote(page)).toContainText("1");
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "false");
});

test("somebody else's vote is not yours", async ({ page, api }) => {
  await api.register("bea@commons.test", "seedpassword", "bea");
  await signedInFeed(page, api, "ada@commons.test");
  await firstVote(page).click();
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "true");
  await writeLanded(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".account")).toContainText("Sign in");

  // Bea signs in through the form rather than through the fixture. In demo
  // mode api.signIn re-seeds the page from a snapshot taken on the Node side,
  // which never saw Ada's vote — so the shortcut would quietly undo the thing
  // this test is about.
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill("bea@commons.test");
  await page.getByLabel("Password", { exact: true }).fill("seedpassword");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(CARD)).toHaveCount(2);

  await expect(firstVote(page)).toContainText("1");
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "false");
});

// ── the copies of a post in hand agree ─────────────────────────────────────
test("a vote cast on a post is still there when you go back to the feed", async ({
  page,
  api,
}) => {
  // The feed fetched one copy of this post and the post screen fetches
  // another. Coming back restores the feed from cache — from the *first* copy
  // — so without something writing the vote onto it, the caret would come back
  // hollow and the count one short.
  await signedInFeed(page, api);
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "false");

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  const inline = page.locator(".detail__row .vote");
  await inline.click();
  await expect(inline).toHaveAttribute("aria-pressed", "true");

  await page.locator(".back").click();
  await expect(page.locator(CARD)).toHaveCount(2);
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "true");
  await expect(firstVote(page)).toContainText("1");
});

test("taking a vote back travels the same way", async ({ page, api }) => {
  await signedInFeed(page, api);
  await firstVote(page).click();
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "true");

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  const inline = page.locator(".detail__row .vote");
  await expect(inline).toHaveAttribute("aria-pressed", "true");

  await inline.click();
  await expect(inline).toHaveAttribute("aria-pressed", "false");

  await page.locator(".back").click();
  await expect(page.locator(CARD)).toHaveCount(2);
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "false");
  await expect(firstVote(page)).toContainText("0");
});

// ── a profile is the same list, so it answers the same ─────────────────────
test("a profile agrees with the feed", async ({ page, api }) => {
  await signedInFeed(page, api);
  await firstVote(page).click();
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "true");

  await page.goto("/#/u/ada");
  await expect(page.locator(CARD)).toHaveCount(2);
  await expect(firstVote(page)).toHaveAttribute("aria-pressed", "true");
});

// ── the rollback still rolls the data back, not just the pixels ────────────
test("a vote that doesn't take leaves nothing behind", async ({ page, api }) => {
  await signedInFeed(page, api);
  const vote = firstVote(page);

  await api.failNext({ method: "POST", path: "^/vote/", status: 500 });
  await vote.click();
  // Optimistic first, then put back when the server refuses.
  await expect(vote).toHaveAttribute("aria-pressed", "false");
  await expect(vote).toContainText("0");

  // And the copy the cache is holding was put back too, not left one ahead.
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.locator(".back").click();
  await expect(page.locator(CARD)).toHaveCount(2);
  expect(await pressed(firstVote(page))).toBe(false);
  await expect(firstVote(page)).toContainText("0");
});
