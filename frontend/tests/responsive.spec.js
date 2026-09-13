// Responsive checks: no horizontal scroll at any size, the header collapses on
// narrow screens, tap targets stay big enough, and the reading column is capped
// on the desktop.

const { test, expect, CARD } = require("./support/fixtures");

const widths = [320, 360, 390, 414, 768, 1280];

for (const width of widths) {
  test(`no horizontal overflow at ${width}px`, async ({ page, api }) => {
    await api.seed(6, "ada@commons.test");
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/");
    await expect(page.locator(CARD).first()).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test("the header collapses to two rows on a narrow screen", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");

  const brand = page.getByRole("link", { name: "Commons — home" });
  const search = page.getByRole("searchbox");
  await expect(brand).toBeVisible();
  await expect(search).toBeVisible();

  const brandBox = await brand.boundingBox();
  const searchBox = await search.boundingBox();
  // search has dropped below the brand rather than sitting beside it
  expect(searchBox.y).toBeGreaterThan(brandBox.y + brandBox.height - 1);
});

test("tap targets on the feed are at least 44px", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");

  const vote = page.getByRole("button", { name: /upvote/i }).first();
  const box = await vote.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
});

test("the reading column stays narrow on a wide desktop", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const card = page.locator(CARD).first();
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box.width).toBeLessThanOrEqual(680);
});
