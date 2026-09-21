// The reading controls on #/settings — text size and line width.
//
// Almost nothing here is new machinery. `reading.js` has stored both since the
// reader panel shipped, and this is the same two settings offered in the place
// somebody looks for them when they are not on a post. So what is worth
// testing is not that a radio writes a value — reader.spec.js has that — but
// the three claims this screen makes that the panel on a post does not:
//
//   **There is one value, not a default and an override.** Both controls write
//   the same key, so choosing here moves the panel's radios and vice versa.
//   The word "default" is deliberately absent from the copy for this reason,
//   and the tests below are what stop it becoming true by accident.
//
//   **The specimen is not an illustration.** It claims to be "set the way a
//   post will be", and it is only entitled to say so if it is pixel-identical
//   to a real post's column at every combination. That is an assertion, not a
//   design note — see the last block.
//
//   **Two widths, not four.** The type system chose 66ch with this face at
//   this size; the second step is a narrower column for a long sitting, not an
//   invitation to set 90ch and conclude the typography is bad.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const ACCOUNT = { email: "ada@commons.test", password: "seedpassword" };

const size = (page, v) =>
  page.locator(`input[name="settings-text-size"][value="${v}"]`);
const width = (page, v) => page.locator(`input[name="settings-measure"][value="${v}"]`);
const specimen = (page) => page.locator(".specimen");

/** What is applied to the document, which is the only thing either control does. */
const applied = (page) =>
  page.evaluate(() => ({
    size: document.documentElement.dataset.textSize,
    measure: document.documentElement.dataset.measure,
    storedSize: localStorage.getItem("commons.textsize"),
    storedMeasure: localStorage.getItem("commons.measure"),
  }));

async function onSettings(page, api) {
  await api.seed(1, ACCOUNT.email);
  await api.signIn(page, ACCOUNT.email, ACCOUNT.password);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
}

/** Open the first post and come back with its body. */
async function openPost(page) {
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__content")).toBeVisible();
  return page.locator(".detail__content");
}

/**
 * The column travels rather than jumping — `transition: max-width` on both the
 * post's body and the specimen — so a width read straight after a click is a
 * width in motion. Measuring without this produced numbers that looked
 * scrambled and were simply early.
 */
async function measured(locator) {
  await locator.evaluate(
    (el) =>
      new Promise((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 400)));
      })
  );
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      width: Math.round(el.getBoundingClientRect().width),
      fontSize: cs.fontSize,
      family: cs.fontFamily.split(",")[0].replace(/"/g, ""),
    };
  });
}

// ── the controls ───────────────────────────────────────────────────────────

test("both settings are offered, at the steps the type system chose", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  await expect(page.locator('input[name="settings-text-size"]')).toHaveCount(3);
  // Two, not four, and not a slider. See the header of this file.
  await expect(page.locator('input[name="settings-measure"]')).toHaveCount(2);

  await expect(page.getByRole("group", { name: "Text size" })).toBeAttached();
  await expect(page.getByRole("group", { name: "Line width" })).toBeAttached();
});

test("choosing a size applies it and keeps it", async ({ page, api }) => {
  await onSettings(page, api);

  await size(page, "l").click();
  expect(await applied(page)).toMatchObject({ size: "l", storedSize: "l" });

  await page.reload();
  await expect(page.locator(".data")).toBeVisible();
  await expect(size(page, "l")).toBeChecked();
  expect((await applied(page)).size).toBe("l");
});

test("choosing a width applies it and keeps it", async ({ page, api }) => {
  await onSettings(page, api);

  await width(page, "narrow").click();
  expect(await applied(page)).toMatchObject({
    measure: "narrow",
    storedMeasure: "narrow",
  });

  await page.reload();
  await expect(page.locator(".data")).toBeVisible();
  await expect(width(page, "narrow")).toBeChecked();
});

// ── one value, not a default and an override ──────────────────────────────

test("the panel on a post and this screen are the same setting", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await size(page, "l").click();
  await width(page, "narrow").click();

  // The panel has to arrive already showing what was chosen here. If these
  // were a default and an override, it would not.
  const body = await openPost(page);
  await page.locator(".typeset__open").click();
  await expect(
    page.locator('input[name="commons-text-size"][value="l"]')
  ).toBeChecked();
  await expect(
    page.locator('input[name="commons-measure"][value="narrow"]')
  ).toBeChecked();
  expect((await measured(body)).fontSize).toBe("21px");
});

