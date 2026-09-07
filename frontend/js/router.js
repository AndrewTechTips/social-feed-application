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

async function resolve() {
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
  addEventListener("hashchange", resolve);
  if (!location.hash) location.replace("#/");
  resolve();
}
