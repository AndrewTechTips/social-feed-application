// The post as a reading experience: the progress hairline, and the headings.
//
// Both are pure CSS and both are meant to be invisible when they work, which
// is exactly why they need a test — nothing else would ever notice them
// breaking.

const { test, expect, CARD } = require("./support/fixtures");

const scrollDriven = (page) =>
  page.evaluate(() => CSS.supports("animation-timeline", "scroll()"));

// The bar is scaled with a transform, so its *painted* width is what matters —
// which is what a bounding rect measures.
const barWidth = (page) =>
  page.locator(".reading").evaluate((el) => el.getBoundingClientRect().width);

const longPost = async (api) => {
  const { created } = await (await api.seed(1, "ada@commons.test")).json();
  return created[0];
};

test("there is no bar anywhere but on a post", async ({ page, api }) => {
  await api.seed(2, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  await expect(page.locator(".reading")).toBeHidden();

  await page.locator(".card__title").first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  // Not toBeVisible: at the top of a post the bar is scaled to nothing, which
  // is precisely the state being checked for — an empty track, not a missing
  // element.
  const shown = () =>
    page.locator(".reading").evaluate((el) => getComputedStyle(el).display);

  if (await scrollDriven(page)) {
    expect(await shown()).toBe("block");
  } else {
    // Where scroll-driven animations aren't supported the whole rule is inside
    // a @supports block, so the span keeps its display:none and there is no
    // stray amber rule across the header. That is the entire fallback.
    await expect(page.locator(".reading")).toBeHidden();
  }
});

test("it lies on the header's bottom edge, wherever that is", async ({ page, api }) => {
  test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");
  await page.goto(`/#/posts/${await longPost(api)}`);
  await expect(page.locator(".detail__title")).toBeVisible();

  const { barTop, headerBottom } = await page.evaluate(() => ({
    barTop: document.querySelector(".reading").getBoundingClientRect().top,
    headerBottom: document.querySelector(".site-header").getBoundingClientRect().bottom,
  }));
  // Sitting *on* the 1px border rather than under it — measured, not assumed
  // from --header-h, because a notch moves the header and this must follow it.
  expect(Math.abs(barTop - (headerBottom - 1))).toBeLessThanOrEqual(1.5);
});

test("it fills as you read, and is empty before you start", async ({ page, api }) => {
  test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");

  // A body long enough to scroll several screens, so there is a real middle.
  await api.register("ada@commons.test", "seedpassword", "ada");
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/#/compose");
  await page.locator("#post-title").fill("A long walk");
  // Long enough to scroll several screens, short enough to stay inside the
  // 5,000-character limit the composer enforces.
  await page.locator("#post-content").fill(
    Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i + 1}. ` + "Words about a wall. ".repeat(11)
    ).join("\n\n")
  );
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".detail__title")).toHaveText("A long walk");

  const full = await page.evaluate(() => innerWidth);
  await expect.poll(() => barWidth(page), { message: "empty at the top" }).toBeLessThan(4);

  const max = await page.evaluate(
    () => document.documentElement.scrollHeight - innerHeight
  );
  expect(max, "the post needs to actually scroll").toBeGreaterThan(600);

  await page.evaluate((y) => window.scrollTo(0, y), Math.round(max / 2));
  await expect
    .poll(() => barWidth(page), { message: "about half way at half way" })
    .toBeGreaterThan(full * 0.3);
  expect(await barWidth(page)).toBeLessThan(full * 0.7);

  await page.evaluate((y) => window.scrollTo(0, y), max);
  await expect.poll(() => barWidth(page), { message: "full at the end" }).toBeGreaterThan(
    full * 0.95
  );
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("keeps telling the truth instead of snapping to full", async ({ page, api }) => {
    test.skip(!(await scrollDriven(page)), "no scroll-driven animations here");
    await page.goto(`/#/posts/${await longPost(api)}`);
    await expect(page.locator(".detail__title")).toBeVisible();

    // base.css collapses every animation-duration to 0.01ms under reduced
    // motion. With a progress-based timeline that would fill the bar at the
    // first pixel of scroll — a lie, and the one failure mode this exemption
    // exists to prevent.
    expect(
      await page.locator(".reading").evaluate((el) => getComputedStyle(el).animationDuration)
    ).toBe("auto");
    await expect.poll(() => barWidth(page)).toBeLessThan(4);
  });
});

test("it is drawn, never spoken", async ({ page, api }) => {
  await page.goto(`/#/posts/${await longPost(api)}`);
  await expect(page.locator(".detail__title")).toBeVisible();
  await expect(page.locator(".reading")).toHaveAttribute("aria-hidden", "true");
});

test("headings balance their lines; prose doesn't", async ({ page, api }) => {
  await api.seed(2, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  const style = (sel) =>
    page.locator(sel).first().evaluate((el) => {
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
