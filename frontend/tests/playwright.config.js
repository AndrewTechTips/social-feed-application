// Playwright config for the Commons frontend end-to-end suite.
//
// It starts two servers: the static file server for the app, and mock_api.py
// standing in for the backend (see mock_api.py for why). Ports:
//
//   WEB_PORT   where the app is served    (default 5173)
//   API_PORT   where the mock API listens (default 8000 — must match
//              frontend/js/config.js so the app can reach it)
//
// If 8000 is taken on your machine, change config.js to a free port and run with
// a matching API_PORT, e.g.  API_PORT=8010 npm test

const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

const WEB_PORT = process.env.WEB_PORT || "5173";
const API_PORT = process.env.API_PORT || "8000";
const appDir = path.join(__dirname, "..");

module.exports = defineConfig({
  testDir: __dirname,
  outputDir: path.join(__dirname, ".artifacts"),
  // mock_api.py is one process with in-memory state, and each test resets it —
  // so tests run serially. The suite is small and fast enough that this is fine.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(__dirname, ".report"), open: "never" }],
  ],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  webServer: [
    {
      command: `python3 tests/mock_api.py --port ${API_PORT}`,
      cwd: appDir,
      port: Number(API_PORT),
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `python3 -m http.server ${WEB_PORT} --bind 127.0.0.1`,
      cwd: appDir,
      port: Number(WEB_PORT),
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
