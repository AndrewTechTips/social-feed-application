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
    for (const entry of fs.readdirSync(path.join(appDir, rel), {
      withFileTypes: true,
    })) {
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
  const onDisk = [
    ...filesUnder("js", [".js", ".json"]),
    ...filesUnder("styles", [".css"]),
  ];

  const missing = onDisk.filter((f) => !shell.has(f));
  expect(missing, `add these to SHELL in sw.js:\n${missing.join("\n")}`).toEqual([]);

  // And the other way: a path that no longer exists is a request that 404s on
  // every install, quietly, forever.
  const stale = [...shell].filter(
    (f) => f !== "./" && !fs.existsSync(path.join(appDir, f.slice(2)))
  );
  expect(stale, `these are in SHELL but not on disk:\n${stale.join("\n")}`).toEqual([]);
});

/** The modulepreload hints out of index.html, in the order they appear. */
function preloadList() {
  const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
  return [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(
    (m) => m[1]
  );
}

/**
 * The static import graph, walked from one entry module.
 *
 * Static only. A dynamic `import()` is a decision the app makes at runtime —
 * js/demo/backend.js is loaded in demo mode and not otherwise — and a hint for
 * a module that may never be asked for is bytes spent on a guess.
 *
 * Comments are stripped first, and that is not tidiness: every file in js/
 * carries JSDoc, and `@param {import("./types.js").Post}` looks exactly like a
 * dynamic import to a regular expression. types.js has no runtime importer at
 * all, so a walk that believed its own comments would demand a hint for a file
 * the browser never loads.
 */
function staticGraph(entry) {
  const seen = new Map([[entry, 0]]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    const src = fs
      .readFileSync(path.join(appDir, current), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // `from "…"` covers both import and re-export; the `from`-less form is a
    // side-effect import. [\s\S] rather than . because the named-import block
    // in js/views/settings.js runs across sixty lines.
    const imports = src.matchAll(
      /(?:^|[\n;])\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g
    );
    for (const [, spec] of imports) {
      if (!spec.startsWith(".")) continue;
      const target = `./${path
        .normalize(path.join(path.dirname(current), spec))
        .replace(/^\.\//, "")}`;
      if (!fs.existsSync(path.join(appDir, target))) continue;
      if (!seen.has(target)) {
        seen.set(target, seen.get(current) + 1);
        queue.push(target);
      }
    }
  }
  return seen;
}

// ── the hints ──────────────────────────────────────────────────────────────
// Same arrangement as SHELL above, and for the same reason: a hand-written
// list with no build step behind it is only as good as the thing that checks
// it. A module added to the app and not to index.html silently costs the round
// trip these exist to remove, and nothing on screen would ever say so.
test("the modulepreload hints still match the import graph", () => {
  const hints = preloadList();
  const graph = staticGraph("./js/main.js");

  const expected = [...graph.keys()].filter((f) => f !== "./js/main.js");
  const missing = expected.filter((f) => !hints.includes(f));
  expect(
    missing.sort(),
    `these are imported but not preloaded — add to index.html:\n${missing.join("\n")}`
  ).toEqual([]);

  // The other direction. A hint for a module nothing imports any more is a
  // download with no importer, and Chrome says so in the console — which is a
  // worse place to find out than here.
  const orphaned = hints.filter((f) => !graph.has(f));
  expect(
    orphaned.sort(),
    `these are preloaded but nothing imports them:\n${orphaned.join("\n")}`
  ).toEqual([]);

  // Belt and braces on the three deliberate absences, because each of them is
  // a thing somebody would "fix" by adding it.
  expect(hints, "main.js is declared by the <script> tag, not a hint").not.toContain(
    "./js/main.js"
  );
  expect(hints, "types.js is JSDoc only — nothing imports it").not.toContain(
    "./js/types.js"
  );
  expect(
    hints,
    "demo/backend.js is a dynamic import, loaded only in demo mode"
  ).not.toContain("./js/demo/backend.js");

  // No duplicates: two hints for one file is two entries in the priority queue
  // for one download.
  expect(hints.length, "a href appears twice in index.html").toBe(new Set(hints).size);
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
test("the app opens with no network at all", async ({
  page,
  context,
  api,
}, testInfo) => {
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
  const fontLoaded = await page.evaluate(() =>
    document.fonts.check('1rem "Newsreader"')
  );
  expect(fontLoaded).toBe(true);

  // And navigation still works, because every address here is the same
  // document and the cache knows it.
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  await context.setOffline(false);
});

// ── the manifest ───────────────────────────────────────────────────────────
// The same shape of check as the shell list above, for the same reason. A
// manifest is a set of promises about files, made in a file that nothing type
// checks and that no screen renders: get a path wrong and the app carries on
// working perfectly while the install dialog quietly shows a blank card. The
// only place that can go wrong is here.

/** The manifest, parsed. */
function manifest() {
  return JSON.parse(fs.readFileSync(path.join(appDir, "manifest.webmanifest"), "utf8"));
}

/** Every file the manifest names, as "./path" strings with what named it. */
function declaredFiles(m) {
  const out = [];
  for (const i of m.icons || []) out.push({ src: i.src, where: "icons" });
  for (const s of m.shortcuts || [])
    for (const i of s.icons || [])
      out.push({ src: i.src, where: `shortcuts["${s.name}"]` });
  for (const s of m.screenshots || []) out.push({ src: s.src, where: "screenshots" });
  return out;
}

// The eight bytes every PNG starts with. Compared as bytes, never as a string:
// the first one is 0x89, and decoding it as ASCII quietly masks the high bit
// off and turns it into a tab.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG's real dimensions, straight out of its header — eight bytes of
 * signature, then an IHDR chunk whose first two fields are the width and the
 * height as big-endian 32-bit integers. Worth the twelve lines: `sizes` is a
 * string a human typed, and a browser that finds it disagreeing with the file
 * does not tell anybody.
 * @param {string} file
 */
function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${file} is not a PNG`);
  }
  if (head.toString("ascii", 12, 16) !== "IHDR") throw new Error(`${file}: no IHDR`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

test("the manifest parses, and names only files that exist", () => {
  const m = manifest();

  // The keys an installable app is nothing without. Asserted by name rather
  // than by a schema, because what matters is that *these* are present.
  for (const key of ["name", "start_url", "scope", "display", "icons"]) {
    expect(m[key], `manifest is missing "${key}"`).toBeTruthy();
  }
  // A reading app that refuses landscape on a tablet is worse, not more
  // app-like. If this ever comes back it should be "any" and deliberate.
  expect(m.orientation).toBeUndefined();

  const missing = declaredFiles(m).filter(
    ({ src }) => !fs.existsSync(path.join(appDir, src.replace(/^\.\//, "")))
  );
  expect(
    missing,
    `the manifest names files that aren't on disk:\n` +
      missing.map((f) => `  ${f.src}  (${f.where})`).join("\n") +
      `\nrun: node docs/make_icons.mjs`
  ).toEqual([]);
});

test("every file the manifest names is actually served", async ({ request }) => {
  // On disk is not the same as reachable: a path that is right relative to the
  // repository and wrong relative to the manifest resolves to a 404 that only
  // the install dialog would ever see.
  for (const { src, where } of declaredFiles(manifest())) {
    const url = src.replace(/^\.\//, "/");
    const res = await request.get(url);
    expect(res.status(), `${url} (${where})`).toBe(200);

    // And it is really a PNG, not an HTML error page with a .png on the end —
    // which is exactly what a static host with a catch-all returns.
    const body = await res.body();
    expect(body.subarray(0, 8).equals(PNG_SIGNATURE), `${url} is not a PNG`).toBe(true);
  }
});

test("the screenshots are shaped the way the install dialog needs", () => {
  const shots = manifest().screenshots || [];

  // Without at least one of each, Chrome falls back to the cramped
  // mini-infobar on Android or a bare one-liner on the desktop — which is the
  // whole reason these exist.
  expect(shots.filter((s) => s.form_factor === "wide").length).toBeGreaterThan(0);
  expect(shots.filter((s) => s.form_factor === "narrow").length).toBeGreaterThan(0);

  /** @type {Record<string, number[]>} */
  const ratios = {};

  for (const shot of shots) {
    const file = path.join(appDir, shot.src.replace(/^\.\//, ""));
    const { width, height } = pngSize(file);

    // Chrome's three rules, each of which it enforces by silently dropping the
    // screenshot rather than by complaining.
    expect(
      Math.min(width, height),
      `${shot.src} is under 320px`
    ).toBeGreaterThanOrEqual(320);
    expect(Math.max(width, height), `${shot.src} is over 3840px`).toBeLessThanOrEqual(
      3840
    );
    expect(
      Math.max(width, height) / Math.min(width, height),
      `${shot.src} is more than 2.3x longer than it is wide`
    ).toBeLessThanOrEqual(2.3);

    // And the declared size is the real one. This is the check that catches a
    // regenerated screenshot whose viewport moved and whose manifest entry
    // didn't.
    expect(shot.sizes, `${shot.src}: "sizes" disagrees with the file`).toBe(
      `${width}x${height}`
    );
    expect(shot.type, `${shot.src}: "type"`).toBe("image/png");
    // Read out by a screen reader in the install dialog, so not optional.
    expect(shot.label, `${shot.src} has no label`).toBeTruthy();

    (ratios[shot.form_factor] ||= []).push(width / height);
  }

  // Same form factor, same shape — a carousel that changes size between slides
  // is a carousel Chrome declines to show.
  for (const [form, list] of Object.entries(ratios)) {
    for (const r of list) {
      expect(
        Math.abs(r - list[0]),
        `the ${form} screenshots aren't all one shape`
      ).toBeLessThan(0.01);
    }
  }
});

test("every shortcut opens a screen the app actually has", () => {
  // The routes as main.js registers them. The same trick the shell list uses:
  // read the source rather than trust that two files still agree.
  const src = fs.readFileSync(path.join(appDir, "js", "main.js"), "utf8");
  const routes = [...src.matchAll(/^route\("([^"]+)"/gm)].map((m) => m[1]);
  expect(routes.length, "found no route() calls in js/main.js").toBeGreaterThan(5);

  const shortcuts = manifest().shortcuts || [];
  expect(shortcuts.length).toBeGreaterThan(0);

  for (const shortcut of shortcuts) {
    expect(shortcut.name, "a shortcut with no name").toBeTruthy();
    // Relative, so it still resolves under /social-feed-application/ on Pages,
    // where an absolute "/#/compose" would land outside the app's scope and be
    // dropped.
    expect(shortcut.url, `${shortcut.name}: url must be relative to the app`).toMatch(
      /^\.\/#\//
    );
    // A shortcut with no icon gets the app icon, which makes three identical
    // rows in the long-press menu.
    expect(shortcut.icons?.length, `${shortcut.name} has no icon`).toBeGreaterThan(0);

    const hash = shortcut.url.slice(shortcut.url.indexOf("#") + 1);
    expect(
      routes,
      `${shortcut.name} points at ${hash}, which is not a route`
    ).toContain(hash);
  }
});
