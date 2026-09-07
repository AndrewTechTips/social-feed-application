// Shared fixtures for the Commons e2e suite.
//
// `api` talks to the mock backend directly over HTTP and resets its state before
// each test, so every test starts from a clean, isolated slate.
//
// The app itself reaches the API at the origin hard-coded in frontend/js/config.js
// (http://localhost:8000). The mock must therefore listen on that same port — the
// Playwright config starts it there. If port 8000 is busy on your machine (e.g.
// the real backend is running), point both halves elsewhere for the test run:
// change config.js to your port and start with API_PORT set to match.

const base = require("@playwright/test");

const API_PORT = process.env.API_PORT || "8000";
const API_ORIGIN = `http://localhost:${API_PORT}`;

const test = base.test.extend({
  api: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext();
    const post = (p, data) =>
      ctx.post(`${API_ORIGIN}${p}`, data ? { data } : undefined);

    await post("/__reset");

    await use({
      reset: () => post("/__reset"),
      seed: (count, author) =>
        post("/__seed", author ? { count, author } : { count }),
      failNext: (method, pathRegex, status, detail) =>
        post("/__fail_next", { method, path: pathRegex, status, detail }),
      register: (email, password) =>
        ctx.post(`${API_ORIGIN}/users/`, { data: { email, password } }),
      origin: API_ORIGIN,
    });

    await ctx.dispose();
  },
});

module.exports = { test, expect: base.expect, API_ORIGIN };
