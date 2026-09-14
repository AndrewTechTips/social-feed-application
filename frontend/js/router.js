// Hash router. Patterns use :name for segments. Handlers get { params, isStale }
// where isStale() tells a slow async handler that the user has since navigated on.

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

async function resolve() {
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
      if (!isStale()) console.error(err);
    }
    return;
  }

  // nothing matched — send them home
  navigate("/");
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
