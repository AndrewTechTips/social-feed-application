// One question, asked before any test runs: is the thing on the API port
// actually the mock?
//
// `reuseExistingServer` is on outside CI, which is what makes an edit-run loop
// fast — and also what lets a real `uvicorn` left running on port 8000 quietly
// take mock_api.py's place. The suite then runs against a live Postgres with
// none of the fixture data in it, and the failures it produces point at
// everything except the cause: a `/__reset` that 404s, a sign-in refused for an
// account that was never created, a stray post from yesterday in the feed.
//
// It costs one request to rule out, and the message below is the hour it saves.

const http = require("http");

const API_PORT = process.env.API_PORT || "8000";

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

module.exports = async () => {
  const body = await probe(`http://localhost:${API_PORT}/`);
  // Nothing there yet is fine — Playwright's own webServer starts it.
  if (body === null) return;

  let service;
  try {
    service = JSON.parse(body).service;
  } catch (e) {
    service = undefined;
  }
  if (service === "commons-mock-api") return;

  throw new Error(
    `Something other than mock_api.py is answering on port ${API_PORT}.\n` +
      `It said: ${body.slice(0, 120)}\n\n` +
      "That is almost always a real backend left running. Stop it, or point\n" +
      "the suite somewhere else:\n\n" +
      "    pkill -f 'uvicorn backend.app.main'\n" +
      "    # or, keeping both: change API_BASE in js/config.js to a free port\n" +
      "    # and run with a matching API_PORT, e.g.  API_PORT=8010 npm test\n"
  );
};
