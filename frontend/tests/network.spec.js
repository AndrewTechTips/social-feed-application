// Saying so when the network has gone.
//
// The app has worked offline since the service worker shipped and never once
// mentioned it — which is the difference between working offline and looking
// like it does. tests/offline.spec.js proves the *working*; this file is about
// the saying.
//
// The network is really switched off here, by the browser, the same way
// offline.spec.js does it. Nothing about this is stubbed.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const BAND = ".netband";
const COMPOSER_LINE = ".compose__offline";
const ADA = "ada@commons.test";

async function feed(page, api) {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
}

// ── the band ───────────────────────────────────────────────────────────────
test("nothing is said while there is a network", async ({ page, api }) => {
  await feed(page, api);
  // In the document, because the network can go at any moment and the line
  // needs somewhere to appear — but not on the page.
  await expect(page.locator(BAND)).toHaveCount(1);
  await expect(page.locator(BAND)).toBeHidden();
});

test("and one line when there isn't", async ({ page, context, api }) => {
  await feed(page, api);
  await context.setOffline(true);

  await expect(page.locator(BAND)).toBeVisible();
  // What is still true, rather than what has broken. The reader can see the
  // screen; what they cannot see is whether it is still trustworthy.
  await expect(page.locator(BAND)).toContainText("Offline");
  await expect(page.locator(BAND)).toContainText("what's already here still reads");

  // Announced, but politely: losing a connection is not an emergency and a
  // screen reader should finish the sentence it is on first.
  await expect(page.locator(BAND)).toHaveAttribute("role", "status");
  await expect(page.locator(BAND)).toHaveAttribute("aria-live", "polite");

  await context.setOffline(false);
  await expect(page.locator(BAND)).toBeHidden();
});

test("it is a state, not an event — no toasts, however much it flaps", async ({
  page,
  context,
  api,
}) => {
  // `online` and `offline` fire on every flap of a bad connection. A toast per
  // event would be the app shouting about its own plumbing, which is the
  // failure mode this design is arranged around.
  await feed(page, api);
  for (let i = 0; i < 4; i++) {
    await context.setOffline(true);
    await expect(page.locator(BAND)).toBeVisible();
    await context.setOffline(false);
    await expect(page.locator(BAND)).toBeHidden();
  }
  await settled(page);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("it survives a navigation, because it is not part of any screen", async ({
  page,
  context,
  api,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "demo",
    "navigating with the network off only works where the app answers itself"
  );
  await feed(page, api);
  await context.setOffline(true);
  await expect(page.locator(BAND)).toBeVisible();

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  // Mounted once, outside #view, so the router replacing a screen cannot take
  // it with it.
  await expect(page.locator(BAND)).toBeVisible();
  await context.setOffline(false);
});

test("the demo notice and the offline notice are two sentences, not a collision", async ({
  page,
  context,
  api,
}, testInfo) => {
  test.skip(testInfo.project.name !== "demo", "there is only a demo band in demo mode");
  await api.seed(1);
  await page.goto("/#/colophon");
  await expect(page.locator(".colophon__title")).toBeVisible();
  await context.setOffline(true);
  await expect(page.locator(BAND)).toBeVisible();

  // Both up, stacked, in that order: what this app *is* stays closest to the
  // header it belongs to.
  const order = await page.evaluate(() => {
    const demo = document.querySelector(".demo--band");
    const net = document.querySelector(".netband");
    if (!demo || !net) return "one of them is missing";
    return demo.compareDocumentPosition(net) & Node.DOCUMENT_POSITION_FOLLOWING
      ? "demo, then offline"
      : "offline, then demo";
  });
  expect(order).toBe("demo, then offline");
  await context.setOffline(false);
});

// ── the composer ───────────────────────────────────────────────────────────
test("the composer says what it has kept", async ({ page, context, api }) => {
  await api.seed(1, ADA);
  await api.signIn(page, ADA, "seedpassword");
  await page.goto("/#/compose");
  await expect(page.locator(".compose__panel")).toBeVisible();
  await expect(page.locator(COMPOSER_LINE)).toBeHidden();

  await context.setOffline(true);
  await expect(page.locator(COMPOSER_LINE)).toBeVisible();
  await expect(page.locator(COMPOSER_LINE)).toContainText("saved in this browser");

  await context.setOffline(false);
  await expect(page.locator(COMPOSER_LINE)).toBeHidden();
});

test("and it is telling the truth — the words really are in storage", async ({
  page,
  context,
  api,
}) => {
  // The line is a promise about js/draft.js. Worth holding it to that rather
  // than to its own wording.
  await api.seed(1, ADA);
  await api.signIn(page, ADA, "seedpassword");
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("Written on a train");
  await page.getByLabel("Body").fill("Somewhere past Didcot the signal went.");

  await context.setOffline(true);
  await expect(page.locator(COMPOSER_LINE)).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("commons.draft")))
    .toContain("Didcot");
  await context.setOffline(false);
});

test("and they come back after a reload with the network still off", async ({
  page,
  context,
  api,
}, testInfo) => {
  // The end of the promise, and the only part that needs the service worker:
  // reloading fetches the whole app again, so this is the case the shell cache
  // exists for. Demo mode only, for the reason tests/offline.spec.js gives —
  // against a real API, offline is offline.
  test.skip(
    testInfo.project.name !== "demo",
    "only the published build is self-contained"
  );

  await api.seed(1, ADA);
  await api.signIn(page, ADA, "seedpassword");
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("Written on a train");
  await page.getByLabel("Body").fill("Somewhere past Didcot the signal went.");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("commons.draft")))
    .toContain("Didcot");

  // `ready` resolves once install's waitUntil has settled, which is where the
  // shell is warmed — the point at which a reader could go into a tunnel.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);

  await context.setOffline(true);
  await page.reload();

  await expect(page.locator(".compose__panel")).toBeVisible();
  await expect(page.locator(COMPOSER_LINE)).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Written on a train"
  );
  await expect(page.getByLabel("Body")).toHaveValue(
    "Somewhere past Didcot the signal went."
  );
  await context.setOffline(false);
});

// ── the quality floor ──────────────────────────────────────────────────────
test("axe is clean with the band up, both themes", async ({ page, context, api }) => {
  await feed(page, api);
  await context.setOffline(true);
  await expect(page.locator(BAND)).toBeVisible();

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
  await context.setOffline(false);
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("both bands fit without pushing the page sideways", async ({
    page,
    context,
    api,
  }) => {
    await feed(page, api);
    await context.setOffline(true);
    await expect(page.locator(BAND)).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // And the first card is still reachable under them, rather than pushed
    // under a stack of notices.
    await expect(page.locator(CARD).first()).toBeVisible();
    await context.setOffline(false);
  });
});
