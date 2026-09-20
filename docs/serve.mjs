// A static file server, for the two scripts in here that need the app running.
//
// docs/make_icons.mjs photographs the app for the install dialog and
// docs/capture-pwa.mjs films it for the README, and both would otherwise ask
// you to start a server first and remember which port. Neither needs anything
// a real server does: these are files on disk that are already static.
//
// It listens on an ephemeral port, so it cannot collide with a dev server
// somebody already has on 5173.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";

// Enough of one to serve a directory of files that are already static. The
// only thing here that is not obvious is the MIME table: a module script
// served as application/octet-stream is a module script the browser refuses,
// so getting this wrong doesn't degrade, it blanks the page.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/**
 * Serve `root` on an ephemeral port.
 * @param {string} root  an absolute path
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>}
 */
export async function serve(root) {
  const server = createServer((req, res) => {
    (async () => {
      let name = decodeURIComponent(
        new URL(req.url || "/", "http://x").pathname,
      );
      if (name.endsWith("/")) name += "index.html";
      const file = path.join(root, name);
      // path.join has already normalised away any `..`; this is what catches
      // one that climbed out of the directory before it did.
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Content-Length": info.size,
        // The app registers a service worker. Nothing here should be answered
        // out of a cache that a previous run warmed.
        "Cache-Control": "no-store",
      });
      createReadStream(file).pipe(res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done(undefined))),
  };
}