test("and changing it on a post changes it here", async ({ page, api }) => {
  await onSettings(page, api);
  await size(page, "s").click();

  await openPost(page);
  await page.locator(".typeset__open").click();
  await page.locator('input[name="commons-text-size"][value="m"]').click();

  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  await expect(size(page, "m")).toBeChecked();
  await expect(size(page, "s")).not.toBeChecked();
});

test("the data panel notices, and its Reset puts both back", async ({ page, api }) => {
  await onSettings(page, api);

  await size(page, "l").click();
  await width(page, "narrow").click();
  await expect(page.locator('[data-row="appearance"]')).toContainText(
    "Theme, text size"
  );

  await page.locator('[data-row="appearance"] .data__do').click();

  // Removed rather than set to the defaults — the same distinction the theme
  // makes, for the same reason.
  expect(await applied(page)).toEqual({
    size: "m",
    measure: "normal",
    storedSize: null,
    storedMeasure: null,
  });
  await expect(size(page, "m")).toBeChecked();
  await expect(width(page, "normal")).toBeChecked();
});

// ── the specimen is a specimen, not an illustration ───────────────────────

test("the specimen is the reading face, and moves with the settings", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  await size(page, "s").click();
  const small = await measured(specimen(page));
  expect(small.family).toBe("Newsreader");
  expect(small.fontSize).toBe("16px");

  await size(page, "l").click();
  const large = await measured(specimen(page));
  expect(large.fontSize).toBe("21px");
  // No JavaScript touches it — it asks for --fs-read and --measure, so it
  // cannot fall out of step with the controls above it.
  expect(large.width).not.toBe(small.width);
});

test("the specimen matches a real post at every combination", async ({ page, api }) => {
  await onSettings(page, api);

  /** @type {Record<string, {width: number, fontSize: string}>} */
  const here = {};
  for (const s of ["s", "m", "l"]) {
    for (const w of ["normal", "narrow"]) {
      await size(page, s).click();
      await width(page, w).click();
      const m = await measured(specimen(page));
      here[`${s}/${w}`] = { width: m.width, fontSize: m.fontSize };
    }
  }

  const body = await openPost(page);
  await page.locator(".typeset__open").click();
  for (const s of ["s", "m", "l"]) {
    for (const w of ["normal", "narrow"]) {
      await page.locator(`input[name="commons-text-size"][value="${s}"]`).click();
      await page.locator(`input[name="commons-measure"][value="${w}"]`).click();
      const m = await measured(body);
      // The whole claim in the specimen's own sentence: "set the way a post
      // will be". Both ask for the same two custom properties and both sit in
      // a --col-max column, so this is true by construction — and this is
      // what notices the day one of those stops being so.
      expect({ width: m.width, fontSize: m.fontSize }, `${s}/${w}`).toEqual(
        here[`${s}/${w}`]
      );
    }
  }
});

test("a narrow column at Large is not a narrow column at Small", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await width(page, "narrow").click();

  await size(page, "s").click();
  const small = await measured(specimen(page));
  await size(page, "l").click();
  const large = await measured(specimen(page));

  // The measure is written in `ch`, so it moves with the text size. The
  // specimen is the only place in the app that shows this, and it is the one
  // interaction between the two controls somebody would otherwise never see.
  expect(large.width).toBeGreaterThan(small.width);
});

// ── the quality floor ──────────────────────────────────────────────────────

test("axe is clean with both groups on screen, in both themes", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await size(page, "l").click();
  await width(page, "narrow").click();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await settled(page);
    const { violations } = await new AxeBuilder({ page })
      .include(".settings")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
    expect(summary, `${theme}:\n${summary.join("\n")}`).toEqual([]);
  }
});

test("each group is one tab stop, walked by the arrows", async ({ page, api }) => {
  await onSettings(page, api);

  await size(page, "s").focus();
  await page.keyboard.press("ArrowRight");
  await expect(size(page, "m")).toBeChecked();

  // And the two groups are separate — arrowing off the end of one must not
  // walk into the other, which is what the distinct `name` is for.
  await page.keyboard.press("ArrowRight");
  await expect(size(page, "l")).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(size(page, "s")).toBeChecked();
  await expect(width(page, "normal")).toBeChecked();
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("both groups fit, and the specimen does not push the page sideways", async ({
    page,
    api,
  }) => {
    await onSettings(page, api);
    await size(page, "l").click();

    await expect(specimen(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    // The specimen asks for --measure, which at Large is far wider than a
    // phone. max-width rather than width is what keeps that a ceiling rather
    // than a demand.
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
