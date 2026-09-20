// @ts-check
// Hash router. Patterns use :name for segments. Handlers get { params, isStale }
// where isStale() tells a slow async handler that the user has since navigated on.

import { h } from "./dom.js";
import { mountView } from "./view.js";

const routes = [];
let generation = 0;

function compile(pattern) {
  const keys = [];
  const re = new RegExp(
    "^" +
      pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$"
  );
  return { re, keys };
}

export function route(pattern, handler) {
  routes.push({ ...compile(pattern), handler });
}

export function navigate(path) {
  const target = path.startsWith("#") ? path : "#" + path;
  if (location.hash === target) resolve();
  else location.hash = target;
}

export function currentPath() {
  const raw = location.hash.replace(/^#/, "").split("?")[0];
  return raw || "/";
}

export function currentQuery() {
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : location.hash.slice(i + 1));
}

// What the last resolve() rendered. hashchange events are queued, and every
// handler reads the *current* location — so two navigations in quick succession
// (signing out, then going somewhere) deliver two events that both resolve to
// the same final hash and render that screen twice. The second render replaces
// the first mid-interaction, which is how a form you have just filled in comes
// back empty.
let lastResolvedHash = null;

// Only resolve if the hash isn't already on screen. navigate() calls resolve()
// directly and so bypasses this, which is what keeps "click the brand to get a
// fresh feed" working while you're already on the feed.
function resolveIfChanged() {
  if (location.hash === lastResolvedHash) return;
  resolve();
}

/**
 * Forget what's on screen, so the next hashchange redraws it even if the hash
 * hasn't moved.
 *
 * The dedupe above asks "is this screen already up?", and the answer stops
 * being trustworthy the moment something other than the route changes what a
 * screen would look like — signing out being the obvious one. Leave a profile,
 * sign out (which navigates home), and come straight back: both queued events
 * see the hash they started from, both decide there's nothing to do, and the
 * page you're left looking at is the one you saw while signed in.
 */
export function forgetCurrentScreen() {
  lastResolvedHash = null;
}

// The screen we came from, hash and query intact. Only one thing reads it —
// the post page's Back link, which has no business saying "the feed" when the
// card you tapped was on someone's profile or in a set of search results.
// Null after forgetCurrentScreen(), i.e. straight after signing in or out,
// which is exactly when "where you were" has stopped being a useful answer.
let previousHash = null;

export function previousScreen() {
  return previousHash;
}

/**
 * Call `fn` once the reader has actually gone somewhere else.
 *
 * Every list screen holds something that has to be let go of when it leaves —
 * an IntersectionObserver, a poll, an in-flight fetch — and they used to hang
 * that on `hashchange` directly. That is one event too eager. hashchange fires
 * once per *event*, not once per screen, and two navigations in quick
 * succession queue two events that both read the same final hash: resolve()
 * dedupes the second one (see lastResolvedHash above), so no new screen is
 * built — but a plain hashchange listener registered by the screen the *first*
 * event built still runs, and tears down a screen that is very much still on
 * the page.
 *
 * The symptom was a profile stuck on skeletons for ever: sign out — which
 * navigates home — then open a profile before the queue drains, and the
 * profile's own fetch is aborted by the teardown belonging to the profile that
 * fetch was for. Nothing logs, nothing throws, and the list simply never
 * arrives.
 *
 * So the check the router makes for itself is made here too: the hash this was
 * registered at is the screen it belongs to, and anything else is not leaving.
 *
 * @param {() => void} fn
 * @returns {() => void} stop listening, for a screen torn down some other way
 */
export function onLeavingScreen(fn) {
  const mountedAt = location.hash;
  const leave = () => {
    if (location.hash === mountedAt) return;
    removeEventListener("hashchange", leave);
    fn();
  };
  addEventListener("hashchange", leave);
  return () => removeEventListener("hashchange", leave);
}

async function resolve() {
  previousHash = lastResolvedHash;
  lastResolvedHash = location.hash;
  const path = currentPath();
  const query = currentQuery();
  const mine = ++generation;
  const isStale = () => mine !== generation;

  for (const { re, keys, handler } of routes) {
    const m = path.match(re);
    if (!m) continue;
    const params = {};
    keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    try {
      await handler({ params, query, isStale });
    } catch (err) {
      // The screen that was being built isn't coming. Everything below is
      // about what the reader is left looking at.
      if (isStale()) return;
      console.error(err);
      mountScreenError(err);
    }
    return;
  }

  // nothing matched — send them home
  navigate("/");
}

/**
 * What a reader sees when a view throws.
 *
 * Until this existed, a throw inside a handler was caught, written to the
 * console, and that was all — which left **the previous screen on the page**,
 * still interactive, with the address bar naming a screen that never rendered.
 * Pressing back from there went somewhere that looked identical. The failure
 * mode of an error nobody handles should not be a page that lies about which
 * page it is.
 *
 * Deliberately not a toast: a toast is for something that happened *beside*
 * what you were doing, and this is the thing you were doing. The screen is
 * where the failure is, so the screen is where it is reported.
 *
 * Two ways out, because there are two different failures underneath. "Try
 * again" re-runs the same route, which is the right answer for anything
 * transient — a dropped request, a race on a slow connection. "Go to the feed"
 * is for the other kind, where this screen is simply not going to build, and
 * it is a plain link rather than a button so it works even if the handler that
 * threw left something in a bad state.
 *
 * The message itself is not shown. It is a stack trace or a driver's idea of
 * what went wrong, it is written to the console two lines up for whoever wants
 * it, and putting it on the page in the reading face would be neither useful
 * to a reader nor honest about how much we know.
 *
 * @param {unknown} err
 */
function mountScreenError(err) {
  const retry = h(
    "button",
    { class: "btn btn--quiet", type: "button", onclick: () => resolve() },
    "Try again"
  );

  mountView(
    h(
      "section",
      { class: "screen-error", "aria-label": "This screen didn't load" },
      h("h1", { class: "screen-error__title" }, "This screen didn't load."),
      h(
        "p",
        { class: "screen-error__line" },
        "Something went wrong putting it together. Nothing you did is lost."
      ),
      h(
        "div",
        { class: "screen-error__actions" },
        retry,
        h("a", { class: "btn btn--ghost", href: "#/" }, "Go to the feed")
      )
    ),
    // Not a journey and not an arrival — the screen the reader asked for did
    // not happen. The quiet cross-fade says that better than a page that rises
    // into place as though it had been fetched.
    { transition: false }
  );
}

export function startRouter() {
  addEventListener("hashchange", resolveIfChanged);

  if (!location.hash) {
    // Setting the fragment queues a hashchange, and the listener above answers
    // it — so resolving here as well would render the first screen twice.
    // That used to be invisible (two renders in the same breath look like one);
    // it stopped being invisible once a view transition hung off the second.
    location.replace("#/");
    return;
  }

  resolve();
}
