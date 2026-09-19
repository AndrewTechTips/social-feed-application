// The colophon — the page that says how this was made.
//
// The point of the page is that it can be checked, so the point of this file is
// to check it: that the figures are the ones in the committed measurement
// rather than numbers somebody typed, that every decision it names links to a
// record that exists, and that it still reads as a page when the measurement
// can't be fetched at all.

const fs = require("fs");
const path = require("path");
const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const repoRoot = path.join(__dirname, "..", "..");
const stats = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "stats.json"), "utf8")
);

const rows = (page) =>
  page.locator(".colophon__figure").evaluateAll((els) =>
    els.map((el) => ({
      number: el.querySelector(".colophon__number").textContent.trim(),
      label: el.querySelector(".colophon__label").textContent.trim(),
    }))
  );

// ── the numbers ────────────────────────────────────────────────────────────
test("every figure is one from the committed measurement", async ({ page }) => {
  await page.goto("/#/colophon");
  await expect(page.locator(".colophon__title")).toHaveText("Colophon");

  const drawn = await rows(page);
  expect(drawn).toHaveLength(Object.keys(stats).length);

  // Read back as numbers, so a thousands separator in the page doesn't make
  // this about formatting.
  const numbers = drawn.map((r) => Number(r.number.replace(/[^0-9]/g, "")));
  for (const value of Object.values(stats)) {
    expect(numbers, `${value} should be on the page`).toContain(value);
  }
  // And nothing typed in that isn't measured.
  for (const n of numbers) {
    expect(Object.values(stats), `${n} is on the page but not in stats.json`).toContain(n);
  }
});

test("without the measurement it is still a page, just a shorter one", async ({
  page,
}) => {
  // The case this covers is real: a first visit with no network, before the
  // service worker has warmed anything.
  await page.route(/stats\.json/, (route) => route.abort());
  await page.goto("/#/colophon");

  await expect(page.locator(".colophon__title")).toHaveText("Colophon");
  await expect(page.locator(".colophon__figures")).toHaveCount(0);
  // The prose is the argument; the figures are the evidence for part of it.
  await expect(page.locator(".colophon__prose").first()).toBeVisible();
  await expect(page.locator(".colophon__decisions li")).toHaveCount(4);
});

// ── the links ──────────────────────────────────────────────────────────────
test("every decision it names has a record that exists", async ({ page }) => {
  await page.goto("/#/colophon");
  await expect(page.locator(".colophon__decisions li")).toHaveCount(4);

  const hrefs = await page
    .locator(".colophon__decisions a")
    .evaluateAll((els) => els.map((el) => el.getAttribute("href")));

  expect(hrefs).toHaveLength(4);
  for (const href of hrefs) {
    const file = href.split("/docs/adr/")[1];
    expect(file, `${href} should point into docs/adr/`).toBeTruthy();
    const onDisk = path.join(repoRoot, "docs", "adr", file);
    expect(
      fs.existsSync(onDisk),
      `the colophon links to docs/adr/${file}, which isn't there`
    ).toBe(true);
  }
});

test("the links off the site open away from it, safely", async ({ page }) => {
  await page.goto("/#/colophon");
  await expect(page.locator(".colophon__title")).toBeVisible();

  const outward = await page
    .locator('.colophon a[href^="http"]')
    .evaluateAll((els) =>
      els.map((el) => ({ target: el.target, rel: el.rel }))
    );
  expect(outward.length).toBeGreaterThan(4);
  for (const link of outward) {
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  }
});

// ── the ways in ────────────────────────────────────────────────────────────
test("the masthead offers it to a first-time visitor", async ({ page, api }) => {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  const link = page.locator(".masthead__more a");
  await expect(link).toHaveText("How this was made");
  await link.click();
  await expect(page).toHaveURL(/#\/colophon$/);
  await expect(page.locator(".colophon__title")).toBeVisible();
});

test("the palette can get there too", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette__row", { hasText: "How this was made" }).click();
  await expect(page).toHaveURL(/#\/colophon$/);
});

test("its own button opens the palette it points at", async ({ page }) => {
  await page.goto("/#/colophon");
  await page.getByRole("button", { name: "Open the palette" }).click();
  await expect(page.locator(".palette__panel")).toBeVisible();
});

// ── it is reading, so the reading size applies ─────────────────────────────
test("the size a reader set on a post applies here", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("commons.textsize", "l");
    } catch (e) {}
  });
  await page.goto("/#/colophon");
  await page.reload();
  await expect(page.locator(".colophon__title")).toBeVisible();

  const size = await page.evaluate(
    () => getComputedStyle(document.querySelector(".colophon__prose")).fontSize
  );
  expect(size).toBe("21px");
});

// ── the quality floor ──────────────────────────────────────────────────────
test("axe is clean, both themes", async ({ page }) => {
  await page.goto("/#/colophon");
  await expect(page.locator(".colophon__figures")).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await settled(page);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations, `${theme} theme`).toEqual([]);
  }
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("the figures hold their column and the page doesn't scroll sideways", async ({
    page,
  }) => {
    await page.goto("/#/colophon");
    await expect(page.locator(".colophon__figures")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // The numbers are a column, and a column that wrapped would stop being one.
    const aligned = await page.evaluate(() => {
      const cells = [...document.querySelectorAll(".colophon__number")];
      const rights = cells.map((c) => Math.round(c.getBoundingClientRect().right));
      return new Set(rights).size;
    });
    expect(aligned).toBe(1);
  });
});
