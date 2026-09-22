/* Commons — the service worker.
 *
 * ── why there is one ───────────────────────────────────────────────────────
 * The published build already runs entirely in the browser: GitHub Pages has
 * nowhere for FastAPI to live, so js/demo/backend.js answers the app's own API
 * calls out of localStorage. An app whose data is already local and whose
 * files are static is an app that has no reason to need the network at all —
 * and it shipped with a manifest, maskable icons and an apple-touch-icon,
 * which is to say it has been *advertising* itself as installable while
 * quietly failing the moment the connection dropped. This closes that.
 *
 * ── why it is network-first, and not cache-first ───────────────────────────
 * Cache-first is the usual advice and it is the wrong trade here.
 *
 * The advice assumes a build step. A bundler fingerprints every file —
 * `app.9f3c2a.js` — so a cached asset can never be stale: a new build is a new
 * URL. This project deliberately has no build step (ADR 0001), so the URLs
 * never change, and cache-first would mean the only thing standing between a
 * reader and a permanently stale app is somebody remembering to bump a version
 * constant in this file. Get that wrong once and returning visitors are stuck
 * on the old app with no way to ask for the new one.
 *
 * What cache-first would buy is a few milliseconds, and it isn't even that:
 * `fetch()` inside a service worker goes through the HTTP cache like any other
 * request, so a network-first hit against an unchanged file is usually a
 * memory-cache read or a 304, not a download. The app already measures 100 for
 * performance without any of this.
 *
 * So: the network decides what is current, and the cache is what answers when
 * there is no network. There is no version to forget, no stale-asset failure
 * mode, and no "a new version is ready" prompt to build — a reload gets the new
 * files, exactly as it does with no service worker at all.
 *
 * ── what it does not touch ─────────────────────────────────────────────────
 * Anything that isn't a same-origin GET inside this directory. That is the
 * whole of the API: during development it is a different origin
 * (localhost:8000), and on the published site there are no API requests at all
 * because the demo adapter answers them in JavaScript. Writes are never served
 * from a cache and never put in one.
 *
 * ── one honest gap ─────────────────────────────────────────────────────────
 * This file is not covered by `tsc --noEmit`, which every module in js/ is.
 * A worker needs the WebWorker lib and the app needs DOM, and the two can't be
 * declared together in one tsconfig — a second config for one file is more
 * moving parts than the checking would be worth. tests/offline.spec.js is what
 * holds this file to its word instead, including a test that keeps the list
 * below in step with what is actually on disk.
 */

// Only ever used to namespace the cache and to sweep older ones on activate —
// *not* to decide whether a cached file is still good. See the note above.
const CACHE = "commons-v1";

// The app's own directory, whatever it is deployed under: "/" here, and
// "/social-feed-application/" on Pages. Everything outside it is somebody
// else's business.
const ROOT = new URL("./", self.location).pathname;

// Warmed on install so that a first visit followed by a flight still works.
// A file missing from this list is not a bug with teeth: network-first caches
// whatever it successfully fetches, so anything the app actually loads ends up
// here anyway. The list is what covers the one case that wouldn't —
// arriving, loading nothing else, and going offline.
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.ico",
  "./robots.txt",
  "./sitemap.xml",
  "./stats.json",

  "./styles/tokens.css",
  "./styles/base.css",
  "./styles/components.css",
  "./styles/chrome.css",
  "./styles/views.css",
  "./styles/print.css",

  "./js/main.js",
  "./js/config.js",
  "./js/api.js",
  "./js/store.js",
  "./js/router.js",
  "./js/dom.js",
  "./js/toast.js",
  "./js/format.js",
  "./js/view.js",
  "./js/actions.js",
  "./js/types.js",
  "./js/transitions.js",
  "./js/reading.js",
  "./js/shelf.js",
  "./js/draft.js",
  "./js/notify.js",
  "./js/install.js",
  "./js/live.js",
  "./js/offline.js",
  "./js/scrollbar.js",
  "./js/share.js",
  "./js/browserdata.js",
  "./js/components/vote.js",
  "./js/components/card.js",
  "./js/components/palette.js",
  "./js/components/accountmenu.js",
  "./js/components/comments.js",
  "./js/components/feedkeys.js",
  "./js/components/reader.js",
  "./js/components/radiogroup.js",
  "./js/components/quote.js",
  "./js/views/feed.js",
  "./js/views/post.js",
  "./js/views/profile.js",
  "./js/views/shelf.js",
  "./js/views/colophon.js",
  "./js/views/settings.js",
  "./js/views/notifications.js",
  "./js/views/auth.js",
  "./js/views/compose.js",
  "./js/demo/backend.js",
  "./js/demo/strip.js",
  "./js/demo/seed.json",

  "./assets/icons.svg",
  "./assets/fonts/newsreader.woff2",
  "./assets/icons/icon.svg",
  "./assets/icons/favicon-16.png",
  "./assets/icons/favicon-32.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-192.png",
  "./assets/icons/icon-maskable-512.png",
  "./assets/icons/shortcut-compose.png",
  "./assets/icons/shortcut-shelf.png",
  "./assets/icons/shortcut-notifications.png",
];

// What is deliberately *not* above: assets/screenshots/. They are two megabytes
// of PNG that only the install dialog ever asks for, and the install dialog
// only ever runs online — precaching them would mean every first visit paying
// for six pictures of the app in order to be offline-ready for a screen that
// cannot be reached offline. The shortcut icons are here because they are four
// kilobytes each and a launcher can ask for them at any time, including a
// launcher redrawing its menu on a plane.

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One at a time rather than cache.addAll(), which is all-or-nothing: a
      // single mistyped path in the list above would throw, leave the whole
      // shell uncached, and give up the offline story without saying so. This
      // way a wrong entry costs exactly that entry.
      //
      // `cache: "reload"` so install fetches from the network rather than
      // warming the new cache out of the old HTTP one.
      await Promise.all(
        SHELL.map((path) =>
          cache.add(new Request(path, { cache: "reload" })).catch(() => {})
        )
      );
      // Safe here in a way it wouldn't be under cache-first: this worker serves
      // whatever the network currently says, so a page that was loaded under
      // the previous one cannot be handed a mismatched file by the new one.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("commons-") && n !== CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Not a write, not somebody else's origin, not outside our own directory.
  // Declining to call respondWith leaves the request entirely alone, which is
  // the right answer for all three.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(ROOT)) return;

  event.respondWith(networkFirst(request));
});

/** @param {Request} request */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // Only what came back whole. Caching a 404 or a 500 here would mean
    // serving it back for the whole of the next outage, which is a worse
    // answer than the one the browser gives on its own.
    if (response && response.ok && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;

    // A navigation is the one request that can be answered by something other
    // than itself. Every address in this app is the same document — it is a
    // hash router, and the fragment is never sent to a server — so any URL
    // that got here is index.html under a query string this cache happens not
    // to have seen. `?demo=1` is exactly that, which is why ignoreSearch is
    // not optional: on the published site it is the *usual* case.
    if (request.mode === "navigate") {
      const shell =
        (await cache.match("./index.html", { ignoreSearch: true })) ||
        (await cache.match("./", { ignoreSearch: true }));
      if (shell) return shell;
    }
    throw err;
  }
}
