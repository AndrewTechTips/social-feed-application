// The warm hairline on a card.
//
// One rule, and the suite exists to keep it one rule: a post the room has
// agreed on — three upvotes or more — gets a single amber hairline down its
// leading edge, and nothing else on the card is allowed to become a second
// signal. So this checks the threshold in both directions, checks that your
// own vote can move a card across it and back, and checks that the hairline
// stays a drawing of a number that is already said out loud rather than
// becoming a second thing for a screen reader to read.

const { test, expect, CARD } = require("./support/fixtures");

const cards = (page) => page.locator(`.feed__list ${CARD}`);
const warm = (card) => card.evaluate((el) => el.classList.contains("card--warm"));

// Does the rule actually paint? A class nothing draws would pass every
// assertion below and show the reader nothing at all.
const hairline = (card) =>
  card.evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    return { content: s.content, width: s.width, image: s.backgroundImage };
  });

test("three votes light it, two don't", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test", 2);
  await api.seed(1, "ada@commons.test", 3);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(2);

  // Newest first, so the three-vote post is the one on top.
  const hot = cards(page).nth(0);
  const cold = cards(page).nth(1);
  await expect(hot.locator(".vote__count")).toHaveText("3");
  await expect(cold.locator(".vote__count")).toHaveText("2");

  expect(await warm(hot)).toBe(true);
  expect(await warm(cold)).toBe(false);
});

test("it is a drawn edge, not a badge", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test", 4);
  await page.goto("/");
  const card = cards(page).first();
  await expect(card).toBeVisible();

  const rule = await hairline(card);
  expect(rule.content, "the hairline should be painted").not.toBe("none");
  expect(parseFloat(rule.width), "a hairline, not a bar").toBeLessThanOrEqual(3);
  expect(rule.image, "amber, fading at both ends").toContain("gradient");

  // Nothing was added to the card for a reader to hear: the only element
  // carrying the vote count is the same button an unwarmed card has.
  const spoken = await card.evaluate((el) =>
    [...el.querySelectorAll("[aria-label]")].map((n) => n.getAttribute("aria-label"))
  );
  expect(spoken).toEqual(["Upvote, now 4 votes"]);
});

test("your own vote can carry a card over the line, and back", async ({ page, api }) => {
  await api.register("bob@commons.test", "seedpassword", "bob");
  await api.seed(1, "ada@commons.test", 2);
  await api.signIn(page, "bob@commons.test", "seedpassword");
  await page.goto("/");

  const card = cards(page).first();
  await expect(card.locator(".vote__count")).toHaveText("2");
  expect(await warm(card)).toBe(false);

  await card.locator(".vote").click();
  await expect(card.locator(".vote__count")).toHaveText("3");
  await expect(card).toHaveClass(/card--warm/);

  // The control ignores a second click while the first is still in flight, and
  // says so with aria-busy — so wait for it rather than guessing at latency.
  await expect(card.locator(".vote")).toHaveAttribute("aria-busy", "false");
  await card.locator(".vote").click();
  await expect(card.locator(".vote__count")).toHaveText("2");
  await expect(card).not.toHaveClass(/card--warm/);
});

test("a vote that doesn't take puts the edge out again", async ({ page, api }) => {
  await api.register("bob@commons.test", "seedpassword", "bob");
  await api.seed(1, "ada@commons.test", 2);
  await api.signIn(page, "bob@commons.test", "seedpassword");
  await page.goto("/");

  const card = cards(page).first();
  await expect(card.locator(".vote__count")).toHaveText("2");

  await api.failNext({ method: "POST", path: "^/vote/", status: 500 });
  await card.locator(".vote").click();

  // The optimistic count rolls back, and the warmth has to roll back with it —
  // which is the whole reason it's painted in paint() rather than on click.
  await expect(card.locator(".vote__count")).toHaveText("2");
  await expect(card).not.toHaveClass(/card--warm/);
});

test("the post screen doesn't grow one", async ({ page, api }) => {
  const { created } = await (await api.seed(1, "ada@commons.test", 4)).json();
  await page.goto(`/#/posts/${created[0]}`);
  await expect(page.locator(".detail__title")).toBeVisible();

  // The signature belongs to the card, and the post screen has no cards on it.
  await expect(page.locator(".card--warm")).toHaveCount(0);
  await expect(page.locator(".vote__count")).toHaveText("4");
});

test("a profile draws the same card, so it draws the same edge", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test", 3);
  await page.goto("/#/u/ada");
  await expect(cards(page).first()).toBeVisible();
  expect(await warm(cards(page).first())).toBe(true);
});
