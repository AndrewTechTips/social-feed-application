# 0002 — Hash routing, not the History API

**Status:** accepted · 2026-09-13

## What was decided

Every route in this app is a fragment: `#/`, `#/posts/12`, `#/u/marenholt`.
The router is 100 lines of `hashchange` in
[`js/router.js`](../../frontend/js/router.js). No `pushState`, no
`popstate`, no server rewrite rules.

## Why

The app is published to GitHub Pages, which serves static files and nothing
else. History-API routing needs the server to answer `/posts/12` with
`index.html`, and there is no server to ask. The usual workaround — copy
`index.html` to `404.html` and let the not-found handler do the routing — works,
but it means every deep link is served with an HTTP 404 status, which is a
strange thing to publish deliberately.

Hash routing sidesteps the whole question. The browser never asks the server
for anything after the `#`, so a deep link is one request for `index.html` and
then pure client-side work. It also means every asset reference can stay
relative (`./styles/…`, `./assets/…`), so the same build works at
`https://user.github.io/repo/` as at `http://localhost:5173/`, with no
base-href rewriting.

## What it cost

- The URLs are uglier. `#/posts/12` is not `/posts/12`, and no amount of
  familiarity makes it prettier.
- Server-side rendering is off the table. Not a loss here — there is no server
  — but it would be the first thing to reconsider if one ever appeared.
- Search-engine crawling of fragment routes is weaker than of real paths. For
  a portfolio demo whose content is fixture data, that is a cost worth nothing.
- Two subtleties had to be handled by hand, and both are commented in the
  router: `hashchange` events queue, so two navigations in quick succession can
  resolve to the same final hash and render the same screen twice; and
  something other than the route can change what a screen should look like
  (signing out), which is why `forgetCurrentScreen()` exists.

There is still a `404.html`, but it exists only to catch someone typing a real
path by hand and bounce them into the hash router.

## When to change our minds

If the app ever gets a server of its own — or moves to a host with rewrite
rules — switch to the History API and keep a redirect from the old fragment
URLs. The router's public surface (`route`, `navigate`, `currentPath`,
`currentQuery`) was written so that the swap touches one file.
