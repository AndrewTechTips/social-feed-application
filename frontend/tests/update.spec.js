// The update beacon.
//
// js/update.js reads version.json when the tab becomes visible and puts a band
// on screen if the sha has moved since the document booted. The mechanism is
// small, and every interesting thing about it is a case where it must stay
// *quiet* — which is exactly the kind of thing that passes by doing nothing at
// all. So most of what is below is a test that nothing happened for the right
// reason rather than by accident, and each one changes the sha afterwards to
// prove the band it was expecting silence from can still appear.

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./support/fixtures");

const versionFile = path.join(__dirname, "..", "version.json");
const BAND = ".updateband";

/** Write version.json as the deploy would. */
function stamp(sha) {
  fs.writeFileSync(versionFile, JSON.stringify({ sha, built: "2026-09-23T00:00:00Z" }));
}

/**
 * Deploy, from the browser's point of view.
 *
 * The page only looks when it becomes visible, so a test that changes the file
 * and waits would wait forever. This is the reader coming back to the tab.
 */
async function deploy(page, sha) {
  stamp(sha);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test.beforeEach(() => {
  // A checkout has no version.json — it is written at deploy time and ignored
  // by git — so every test starts from that and says what it wants.
  fs.rmSync(versionFile, { force: true });
});

test.afterEach(() => {
  fs.rmSync(versionFile, { force: true });
});

// ── the quiet cases ────────────────────────────────────────────────────────

test("a first visit is never told it is out of date", async ({ page, api }) => {
  await api.seed(1);
  stamp("aaaaaaa");
  await page.goto("/");
  await expect(page.locator(".card:not(.card--skeleton)")).toHaveCount(1);

  // The first read is a baseline, not a comparison. Nothing to compare against
  // is the whole of the first-visit case, and getting this wrong would greet
  // every new reader with a notice that the app they just opened is old.
  await expect(page.locator(BAND)).toBeHidden();

  // Not silent because it is broken: the same page, one deploy later.
  await deploy(page, "bbbbbbb");
  await expect(page.locator(BAND)).toBeVisible();
});

test("a checkout with no version.json says nothing, and does not throw", async ({
  page,
  api,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await api.seed(1);
  await page.goto("/"); // no version.json at all — every fetch 404s
  await expect(page.locator(".card:not(.card--skeleton)")).toHaveCount(1);

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(BAND)).toBeHidden();
  expect(errors).toEqual([]);

  // And the moment one appears, it becomes the baseline rather than a change —
  // arriving at a file that was missing is not evidence that the app moved.
  await deploy(page, "aaaaaaa");
  await expect(page.locator(BAND)).toBeHidden();
  await deploy(page, "bbbbbbb");
  await expect(page.locator(BAND)).toBeVisible();
});

test("an unchanged sha is not a new version", async ({ page, api }) => {
  await api.seed(1);
  stamp("aaaaaaa");
  await page.goto("/");
  await expect(page.locator(".card:not(.card--skeleton)")).toHaveCount(1);

  for (let i = 0; i < 3; i++) await deploy(page, "aaaaaaa");
  await expect(page.locator(BAND)).toBeHidden();

  await deploy(page, "bbbbbbb");
  await expect(page.locator(BAND)).toBeVisible();
});

test("a version.json that stops answering is not a new version", async ({
  page,
  api,
}) => {
  await api.seed(1);
  stamp("aaaaaaa");
  await page.goto("/");
  await expect(page.locator(".card:not(.card--skeleton)")).toHaveCount(1);

  // A Pages hiccup, a reader in a tunnel, a deploy half-way through. None of
  // them are evidence that the app changed, and a band that appeared on a
  // failed request would appear most often when it could be least trusted.
  fs.rmSync(versionFile, { force: true });
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(BAND)).toBeHidden();

  // The baseline survived the outage: the *original* sha is still what a
  // change is measured against, so the deploy that follows is still caught.
  await deploy(page, "bbbbbbb");
  await expect(page.locator(BAND)).toBeVisible();
});

// ── the loud one ───────────────────────────────────────────────────────────

test("a deploy puts a band up, and its button reloads onto the new version", async ({
  page,
  api,
}) => {
  await api.seed(1);
  stamp("aaaaaaa");
  await page.goto("/");
  await expect(page.locator(".card:not(.card--skeleton)")).toHaveCount(1);

  await deploy(page, "bbbbbbb");
  const band = page.locator(BAND);
  await expect(band).toBeVisible();
  await expect(band).toContainText("A new version is ready");
  // Polite, like the offline band: a screen reader finishes its sentence.
  await expect(band).toHaveAttribute("role", "status");
  await expect(band).toHaveAttribute("aria-live", "polite");

  // Its own element, so the offline band's "exactly one of me" still holds.
  await expect(page.locator(".netband")).toHaveCount(1);

  await band.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator(".card:not(.card--skeleton)")).toHaveCount(1);
  // Gone, because the document it was complaining about is gone: the reloaded
  // page takes "bbbbbbb" as its own baseline.
  await expect(page.locator(BAND)).toBeHidden();
});

test("it latches — one band per deploy, not one per look", async ({ page, api }) => {
  await api.seed(1);
  stamp("aaaaaaa");
  await page.goto("/");
  await expect(page.locator(".card:not(.card--skeleton)")).toHaveCount(1);

  await deploy(page, "bbbbbbb");
  await expect(page.locator(BAND)).toBeVisible();
  for (let i = 0; i < 3; i++) await deploy(page, "ccccccc");
  await expect(page.locator(BAND)).toBeVisible();
});

// ── the worker keeps its hands off ─────────────────────────────────────────

test("version.json is never cached by the service worker", async ({ page, api }) => {
  await api.seed(1);
  stamp("aaaaaaa");
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await deploy(page, "bbbbbbb");
  await expect(page.locator(BAND)).toBeVisible();

  // A freshness check answered out of a cache is not a freshness check. sw.js
  // declines to handle this one path; if that guard ever goes, the beacon
  // would start reporting whatever it last saw.
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) urls.push(req.url);
    }
    return urls;
  });
  expect(cached.filter((u) => u.includes("version.json"))).toEqual([]);
  expect(cached.length).toBeGreaterThan(0);

  // And it is not precached either: a file in SHELL is a file fetched on
  // install, which would put it in the cache by the other door.
  const shell = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
  expect(shell).not.toContain('"./version.json"');
});
