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
function installDemoState({ state, stamp }) {
  try {
    // Seed once per fixture action, not once per document load.
    //
    // This runs on every load, and it used to write unconditionally — which
    // was invisible until the demo's refresh session moved into the same blob.
    // Then a reload would put back the cookie the page had just signed out of,
    // and a draft written through the UI would vanish, because the snapshot
    // the fixture holds was taken before any of that happened.
    //
    // The stamp draws the line: the fixture owns the state up to the moment it
    // last seeded, and from there the page owns it. sessionStorage is exactly
    // the right place to keep it — it survives a reload in the same tab and
    // starts empty in a new context, which is the distinction being made.
    //
    // The comparison is `>=`, not `!==`, because registrations *stack*: a test
    // that seeds three times leaves three copies of this script, and all three
    // run on every load. Equality would let the older two fire again on a
    // reload and walk the page back through the state it had two actions ago.
    if (Number(sessionStorage.getItem("commons.test.seed") || 0) >= Number(stamp)) {
      return;
    }
    sessionStorage.setItem("commons.test.seed", stamp);

    if (state) localStorage.setItem("commons.demo.v1", JSON.stringify(state));
    // every test starts signed out, with no leftover upvote mirror
    localStorage.removeItem("commons.identity");
    localStorage.removeItem("commons.csrf");
    // The key the app used to keep a bearer token under. Gone from the app,
    // but a fixture that stopped clearing it would let one leak between tests
    // on a machine that ran the suite before this landed.
    localStorage.removeItem("commons.session");
    localStorage.removeItem("commons.votes");
    sessionStorage.removeItem("commons.demo.strip-folded");
  } catch (e) {
    /* storage unavailable — the test will fail loudly enough on its own */
  }
}

