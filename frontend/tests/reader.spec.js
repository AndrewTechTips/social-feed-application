// The reading panel, focus mode, and what a post looks like on paper.
//
// All three are CSS switched by one attribute, so what's worth testing isn't
// that a class landed — it's the consequences: that the size survives a reload
// and is in place before the first paint, that focus mode leaves a way out and
// doesn't follow you off the post, and that a printed page isn't white on
// white.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const PANEL = ".typeset";
const OPEN = ".typeset__open";
const FOCUS_OUT = ".focus-out";

// `.choice__step` since the radio group moved out of reader.js and became a
// shared control — see js/components/radiogroup.js.
const step = (page, label) => page.locator(".choice__step", { hasText: label });

const rootData = (page, key) =>
  page.evaluate((k) => document.documentElement.dataset[k] || null, key);

const fontSizeOf = (page, selector) =>
  page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel)).fontSize,
    selector
  );

async function openPost(page, api, count = 2) {
  await api.seed(count);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(count);
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
}

// ── the panel ──────────────────────────────────────────────────────────────
test("the panel is closed until it's asked for", async ({ page, api }) => {
  await openPost(page, api);
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(OPEN)).toHaveAttribute("aria-expanded", "false");

  await page.locator(OPEN).click();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(OPEN)).toHaveAttribute("aria-expanded", "true");

  await page.locator(OPEN).click();
  await expect(page.locator(PANEL)).toBeHidden();
});

test("the size changes the post and nothing else", async ({ page, api }) => {
  await openPost(page, api);
  const before = await fontSizeOf(page, ".detail__content");
  const bylineBefore = await fontSizeOf(page, ".detail__byline");
  expect(before).toBe("18px"); // --fs-read, the default

  await page.locator(OPEN).click();
  await step(page, "Large").click();
  expect(await fontSizeOf(page, ".detail__content")).toBe("21px");
  // The chrome is not in scope: this is a setting about a paragraph, not a
  // zoom control — the browser already has a better one of those.
  expect(await fontSizeOf(page, ".detail__byline")).toBe(bylineBefore);

  await step(page, "Small").click();
  expect(await fontSizeOf(page, ".detail__content")).toBe("16px");
});

test("the size survives a reload, and is set before the first paint", async ({
  page,
  api,
}) => {
  await openPost(page, api);
  await page.locator(OPEN).click();
  await step(page, "Large").click();
  expect(await rootData(page, "textSize")).toBe("l");

  await page.reload();
  await expect(page.locator(".detail__title")).toBeVisible();
  // The attribute comes from the inline bootstrap in index.html, which runs
  // before the stylesheets have painted anything — the same arrangement the
  // theme has, and for the same reason.
  expect(await rootData(page, "textSize")).toBe("l");
  expect(await fontSizeOf(page, ".detail__content")).toBe("21px");
  await page.locator(OPEN).click();
  await expect(step(page, "Large").locator("input")).toBeChecked();
});

// ── focus mode ─────────────────────────────────────────────────────────────
test("focus mode clears the page and leaves one way out", async ({ page, api }) => {
  await openPost(page, api);
  await expect(page.locator(".comments")).toBeVisible();
  await expect(page.locator(FOCUS_OUT)).toBeHidden();

  await page.keyboard.press("f");
  expect(await rootData(page, "focus")).toBe("on");

  for (const gone of [".back", ".detail__row", ".comments", ".onward"]) {
    await expect(page.locator(gone)).toBeHidden();
  }
  // The header keeps its shape — it is what holds the way out — but the three
  // things in it stand down.
  await expect(page.locator(".site-header")).toBeVisible();
  await expect(page.locator(".brand")).toBeHidden();
  await expect(page.locator(".account")).toBeHidden();
  await expect(page.locator(FOCUS_OUT)).toBeVisible();
  // And the post is still there, which is the entire point.
  await expect(page.locator(".detail__content")).toBeVisible();

  await page.locator(FOCUS_OUT).click();
  expect(await rootData(page, "focus")).toBe(null);
  await expect(page.locator(".comments")).toBeVisible();
  await expect(page.locator(".brand")).toBeVisible();
});

test("Escape leaves it too", async ({ page, api }) => {
  await openPost(page, api);
  await page.keyboard.press("f");
  expect(await rootData(page, "focus")).toBe("on");
  await page.keyboard.press("Escape");
  expect(await rootData(page, "focus")).toBe(null);
});

