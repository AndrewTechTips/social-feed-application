// The service worker.
//
// Three things worth holding it to, and the first one is the reason this file
// exists at all: sw.js is the one module the type checker can't see (a worker
// needs the WebWorker lib, the app needs DOM, and one tsconfig can't declare
// both), so its list of shell files has nothing but a test keeping it honest.

const fs = require("fs");
const path = require("path");
const { test, expect, CARD, API_ORIGIN } = require("./support/fixtures");

const appDir = path.join(__dirname, "..");

/** The SHELL array out of sw.js, as written. */
function shellList() {
  const src = fs.readFileSync(path.join(appDir, "sw.js"), "utf8");
  const block = src.match(/const SHELL = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error("couldn't find the SHELL array in sw.js");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every file under a directory, as "./dir/name" paths. */
function filesUnder(dir, extensions) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (extensions.some((e) => entry.name.endsWith(e))) out.push(`.${next}`);
    }
  };
  walk(`/${dir}`);
  return out.sort();
}

// ── the list ───────────────────────────────────────────────────────────────
test("the shell list still matches what's on disk", () => {
  const shell = new Set(shellList());
  // Everything the app is made of. Not assets/ — an icon that isn't listed
  // costs a missing icon offline, whereas a module that isn't listed costs the
  // app, and the difference is worth the rule being about the code.
  const onDisk = [...filesUnder("js", [".js", ".json"]), ...filesUnder("styles", [".css"])];

  const missing = onDisk.filter((f) => !shell.has(f));
  expect(missing, `add these to SHELL in sw.js:\n${missing.join("\n")}`).toEqual([]);

  // And the other way: a path that no longer exists is a request that 404s on
  // every install, quietly, forever.
  const stale = [...shell].filter(
    (f) => f !== "./" && !fs.existsSync(path.join(appDir, f.slice(2)))
  );
  expect(stale, `these are in SHELL but not on disk:\n${stale.join("\n")}`).toEqual([]);
});

// ── it takes over ──────────────────────────────────────────────────────────
test("a worker registers and takes control of the page", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);

  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.scope;
  });
  // The app's own directory, not js/ — a worker scoped below the app can't see
  // the app.
  expect(new URL(scope).pathname).toBe("/");

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
});

test("the API is left alone", async ({ page, api }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "demo mode makes no API requests at all — there is nothing to leave alone"
  );
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
  await page.evaluate(() => navigator.serviceWorker.ready);

  // Nothing from the backend's origin may end up in our cache. It is a
  // different origin here, and on the published site it doesn't exist — but a
  // cached feed would be a stale feed, and a cached write would be a lie.
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) urls.push(req.url);
    }
    return urls;
  });
  expect(cached.filter((u) => u.startsWith(API_ORIGIN))).toEqual([]);
  expect(cached.length).toBeGreaterThan(0);
});

// ── it works with the network gone ─────────────────────────────────────────
test("the app opens with no network at all", async ({ page, context, api }, testInfo) => {
  test.skip(
    testInfo.project.name !== "demo",
    "only the published build is self-contained; against a real API, offline is offline"
  );

  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
  // `ready` resolves once install's waitUntil has settled, which is where the
  // shell is warmed — so this is the point at which a reader could shut the lid.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);

  await context.setOffline(true);
  await page.reload();

  // The whole app: the shell out of the cache, the data out of localStorage,
  // and the API answered by a module that was itself served from the cache.
  await expect(page.locator(".masthead")).toBeVisible();
  await expect(page.locator(CARD).first()).toBeVisible();
  // The reading face too, not just the markup — a font that failed would leave
  // the page readable and wrong.
  const fontLoaded = await page.evaluate(() => document.fonts.check('1rem "Newsreader"'));
  expect(fontLoaded).toBe(true);

  // And navigation still works, because every address here is the same
  // document and the cache knows it.
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  await context.setOffline(false);
});