// Plant an *identity* so a test can start on a signed-in screen without walking
// the whole sign-in flow first.
//
// Note what is no longer planted: a token. Since refresh tokens landed, the
// only thing in storage is { id, username } — public information — and the
// credential is a refresh cookie the browser holds and the app never reads.
// So the fixture has to open a real session too, which is what the two callers
// below do before calling this: against the mock they POST /login through the
// browser context, so the cookie lands in the jar exactly as it would for a
// person; against the demo adapter they open a session in its state.
//
// The upshot is that the shortcut is no longer a shortcut past the auth flow —
// it only skips the typing. The first request the app makes trades the cookie
// for an access token, and if any of that is broken these fixtures break with
// it, which is the right blast radius for a test helper.
async function installIdentity(page, identity, csrf) {
  await page.addInitScript(
    ([who, token]) => {
      try {
        localStorage.setItem("commons.identity", JSON.stringify(who));
        // The CSRF token the session was opened with. A real sign-in puts this
        // here itself; a fixture that skipped it would leave the page holding
        // a live cookie it could never refresh, which is a very confusing way
        // to be signed out.
        localStorage.setItem("commons.csrf", token);
      } catch (err) {}
    },
    [identity, csrf]
  );
  // An init script only runs on a document load, and this app is a hash router:
  // once a document is up, every goto is a same-document fragment change that
  // would never pick the identity up. Reload so the store actually reads it.
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
// Bumped by every fixture action that seeds; see installDemoState.
let seedStamp = 0;
const seedPayload = () => ({ state: currentDemoState(), stamp: String(seedStamp) });

/**
 * Run one of the demo adapter's control functions in the page.
 *
 * Deliberately does *not* re-seed afterwards. These change the page's own copy
 * of the state, and the page is what a reload should see — which is exactly
 * the rule the stamp in installDemoState exists to enforce.
 */
async function demoControl(target, name) {
  await target.waitForFunction(() => !!window.__commonsDemo);
  await target.evaluate((fn) => window.__commonsDemo[fn](), name);
}

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
      await context.addInitScript(installDemoState, seedPayload());
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
      const install = () => {
        seedStamp += 1;
        return context.addInitScript(installDemoState, seedPayload());
      };
      await install();

      await use({
        reset: async () => {
          backend.reset();
          await install();
        },
        seed: async (count, author, votes) => {
          const created = backend.control.seed({ count, author, votes });
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
          const opened = backend.control.signIn(email, password);
          if (!opened) throw new Error(`demo backend refused a login for ${email}`);
          const who = backend.control.whoIs(email);
          // onto the page's *own* context, which for several mobile specs is
          // one they built themselves rather than the `context` fixture — the
          // session that was just opened has to reach the page about to use it.
          seedStamp += 1;
          await target.context().addInitScript(installDemoState, seedPayload());
          await installIdentity(
            target,
            { id: who.id, username: who.username },
            opened.csrf
          );
        },
        // The three things a spec can do to a real browser and has to be
        // handed for the in-browser adapter: age the access token, throw the
        // refresh cookie away, and replace it with one that was never issued.
        //
        // Each waits for the control surface, which config.js only puts on
        // window once the adapter has actually been loaded — it is resolved on
        // first use, not at import, so that every module importing config.js
        // doesn't have to wait on a fetch.
        //
        // And each syncs afterwards. These change the *page's* copy of the
        // demo state, while the init script that runs on every document load
        // carries the Node-side snapshot — so without this, a reload would put
        // the cookie straight back and quietly undo the thing the test just
        // did. Re-registering with what the page now holds makes the page the
        // source of truth, which for anything done through the UI it already
        // is.
        expireAccess: (target) => demoControl(target, "expireAccess"),
        dropRefreshCookie: (target) => demoControl(target, "dropRefreshCookie"),
        forgeRefreshCookie: (target) => demoControl(target, "forgeRefreshCookie"),
        // There is no network to break, so break the adapter instead — the
        // same one-shot failure the rest of the suite uses for the feed.
        breakRefresh: async (target) => {
          await target.waitForFunction(() => !!window.__commonsDemo);
          await target.evaluate(() =>
            window.__commonsDemo.failNext({
              method: "POST",
              path: "^/auth/refresh",
              network: true,
            })
          );
        },
        // Whether the browser still holds a refresh token. Here that's a value
        // in the adapter's own state; against the mock it's a real cookie.
        sessionCookie: async (target) => {
          await target.waitForFunction(() => !!window.__commonsDemo);
          return target.evaluate(() => window.__commonsDemo.refreshCookie());
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
      // `votes` gives every post this call creates that many upvotes — the one
      // way a spec can put a post on either side of the warmth threshold.
      seed: (count, author, votes) =>
        post("/__seed", {
          count,
          ...(author ? { author } : {}),
          ...(votes ? { votes } : {}),
        }),
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
        // Through the *page's own* request context, which shares a cookie jar
        // with the browser. That's the whole trick: the refresh cookie the
        // mock sets lands where a person's would, so everything after this
        // point — the boot refresh, the silent recovery, signing out — runs
        // against a real cookie with real flags rather than a planted string.
        const res = await target.request.post(`${API_ORIGIN}/login`, {
          form: { username: email, password },
        });
        if (!res.ok()) throw new Error(`mock /login refused a login for ${email}`);
        const { access_token: token, csrf_token: csrf } = await res.json();

        // The same second call the app makes: a token says nothing about who
        // it signed in.
        const me = await target.request.get(`${API_ORIGIN}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!me.ok()) throw new Error(`mock /users/me refused a token for ${email}`);
        const { id, username } = await me.json();
        await installIdentity(target, { id, username }, csrf);
      },
      expireAccess: async () => {
        await ctx.post(`${API_ORIGIN}/__expire_access`);
      },
      // There *is* a network here, so the bluntest possible outage — the same
      // treatment breakFeed gives the feed.
      breakRefresh: (target) =>
        target.route(/\/auth\/refresh/, (route) => route.abort()),
      sessionCookie: async (target) => {
        const jar = await target.context().cookies();
        const found = jar.find((c) => c.name === "commons_refresh");
        return found ? found.value : null;
      },
      dropRefreshCookie: async (target) => {
        await target.context().clearCookies();
      },
      forgeRefreshCookie: async (target) => {
        await target.context().clearCookies();
        await target.context().addCookies([
          {
            name: "commons_refresh",
            value: "deadbeefdeadbeefdeadbeefdeadbeef.not-a-real-secret",
            domain: "localhost",
            path: "/auth",
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
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

/**
 * Wait for the screen to stop moving before measuring it.
 *
 * mountView adds `.route-enter`, which fades the new view up from opacity 0
 * and removes the class on animationend. Measuring during those ~120ms blends
 * every foreground and background toward each other, which to axe looks like a
 * page-full of contrast failures that don't exist once the animation lands —
 * the first run of a11y.spec.js produced thirteen of them.
 *
 * CSS transitions are in `getAnimations()` too, and that is the half this is
 * also needed for: `.card` transitions its background-colour, so a test that
 * flips `data-theme` and reads a colour straight afterwards gets a value from
 * somewhere between the two themes — a dark-theme foreground measured against
 * a background still most of the way to white.
 *
 * Two kinds are skipped, both because waiting on them would hang forever.
 * Infinite ones: the skeleton shimmer and the background blooms. And
 * progress-based ones — the post's reading hairline runs on a scroll timeline,
 * so it finishes when the reader reaches the bottom of the page and not
 * before. It is already showing its correct value at every moment, which is
 * the only sense in which "settled" means anything for it.
 */
async function settled(page) {
  await page.waitForFunction(() => !document.querySelector(".route-enter"));
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (a) =>
            a.effect?.getComputedTiming().iterations !== Infinity &&
            a.timeline instanceof DocumentTimeline
        )
        .map((a) => a.finished.catch(() => {}))
    )
  );
}

module.exports = { test, expect: base.expect, API_ORIGIN, CARD, usernameFor, settled };
