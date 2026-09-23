# 0007 — The service worker is network-first

**Status:** accepted · 2026-09-19 · amended 2026-09-23 (see *The ten minutes nobody had measured*)

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

> **Amended 2026-09-23.** There is a prompt now, and the sentence above is left
> standing because the reasoning that follows it is still the reasoning — what
> changed is one measurement, not the decision. See *The ten minutes nobody had
> measured* and *And the reload that had to be somebody's idea* at the end.

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

## The ten minutes nobody had measured (2026-09-23)

This document said "the network decides what is current". It was not quite
true, and the gap was in a sentence above that was written as a *reassurance*:

> `fetch()` inside a service worker goes through the HTTP cache like any other
> request, so a network-first hit against an unchanged file is usually a
> memory-cache read or a 304 rather than a download.

Both halves are correct and the conclusion drawn from them was wrong. Going
through the HTTP cache is not free when you do not control the HTTP cache.
Measured against the published site:

```
$ curl -sSI https://andrewtechtips.github.io/social-feed-application/js/main.js
cache-control: max-age=600
etag: "6ab271b1-48be"
```

GitHub Pages puts `max-age=600` on every file it serves and offers no way to
change it — there is no `_headers` file, and the source is a workflow artifact,
not a configurable host. So for up to ten minutes after a deploy, "ask the
network" meant "ask a cache that has been told it may answer for ten minutes",
and this worker served the recent past while reporting it as current.

**The lateness was the smaller half.** `max-age` is per-file, and each file's
clock starts when that file was last requested, not when it was deployed. A
returning reader could therefore be handed a new `index.html` and a ten-minute
old `js/views/feed.js` in the same load. With no build step there are no
content hashes, so nothing in the system could notice — which is the same
mixed-version failure the decision above was written to avoid, arriving by a
door nobody had checked.

**The fix is one word.** The request is now built with `cache: "no-cache"`,
which revalidates rather than reuses. Unchanged files come back `304` with an
empty body, changed files come back whole and immediately, and the ten minutes
are gone. The cost is a conditional request per file per load where there used
to sometimes be none; they go out in parallel on one connection, and the same
change that made this affordable — `modulepreload` hints in `index.html` —
removed considerably more time than this adds.

One trap, recorded because it is invisible and would survive review: building a
Request from another Request downgrades a `navigate` mode to `same-origin`.
Everything past this worker's guards is same-origin so the downgrade costs
nothing, but the navigation fallback must read `mode` off the **original**
request or it silently stops recognising navigations — and the symptom would be
a blank page offline, months later, with nothing pointing here.

## And the reload that had to be somebody's idea (2026-09-23)

"A reload gets the new files" was also true and also not enough. Nothing made
anyone reload. A tab left open across a deploy ran the old app until its reader
happened to refresh, which on an installed PWA — which reopens to whatever it
was last showing — can be days.

So the app now has the prompt this document declined to build, and the reason
the objection no longer holds is that the machinery turned out to be somewhere
else. The version is `version.json`, one object with the commit sha in it,
written by `.github/workflows/pages.yml` at deploy time. It is not committed
(a sha in the repository names the commit *before* the one being deployed), not
in `SHELL`, and never cached — the fetch handler declines that one path, and
`js/update.js` asks for it with `no-store`.

**The check lives in the page, not in here**, and that is the decision worth
recording. The question is not "what is the newest version" but "is the newest
version the one this document is running", and only the document knows the
second half. A worker outlives its pages and is shared between them, so putting
the comparison here would have meant inventing a message protocol to carry a
fact the page already had. In the page it is about forty lines, it needs no
worker at all, and it works on the first visit before one has installed.

What it costs: one request when the tab becomes visible, and one when the
connection returns. No timer — a poll would spend requests on a tab nobody is
looking at, to deliver a notice nobody can read, and would still be slower in
the only case that matters.

Three things it must not do, all of which are silence, and all of which are
therefore tested by making the band appear immediately afterwards
(`tests/update.spec.js`):

- **Never greet a first visit.** The first read is a baseline, not a
  comparison. A comparison needs two sides.
- **Never treat a failure as a change.** A 404, a parse error, an offline
  reader and a Pages hiccup are all "no answer", and none of them is evidence
  that the app moved.
- **Never fire twice for one deploy.** It latches until the page reloads.

## When to change our minds, again

- **If `version.json` ever stops being written by the deploy**, the band simply
  never appears — it fails to the behaviour that existed before it. That is the
  right direction to fail in, and it is why the beacon is allowed to be this
  simple.
- **If the app grows a build step**, everything above is superseded rather than
  extended: content hashes make the ten minutes harmless, cache-first becomes
  correct, and the beacon becomes a build artifact rather than a workflow step.
