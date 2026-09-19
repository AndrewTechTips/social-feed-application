// @ts-check
// Where the API lives — or, on a static host, the fact that it doesn't.
//
// This app ships to GitHub Pages, which serves files and nothing else. FastAPI
// has nowhere to run there, so rather than publish a link that opens on "Can't
// reach the server. Is the backend running?", the published build answers its
// own requests from js/demo/backend.js — the same contract, served from memory.
//
// Demo mode turns on when:
//   · the hostname ends in github.io (the published site), or
//   · ?demo=1 is in the URL (so it can be tried locally, and so the end-to-end
//     suite can drive it without a server)
//
// Anywhere else — localhost during development — it talks to the real backend
// on API_BASE, unchanged.
//
// Everything the app sends goes through one function, `apiFetch`, which is
// either window.fetch against API_BASE or the demo adapter. Both take the same
// arguments and both resolve to a Response, so js/api.js has no idea which one
// it got and needs no branch of its own.

export const API_BASE = "http://localhost:8000";

// Mirrors API_PREFIX in backend/app/config.py.
//
// Every path in this codebase is written without it — `/posts/`, `/users/me` —
// and apiFetch below is the single place it gets attached. That keeps the
// version out of forty call sites, and it means the demo adapter can be
// written against the same paths the rest of the app uses rather than against
// a decorated copy of them.
export const API_PREFIX = "/api/v1";

// Where the source is. Named here rather than in the two places that link to
// it — the demo strip and the colophon — because a repository that moved and
// took one of them with it would be a broken link on the page whose whole job
// is to be checkable.
export const REPO_URL = "https://github.com/AndrewTechTips/social-feed-application";

const params = new URLSearchParams(location.search);

export const IS_DEMO =
  location.hostname.endsWith("github.io") || params.get("demo") === "1";

// Resolved on first use rather than at import: loading the seed is a fetch, and
// making every module that imports this file wait on it would be rude.
let demo = null;

async function demoBackend() {
  if (demo) return demo;
  const [{ createDemoBackend }, seed] = await Promise.all([
    import("./demo/backend.js"),
    fetch(new URL("./demo/seed.json", import.meta.url)).then((r) => r.json()),
  ]);
  demo = createDemoBackend({ seed });

  // The control surface the end-to-end suite drives in place of mock_api.py's
  // /__reset, /__seed and /__fail_next helpers. It is only ever reachable in
  // demo mode, where there is no real data to put at risk.
  // The control surface the end-to-end suite drives. Declared on a widened
  // view of window rather than in a .d.ts, so there is still nothing here but
  // the files the browser loads.
  /** @type {Window & { __commonsDemo?: unknown }} */ (
    window
  ).__commonsDemo = demo.control;
  window.dispatchEvent(new CustomEvent("commons:demo-ready"));
  return demo;
}

export async function apiFetch(path, init) {
  // Prefixed for both, so that what the demo adapter is handed is what the
  // network would have carried. The adapter strips it again on the way in —
  // one line there, in exchange for the two backends being fed identical URLs
  // and a test that watches requests seeing the same thing either way.
  const url = API_PREFIX + path;
  if (IS_DEMO) return (await demoBackend()).fetch(url, init);
  return fetch(API_BASE + url, init);
}

// Used by the demo strip's "Reset the demo" control.
export async function resetDemo() {
  (await demoBackend()).reset();
}
