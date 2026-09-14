// Shared fixtures for the Commons e2e suite.
//
// The suite runs twice, against two different implementations of the same API:
//
//   project "chromium"  →  mock_api.py over HTTP, the stand-in for the real
//                          FastAPI backend
//   project "demo"      →  js/demo/backend.js, the in-browser adapter the
//                          published GitHub Pages site runs on
//
// The specs don't know or care which. That's the point: the site people
// actually click has to behave like the API this project ships, and running one
// set of tests against both is the cheapest way to keep that true.
//
// `api` resets its target before every test, so each one starts from a clean,
// isolated slate either way.
//
// --- against the real mock (project "chromium") ---
// The app reaches the API at the origin hard-coded in frontend/js/config.js
// (http://localhost:8000). The mock must therefore listen on that same port —
// the Playwright config starts it there. If port 8000 is busy on your machine
// (e.g. the real backend is running), point both halves elsewhere for the test
// run: change config.js to your port and start with API_PORT set to match.
//
// --- against the demo adapter (project "demo") ---
// There is no server to talk to. State is built here in Node using the very
// same backend.js module the browser runs, then injected as the localStorage
// value the app reads on boot — so the fixture can't drift from the thing it's
// seeding. Demo mode is switched on by ?demo=1, and because specs navigate to
// paths like "/#/login" that replace the query string, page.goto is wrapped to
// put it back. That keeps js/config.js honest: it still knows only about the
// hostname and the query parameter, with no test-only escape hatch in it.

const base = require("@playwright/test");
const path = require("path");
const { pathToFileURL } = require("url");

const API_PORT = process.env.API_PORT || "8000";
const API_ORIGIN = `http://localhost:${API_PORT}`;

// Specs identify people by email because that's what you sign in with. A
// username is required now too, so derive a legal one when a spec doesn't care
// what it is — the same shape the migration used for rows that predated the
// column.
function usernameFor(email) {
  const base =
    String(email || "")
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .replace(/^[0-9_-]+/, "") || "person";
  let name = base.slice(0, 20);
  while (name.length < 3) name += "x";
  return name;
}

const DEMO_PROJECT = "demo";
const isDemo = (testInfo) => testInfo.project.name === DEMO_PROJECT;

// — demo target ---------------------------------------------------------------
const backendUrl = pathToFileURL(
  path.join(__dirname, "..", "..", "js", "demo", "backend.js")
).href;
const seed = require("../../js/demo/seed.json");

async function newDemoBackend() {
  const { createDemoBackend } = await import(backendUrl);
  // No seed: the specs assume an empty database that they fill themselves, the
  // same slate /__reset gives them against the mock. seed.json is what a real
  // visitor lands on, not a fixture — demo-seed.spec.js covers that separately.
  // persist:false keeps this off localStorage, which doesn't exist in Node.
  return createDemoBackend({ seed: null, persist: false, latency: 0 });
}

// Runs in the page before any app code: writing the key the demo backend reads
// on boot is all the "seeding" that's needed.
//
// Worth knowing: this also clears the session, so every test starts signed out
// — and it runs on every *document* load, not every navigation. page.goto("/")
// has no fragment and so reloads the document; page.goto("/#/") doesn't. A test
// that signs in through the UI and then navigates with the first form will find
// itself signed out again.
function installDemoState(state) {
  try {
    if (state) localStorage.setItem("commons.demo.v1", JSON.stringify(state));
    // every test starts signed out, with no leftover upvote mirror
    localStorage.removeItem("commons.session");
    localStorage.removeItem("commons.votes");
    sessionStorage.removeItem("commons.demo.strip-folded");
  } catch (e) {
    /* storage unavailable — the test will fail loudly enough on its own */
  }
}

// Plant a session in localStorage so a test can start on a signed-in screen
// without walking the whole sign-in flow first.
//
// The session is { token, id, username } — a token alone no longer tells the
// app whose posts are whose, which is exactly what /users/me exists to answer.
// So the fixture asks the same question the app asks.
async function installSession(page, session) {
  await page.addInitScript(
    (s) => {
      try {
        localStorage.setItem("commons.session", JSON.stringify(s));
      } catch (err) {}
    },
    session
  );
  // An init script only runs on a document load, and this app is a hash router:
  // once a document is up, every goto is a same-document fragment change that
  // would never pick the session up. Reload so the store actually reads it.
  if (!page.url().startsWith("about:")) await page.reload();
}

function withDemoQuery(page) {
  const original = page.goto.bind(page);
  page.goto = (url, options) => {
    const resolved = new URL(url, "http://localhost/");
    resolved.searchParams.set("demo", "1");
    return original(
      url.startsWith("http")
        ? resolved.href
        : resolved.pathname + resolved.search + resolved.hash,
      options
    );
  };
  return page;
}

// Lets the `browser` wrapper reach the live state without threading it through
// Playwright's fixture graph. Set by the `api` fixture, per test.
let currentDemoState = () => null;

