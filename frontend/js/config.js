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
  if (IS_DEMO) return (await demoBackend()).fetch(path, init);
  return fetch(API_BASE + path, init);
}

// Used by the demo strip's "Reset the demo" control.
export async function resetDemo() {
  (await demoBackend()).reset();
}
