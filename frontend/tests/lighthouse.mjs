#!/usr/bin/env node
/**
 * Lighthouse against the demo build — the thing people actually load.
 *
 * `?demo=1` makes the app answer its own API calls, so this needs no backend
 * and measures the same bytes the Pages deploy serves.
 *
 * Three runs and the median, because a single throttled run on a shared CI box
 * swings by several points for reasons that have nothing to do with the code.
 * The assertions are floors, not targets: they exist to catch a regression — a
 * stray render-blocking script, a dropped label — not to chase 100.
 *
 * ── why this is a script and not `@lhci/cli` ────────────────────────────────
 * It used to be `lhci autorun` against `lighthouserc.json`. `@lhci/cli` has not
 * shipped a release since mid-2025 and pins its own copy of Lighthouse 12,
 * which is where all ten of this repo's `npm audit` findings came from — every
 * one of them a transitive dependency of a tool that only ever runs in CI.
 *
 * It was also the reason `npm ci` failed on Node 22 while working on Node 24:
 * `@lhci/cli` pins `proxy-agent@6`, the current `@puppeteer/browsers` wants
 * `proxy-agent >=8` as a peer, and the two can't both be satisfied. npm 11
 * papered over that when it wrote the lockfile; npm 10 refused to install from
 * it. See docs/adr/0006-lighthouse-without-lhci.md.
 *
 * What's lost: the LHCI server upload targets and assertion presets, neither of
 * which this repo used. What's kept: the runs, the median, the floors, and the
 * reports on disk. What's gained: one fewer unmaintained dependency, and the
 * Lighthouse that runs is the one this repo declares.
 *
 * Needs Chromium — `npx playwright install chromium`, which the test suite
 * needs anyway. Deliberately that binary rather than whatever Chrome happens to
 * be on the machine: it's pinned by the lockfile, so a score moving means the
 * site moved.
 *
 *   node tests/lighthouse.mjs            desktop — what CI runs
 *   node tests/lighthouse.mjs --mobile   Lighthouse's default mobile profile,
 *                                        which is the number the README quotes
 */

import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

import * as chromeLauncher from "chrome-launcher";
import lighthouse, { desktopConfig } from "lighthouse";
import { computeMedianRun } from "lighthouse/core/lib/median-run.js";
import { ReportGenerator } from "lighthouse/report/generator/report-generator.js";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "..");
const OUT = path.join(HERE, ".lighthouse");

const RUNS = 3;
const PAGE = "/index.html?demo=1";

// Mobile is a throttled emulation — 4x CPU, slow 4G — so its performance floor
// is lower and it is not what CI gates on. It exists so the mobile row in the
// README is a command somebody can run rather than a number somebody typed.
const MOBILE = process.argv.includes("--mobile");

// Floors, not targets. Accessibility is the one that has to be perfect: every
// screen is checked by axe in the Playwright suite too, so anything below 1
// here is a real regression rather than a scoring quirk.
const FLOORS = {
  performance: MOBILE ? 0.85 : 0.95,
  accessibility: 1,
  "best-practices": 0.95,
  seo: 0.9,
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

// Compressible types only. Gzipping a woff2 or a png makes them bigger, and
// Lighthouse would rightly complain about both.
const COMPRESS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".webmanifest",
  ".txt",
]);

/**
 * A static server that behaves enough like GitHub Pages for the numbers to
 * mean something: gzip on text, a long cache on immutable assets. Without the
 * first of those, "Enable text compression" fails and the performance score
 * measures this script rather than the site.
 */
function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const file = path.join(SITE, rel);

    // Nothing here is user input in any real sense — it's a fixed directory
    // served to a browser on this machine — but a static server that can be
    // walked out of with ../ is not one worth writing.
    if (!file.startsWith(SITE + path.sep) || !existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }

    const ext = path.extname(file);
    const headers = {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000",
      "X-Content-Type-Options": "nosniff",
    };

    const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    if (wantsGzip && COMPRESS.has(ext)) {
      headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers);
      return createReadStream(file).pipe(createGzip()).pipe(res);
    }
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    // Port 0: let the OS pick. A fixed port is a flake waiting for the day
    // something else on the box is already using it.
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function chromePath() {
  const bin = chromium.executablePath();
  if (!existsSync(bin)) {
    console.error(
      "Chromium isn't installed. Run:  npx playwright install chromium\n" +
        `(looked for it at ${bin})`
    );
    process.exit(1);
  }
  return bin;
}

async function main() {
  const { server, port } = await serve();
  const url = `http://127.0.0.1:${port}${PAGE}`;

  const chrome = await chromeLauncher.launch({
    chromePath: chromePath(),
    // --no-sandbox because CI runs as root in a container and Chrome refuses
    // to start otherwise; it is not a setting this project would ship.
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const results = [];
    for (let i = 1; i <= RUNS; i++) {
      process.stdout.write(`  run ${i}/${RUNS} … `);
      const run = await lighthouse(
        url,
        { port: chrome.port, output: "json", logLevel: "error" },
        // No config at all is Lighthouse's default, which is the mobile one.
        MOBILE ? undefined : desktopConfig
      );
      if (!run) throw new Error("Lighthouse returned nothing");
      results.push(run.lhr);
      process.stdout.write(
        Object.keys(FLOORS)
          .map((c) => `${c[0]}${Math.round((run.lhr.categories[c]?.score ?? 0) * 100)}`)
          .join(" ") + "\n"
      );
    }

    const median = computeMedianRun(results);
    const name = MOBILE ? "mobile" : "desktop";

    await mkdir(OUT, { recursive: true });
    await writeFile(
      path.join(OUT, `${name}.report.json`),
      JSON.stringify(median, null, 2)
    );
    await writeFile(
      path.join(OUT, `${name}.report.html`),
      ReportGenerator.generateReportHtml(median)
    );

    const failures = [];
    console.log(`\n  ${name}, median of ${RUNS} runs:`);
    for (const [category, floor] of Object.entries(FLOORS)) {
      const score = median.categories[category]?.score ?? 0;
      const ok = score >= floor;
      const shown = String(Math.round(score * 100)).padStart(3);
      console.log(
        `   ${ok ? "✓" : "✗"} ${category.padEnd(14)} ${shown}  (floor ${Math.round(
          floor * 100
        )})`
      );
      if (!ok) failures.push(`${category}: ${score.toFixed(2)} < ${floor}`);
    }

    console.log(`\n  reports: ${path.relative(process.cwd(), OUT)}`);

    if (failures.length) {
      console.error("\nLighthouse floors not met:\n  " + failures.join("\n  "));
      // The report on disk says which audits moved, which is the question
      // anybody reading this failure actually has.
      process.exitCode = 1;
    }
  } finally {
    await chrome.kill();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
