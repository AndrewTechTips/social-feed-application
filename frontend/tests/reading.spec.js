// How a post is set: the way headings and prose wrap.
//
// The scroll indicator used to live here too, back when it was a reading bar
// that only appeared on a post. It is the whole app's scroll indicator now and
// has moved to tests/progress.spec.js with the scrollbar it replaced — the two
// are one decision and belong in one file.
//
// What is left is pure CSS and meant to be invisible when it works, which is
// exactly why it needs a test: nothing else would ever notice it breaking.

const { test, expect, CARD } = require("./support/fixtures");

test("headings balance their lines; prose doesn't", async ({ page, api }) => {
  await api.seed(2, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  const style = (sel) =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return s.textWrapStyle || s.textWrap;
      });

  // A card title is a heading, and a heading is short enough for the browser
  // to even out every line of it — which is what stops a two-line title
  // dropping one word onto the second line on a phone.
  expect(await style(".card__title")).toBe("balance");
  // Prose keeps `pretty`: balancing a paragraph is both wrong and capped.
  expect(await style(".card__preview")).toBe("pretty");

  await page.locator(".card__title").first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  expect(await style(".detail__title")).toBe("balance");
});