const test = base.test.extend({
  // Several mobile specs build their own context with browser.newContext()
  // instead of taking the `page` fixture. In demo mode those pages need the
  // same seeded state and the same ?demo=1 treatment, so the browser handed to
  // a test is wrapped to provide both.
  browser: async ({ browser }, use, testInfo) => {
    if (!isDemo(testInfo)) return use(browser);

    const realNewContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await realNewContext(...args);
      await context.addInitScript(installDemoState, currentDemoState());
      const realNewPage = context.newPage.bind(context);
      context.newPage = async () => withDemoQuery(await realNewPage());
      return context;
    };
    await use(browser);
    browser.newContext = realNewContext;
  },

  page: async ({ page }, use, testInfo) => {
    await use(isDemo(testInfo) ? withDemoQuery(page) : page);
  },

  api: async ({ playwright, context, page }, use, testInfo) => {
    if (isDemo(testInfo)) {
      const backend = await newDemoBackend();
      backend.reset();
      currentDemoState = () => backend.control.snapshot();

      // addInitScript registrations stack and run in order, so re-registering
      // after each change means the last writer wins — which is what we want,
      // and cheaper than making one script read a moving value.
      const install = () => context.addInitScript(installDemoState, currentDemoState());
      await install();

      await use({
        reset: async () => {
          backend.reset();
          await install();
        },
        seed: async (count, author) => {
          const created = backend.control.seed({ count, author });
          await install();
          // Shaped like the Playwright APIResponse the HTTP branch returns, so
          // specs can keep calling `(await api.seed(1, x)).json()`.
          return { json: async () => ({ ok: true, created }) };
        },
        register: async (email, password, username) => {
          backend.control.register(email, password, username);
          await install();
        },
        failNext: async (rule) => {
          // Prefer the adapter the page is actually running. The Node-side
          // backend only reaches the browser through an init script, which
          // runs on a *document* load — so queueing a failure there after the
          // app is already up would arrive too late to fail anything. The
          // control surface config.js puts on window is the live store.
          const queued = await page
            .evaluate((r) => {
              if (!window.__commonsDemo) return false;
              window.__commonsDemo.failNext(r);
              return true;
            }, rule)
            .catch(() => false);
          if (queued) return;
          backend.control.failNext(rule);
          await install();
        },
        breakFeed: async () => {
          backend.control.failNext({
            method: "GET",
            path: "^/posts/",
            network: true,
          });
          await install();
        },
        // What's actually in the store, for the handful of assertions that
        // have no public read path — a cascade, mostly: once a post is
        // deleted its comments have no URL left to ask about.
        //
        // Read out of the *page*, not out of the Node-side backend: in demo
        // mode the browser's localStorage is the authoritative copy, and
        // anything the test did through the UI happened there.
        dump: async (target) =>
          target.evaluate(() => {
            try {
              return JSON.parse(localStorage.getItem("commons.demo.v1")) || {};
            } catch (e) {
              return {};
            }
          }),
        signIn: async (target, email, password) => {
          const token = backend.control.tokenFor(email, password);
          if (!token) throw new Error(`demo backend refused a login for ${email}`);
          const who = backend.control.whoIs(email);
          // onto the page's *own* context, which for several mobile specs is
          // one they built themselves rather than the `context` fixture — the
          // new token has to reach the page that's about to use it.
          await target.context().addInitScript(installDemoState, currentDemoState());
          await installSession(target, {
            token,
            id: who.id,
            username: who.username,
          });
        },
        origin: "demo://in-browser",
      });

      currentDemoState = () => null;
      return;
    }

    const ctx = await playwright.request.newContext();
    const post = (p, data) => ctx.post(`${API_ORIGIN}${p}`, data ? { data } : undefined);

    await post("/__reset");

    await use({
      reset: () => post("/__reset"),
      seed: (count, author) => post("/__seed", author ? { count, author } : { count }),
      failNext: (rule) => post("/__fail_next", rule),
      register: (email, password, username) =>
        ctx.post(`${API_ORIGIN}/users/`, {
          data: { email, password, username: username || usernameFor(email) },
        }),
      // There *is* a network here, so the bluntest possible outage: drop the
      // request on the floor. The demo branch queues a failure inside the
      // adapter instead; same observable result.
      breakFeed: () => page.route(/\/posts\//, (route) => route.abort()),
      // The mock's equivalent of reading the demo's localStorage blob.
      dump: async () => (await ctx.get(`${API_ORIGIN}/__state`)).json(),
      signIn: async (target, email, password) => {
        const res = await target.request.post(`${API_ORIGIN}/login`, {
          form: { username: email, password },
        });
        if (!res.ok()) throw new Error(`mock /login refused a login for ${email}`);
        const { access_token: token } = await res.json();

        // The same second call the app makes: a token says nothing about who
        // it signed in.
        const me = await target.request.get(`${API_ORIGIN}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!me.ok()) throw new Error(`mock /users/me refused a token for ${email}`);
        const { id, username } = await me.json();
        await installSession(target, { token, id, username });
      },
      origin: API_ORIGIN,
    });

    await ctx.dispose();
  },
});

// A loaded post card, as opposed to one of the loading skeletons — which share
// the .card class on purpose, so they reserve exactly the right space. Any
// assertion that means "the feed has arrived" wants this one: against an API
// that answers instantly a bare .card usually happens to be right, and against
// one with real latency it silently matches a skeleton instead.
const CARD = ".card:not(.card--skeleton)";

module.exports = { test, expect: base.expect, API_ORIGIN, CARD, usernameFor };