test("it narrows the column", async ({ page, api }) => {
  await openPost(page, api);
  const wide = await page.evaluate(
    () => document.querySelector(".detail__content").getBoundingClientRect().width
  );
  await page.keyboard.press("f");
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector(".detail__content").getBoundingClientRect().width
      )
    )
    .toBeLessThan(wide);
});

test("it does not follow you off the post", async ({ page, api }) => {
  await openPost(page, api);
  await page.keyboard.press("f");
  expect(await rootData(page, "focus")).toBe("on");

  // The way back is hidden, so use the one that isn't: the header's exit, then
  // the brand. Leaving by any route at all has to end the mode — otherwise a
  // reader arrives at a feed with no header, no search and no account.
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  expect(await rootData(page, "focus")).toBe(null);
  await expect(page.locator(".brand")).toBeVisible();
  await expect(page.locator(".account")).toBeVisible();
});

test("the palette offers it on a post and nowhere else", async ({ page, api }) => {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette__row", { hasText: "focus mode" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const row = page.locator(".palette__row", { hasText: "Read it in focus mode" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("F");
  await row.click();
  expect(await rootData(page, "focus")).toBe("on");
});

test("the panel's own controls do not switch the keys off", async ({ page, api }) => {
  await openPost(page, api);
  await page.locator(OPEN).click();
  await step(page, "Large").click();
  // Focus is now inside a radio in the panel. A radio has no letter to steal —
  // the keys that operate it are arrows and space — so `f` has to keep working.
  // It didn't, once: the guard asked only whether the target was an <input>,
  // and the panel that advertises `f` was the thing that turned it off.
  await expect(step(page, "Large").locator("input")).toBeFocused();
  await page.keyboard.press("f");
  expect(await rootData(page, "focus")).toBe("on");
});

test("the keys stay out of a comment box", async ({ page, api }) => {
  await api.seed(2, "ada@commons.test");
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  const box = page.locator(".composer .textarea");
  await box.pressSequentially("off to focus");
  await expect(box).toHaveValue("off to focus");
  expect(await rootData(page, "focus")).toBe(null);
});

// ── on paper ───────────────────────────────────────────────────────────────
test("a printed post is ink on paper, not white on white", async ({ page, api }) => {
  await openPost(page, api);
  // Dark theme is the default, and the failure this guards against is exactly
  // that: #e7edec printed on white is a blank sheet.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.emulateMedia({ media: "print" });

  const ink = await page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const body = read("body");
    return {
      bodyBg: body.backgroundColor,
      title: read(".detail__title").color,
      content: read(".detail__content").color,
      header: read(".site-header").display,
      aurora: read(".aurora").display,
      row: read(".detail__row").display,
      comments: read(".comments").display,
      back: read(".back").display,
    };
  });

  expect(ink.bodyBg).toBe("rgb(255, 255, 255)");
  expect(ink.title).toBe("rgb(0, 0, 0)");
  expect(ink.content).toBe("rgb(0, 0, 0)");
  for (const [what, value] of Object.entries(ink)) {
    if (what.endsWith("Bg") || what === "title" || what === "content") continue;
    expect(value, `${what} should be off the page`).toBe("none");
  }

  await page.emulateMedia({ media: null });
});

// ── the quality floor ──────────────────────────────────────────────────────
test("axe is clean with the panel open, and in focus mode", async ({ page, api }) => {
  await openPost(page, api);
  await page.locator(OPEN).click();
  await expect(page.locator(PANEL)).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await settled(page);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations, `panel, ${theme} theme`).toEqual([]);
  }

  await page.keyboard.press("f");
  await settled(page);
  const focused = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(focused.violations, "focus mode").toEqual([]);
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("three controls and the panel still fit", async ({ page, api }) => {
    await openPost(page, api);
    const overflow = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
    expect(await overflow()).toBeLessThanOrEqual(0);

    await page.locator(OPEN).click();
    await expect(page.locator(PANEL)).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);

    // Every step is still a target a finger can hit.
    for (const label of ["Small", "Medium", "Large"]) {
      const box = await step(page, label).boundingBox();
      expect(box.height, label).toBeGreaterThanOrEqual(32);
    }

    await page.keyboard.press("f");
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.locator(FOCUS_OUT)).toBeVisible();
  });
});
