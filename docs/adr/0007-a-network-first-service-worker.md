# 0007 — The service worker is network-first

**Status:** accepted · 2026-09-19

## What was decided

[`frontend/sw.js`](../../frontend/sw.js) precaches the app's own files on
install and then serves every same-origin `GET` inside its directory
**network-first**: it asks the network, returns what comes back, and puts a
copy in the cache. The cache is only read when the network fails.

Nothing else is touched. Writes, cross-origin requests and anything outside the
app's directory never reach `respondWith`, which is the whole of the API — a
different origin in development, and nonexistent on the published site, where
[`js/demo/backend.js`](../../frontend/js/demo/backend.js) answers in
JavaScript.

There is no "a new version is ready" prompt, and no version constant that has
to be bumped to ship a change.

## Why

The app had a `manifest.webmanifest`, maskable icons and an
`apple-touch-icon` — it has been advertising itself as installable since
[0004](0004-demo-mode-for-a-static-host.md) — and no service worker, so
installing it produced an app that broke the moment the connection did. For a
build whose data already lives in `localStorage` and whose files are static,
that is a strange thing to be missing.

The interesting half is the caching strategy, and the usual advice is wrong
here.

**Cache-first assumes a build step.** A bundler fingerprints every file —
`app.9f3c2a.js` — so a cached asset is never stale, because a new build is a
new URL. This project has no build step on purpose
([0001](0001-vanilla-js-with-jsdoc-types.md)), so the URLs never change. Under
cache-first the only thing between a returning reader and a permanently stale
app would be somebody remembering to bump a constant in `sw.js` after every
change. Get that wrong once and those readers are stuck, with no way to ask for
the current version and nothing on screen to tell them they aren't on it.

**And cache-first buys almost nothing here.** `fetch()` inside a service worker
goes through the HTTP cache like any other request, so a network-first hit
against an unchanged file is usually a memory-cache read or a 304 rather than a
download. The app already measures 100 for performance on Lighthouse with no
service worker at all; there was no number this was going to move.

So the network decides what is current and the cache answers when there is no
network. That removes the entire stale-asset failure mode, removes the version
constant, and removes the update prompt with it: a reload gets the new files,
exactly as it does with no service worker. `skipWaiting()` and `clients.claim()`
are safe for the same reason — a worker that serves whatever the network
currently says cannot hand a half-updated page a mismatched file.

## What it costs

**A request that would have been free.** Offline-first apps answer instantly
from disk; this one still waits on the network when there is one. Measured
against the HTTP cache the difference is small, and it is the price of never
being wrong.

**A hand-written file list.** `SHELL` in `sw.js` names every module and
stylesheet, because there is no build to generate it. A file missing from the
list is not fatal — network-first caches whatever it successfully fetches, so
anything the app loads ends up cached anyway — but it would break the one case
the list exists for: arriving, loading nothing further, and going offline.
`tests/offline.spec.js` compares the list against what is on disk in both
directions, which is the same arrangement the committed OpenAPI spec has.

**`sw.js` is not type-checked.** A worker needs the `WebWorker` lib and the app
needs `DOM`, and one `tsconfig.json` cannot declare both; a second config for a
single file is more moving parts than the checking is worth. It is the only
file in `frontend/` that `tsc --noEmit` doesn't see, and the offline suite is
what holds it to its word instead.

## When to change our minds

Go cache-first if either becomes true:

- the app grows a build step, and therefore content-hashed filenames — at which
  point the argument above evaporates and cache-first is simply better; or
- the shell stops being ~120 KB of hand-written files and starts being large
  enough that the first paint on a slow connection is worth the staleness risk.

If the second happens without the first, the honest middle is
stale-while-revalidate plus a visible "a new version is ready — reload" prompt.
That is more machinery than this app needs today, and a prompt is a worse thing
to have to build correctly than it looks.
