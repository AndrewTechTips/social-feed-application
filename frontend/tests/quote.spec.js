// Select a passage, take it with you.
//
// The selections below are made with a Range rather than by dragging the mouse
// across the page: a drag is a dozen synthesised events whose result depends on
// where the text happened to wrap, and what this is about is what happens once
// a selection exists.

const { test, expect, CARD } = require("./support/fixtures");

const QUOTE = ".quote-copy";

async function openPost(page, api) {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
}

/** Select `length` characters of whatever `selector` holds. */
const select = (page, selector, length) =>
  page.evaluate(
    ([sel, len]) => {
      const el = document.querySelector(sel);
      const node = el.firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(len, node.textContent.length));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    [selector, length]
  );

const clearSelection = (page) => page.evaluate(() => getSelection().removeAllRanges());

test.describe("with a mouse", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("a passage offers to be copied, with the post it came from", async ({
    page,
    api,
  }) => {
    await openPost(page, api);
    await expect(page.locator(QUOTE)).toBeHidden();

    await select(page, ".detail__content", 40);
    await expect(page.locator(QUOTE)).toBeVisible();

    const title = (await page.locator(".detail__title").textContent()).trim();
    const url = page.url();
    await page.locator(QUOTE).click();
    await expect(page.locator(".toast")).toHaveText("Quote copied.");

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("This is the body of seeded post");
    // Curly quotes and an em dash: this is going into somebody else's writing.
    expect(copied.startsWith("“")).toBe(true);
    expect(copied).toContain(`— ${title}`);
    expect(copied).toContain(url);
    // Offering it again after it's been taken would be the app not noticing.
    await expect(page.locator(QUOTE)).toBeHidden();
  });

  test("it sits above the passage, inside the column", async ({ page, api }) => {
    await openPost(page, api);
    await select(page, ".detail__content", 40);
    await expect(page.locator(QUOTE)).toBeVisible();

    const geometry = await page.evaluate(() => {
      const btn = document.querySelector(".quote-copy").getBoundingClientRect();
      const range = getSelection().getRangeAt(0).getBoundingClientRect();
      const column = document.querySelector(".detail").getBoundingClientRect();
      return {
        aboveIt: Math.round(range.top - btn.bottom),
        insideLeft: Math.round(btn.left - column.left),
        insideRight: Math.round(column.right - btn.right),
        onThePage: Math.round(btn.top),
      };
    });
    expect(geometry.aboveIt).toBeGreaterThanOrEqual(0);
    expect(geometry.insideLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.insideRight).toBeGreaterThanOrEqual(0);
    expect(geometry.onThePage).toBeGreaterThanOrEqual(0);
  });

  test("two words are not a quote", async ({ page, api }) => {
    await openPost(page, api);
    await select(page, ".detail__content", 4);
    // Long enough for a stray double-click, short enough to mean nothing.
    await page.waitForTimeout(400);
    await expect(page.locator(QUOTE)).toBeHidden();
  });

  test("the title is not part of the post", async ({ page, api }) => {
    await openPost(page, api);
    await select(page, ".detail__title", 20);
    await page.waitForTimeout(400);
    // A quote is from the body. A selection that starts anywhere else is
    // somebody selecting the page, not quoting it.
    await expect(page.locator(QUOTE)).toBeHidden();
  });

  test("it goes when the selection does", async ({ page, api }) => {
    await openPost(page, api);
    await select(page, ".detail__content", 40);
    await expect(page.locator(QUOTE)).toBeVisible();

    await clearSelection(page);
    await expect(page.locator(QUOTE)).toBeHidden();
  });

  test("it follows the reader off the post", async ({ page, api }) => {
    await openPost(page, api);
    await select(page, ".detail__content", 40);
    await expect(page.locator(QUOTE)).toBeVisible();

    await page.locator(".back").click();
    await expect(page.locator(CARD)).toHaveCount(2);
    // The post it belonged to is gone from the page, so nothing it offered can
    // still be true.
    await expect(page.locator(QUOTE)).toBeHidden();
  });

  test("it works in focus mode, which is still reading", async ({ page, api }) => {
    await openPost(page, api);
    await page.keyboard.press("f");
    await select(page, ".detail__content", 40);
    await expect(page.locator(QUOTE)).toBeVisible();
  });
});

test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });

  test("the operating system's own menu is left to it", async ({ page, api }) => {
    await openPost(page, api);
    await select(page, ".detail__content", 40);
    await page.waitForTimeout(400);

    // Not merely hidden — not drawn at all. A phone already puts Copy, Look Up
    // and Share over a selection with a handle at each end, and ours would be
    // competing for the same forty pixels and doing less.
    await expect(page.locator(QUOTE)).toBeHidden();
    const display = await page.evaluate(() => {
      const el = document.querySelector(".quote-copy");
      return el ? getComputedStyle(el).display : "missing";
    });
    expect(display).toBe("none");
  });
});
