// @ts-check
// The colophon (#/colophon) — how this was made, inside the thing it describes.
//
// A colophon is a printing-house artifact: the page at the back of a book that
// names the type, the paper and the press. It is the most on-brand possible
// place for this app to show its working, and it is a *screen* rather than a
// link to a README because somebody who opened the demo out of curiosity will
// read a page and will not clone a repository.
//
// Two rules it is written under.
//
// The numbers are measured, not typed. They come from stats.json, which
// docs/stats.py generates and CI re-checks — the same arrangement the committed
// OpenAPI spec and the coverage badge have. A page about craft whose figures
// are quietly describing last month is worse than a page with no figures.
//
// The limitations are volunteered. "What's honest about this demo" is the
// section that makes the rest of it worth reading: an app that names the one
// place it had to compromise is making a claim a reviewer can check, and an app
// that doesn't is making one they can't.

import { h, mountView } from "../ui.js";
import { REPO_URL } from "../config.js";
import { openPalette } from "../components/palette.js";

const adr = (file) => `${REPO_URL}/blob/main/docs/adr/${file}`;

const out = (href, text) =>
  h("a", { href, target: "_blank", rel: "noopener" }, text);

/**
 * One row of the specification table: a figure and what it counts.
 * @param {number | undefined} value
 * @param {string} label
 */
function figure(value, label) {
  if (typeof value !== "number") return null;
  return h(
    "div",
    { class: "colophon__figure" },
    h("span", { class: "colophon__number" }, value.toLocaleString()),
    h("span", { class: "colophon__label" }, label)
  );
}

/** @param {Record<string, number>} stats */
function figures(stats) {
  const rows = [
    figure(stats.js_lines, "lines of hand-written JavaScript"),
    figure(stats.css_lines, "lines of hand-written CSS"),
    figure(stats.modules, "modules, with no bundler to join them"),
    figure(stats.runtime_dependencies, "third-party packages the browser loads"),
    figure(stats.backend_tests, "tests on the API"),
    figure(stats.e2e_tests, "end-to-end tests, run against two implementations of it"),
    figure(stats.coverage, "per cent of the backend covered"),
    figure(stats.decision_records, "decision records"),
  ].filter(Boolean);
  if (!rows.length) return null;
  return h("div", { class: "colophon__figures" }, rows);
}

function stack() {
  return h(
    "section",
    { class: "colophon__section" },
    h("h2", {}, "How it's made"),
    h(
      "p",
      { class: "colophon__prose" },
      "The API is FastAPI on PostgreSQL — SQLAlchemy 2.0, Alembic migrations, a " +
        "fifteen-minute access token and a rotating refresh token in a cookie the " +
        "page cannot read. Full-text search is a generated ",
      h("code", {}, "tsvector"),
      " with the title weighted above the body, behind a GIN index, rather than a ",
      h("code", {}, "LIKE"),
      " over the title."
    ),
    h(
      "p",
      { class: "colophon__prose" },
      "What you are looking at is hand-written HTML, CSS and ES modules. No " +
        "framework, no bundler, no build step, and nothing fetched from anybody " +
        "else's server. The files in the repository are the files the browser " +
        "runs — which is the whole reason for doing it this way round: the thing " +
        "you can read is the thing that executes. Types come from JSDoc and ",
      h("code", {}, "tsc --noEmit"),
      ", so the checking happens without anything being compiled away."
    ),
    h(
      "p",
      { class: "colophon__prose" },
      "It is set in Newsreader for anything that is writing and in the system " +
        "sans for anything that is a control, on one honey-amber accent that is " +
        "spent on three things and no others: a vote, a post the room has agreed " +
        "on, and where you are."
    )
  );
}

function decisions() {
  /** @type {[string, string, string][]} */
  const rows = [
    [
      "Vanilla JavaScript with JSDoc types",
      "A framework would have been faster to write and would have made this the ten-thousandth React feed. The types are real and the build step is nobody's.",
      "0001-vanilla-js-with-jsdoc-types.md",
    ],
    [
      "The refresh token lives in an httpOnly cookie",
      "It used to be a bearer token in localStorage, and the note next to it said to revisit exactly when this landed. Storage now holds a name and an id, neither of which gets anybody in.",
      "0003-token-in-an-httponly-cookie.md",
    ],
    [
      "Demo mode is the answer to a static host",
      "There is nowhere for FastAPI to run on GitHub Pages, and a published link that opens on “Can't reach the server” is worse than no link.",
      "0004-demo-mode-for-a-static-host.md",
    ],
    [
      "The service worker is network-first",
      "Cache-first assumes content-hashed filenames, which a project with no build step doesn't have — so it would leave a version constant standing between a reader and every change after it.",
      "0007-a-network-first-service-worker.md",
    ],
  ];

  return h(
    "section",
    { class: "colophon__section" },
    h("h2", {}, "Four decisions, and what they cost"),
    h(
      "ul",
      { class: "colophon__decisions" },
      rows.map(([title, why, file]) =>
        h(
          "li",
          {},
          h("h3", {}, out(adr(file), title)),
          h("p", {}, why)
        )
      )
    )
  );
}

function honest() {
  return h(
    "section",
    { class: "colophon__section" },
    h("h2", {}, "What's honest about this demo"),
    h(
      "p",
      { class: "colophon__prose" },
      "There is no server behind this page. GitHub Pages serves files and " +
        "nothing else, so the published build answers its own requests from a " +
        "module in the browser — the same endpoints, the same status codes, the " +
        "same shapes, with state in ",
      h("code", {}, "localStorage"),
      ". Anything you post here is yours alone and reaches nobody. Reset the " +
        "demo puts it back."
    ),
    h(
      "p",
      { class: "colophon__prose" },
      "It costs one thing, and the honest move is to name it rather than hope " +
        "nobody checks. The refresh token is supposed to live in a cookie this " +
        "code cannot read; on a static host there is no origin boundary to hide " +
        "a value behind, so demo mode keeps it in storage — which is exactly " +
        "what the real app moved away from."
    ),
    h(
      "p",
      { class: "colophon__prose" },
      "What stops the two drifting apart is that the contract is written down " +
        "and both are held to it: the generated ",
      out(`${REPO_URL}/blob/main/docs/openapi.json`, "OpenAPI spec"),
      " is committed and re-checked in CI, and the end-to-end suite runs twice — " +
        "once against this in-browser adapter and once against a real HTTP server " +
        "standing in for the backend."
    )
  );
}

function keyboard() {
  const open = h(
    "button",
    { class: "btn btn--ghost", type: "button", onclick: openPalette },
    "Open the palette"
  );
  return h(
    "section",
    { class: "colophon__section" },
    h("h2", {}, "Everything here has a key"),
    h(
      "p",
      { class: "colophon__prose" },
      "⌘K, or Ctrl-K, lists the ones that apply to the screen you are on, " +
        "and every row shows the key that runs it. There is no list of shortcuts " +
        "on this page on purpose: a second copy is a copy that goes wrong, and " +
        "the palette is the one that has to be right."
    ),
    open
  );
}

export async function renderColophon({ isStale }) {
  // Measured, committed, and re-checked in CI — see docs/stats.py. Resolved
  // against this module rather than against the document, because the document
  // carries a hash and this file does not move.
  let stats = null;
  try {
    const res = await fetch(new URL("../../stats.json", import.meta.url));
    if (res.ok) stats = await res.json();
  } catch (e) {
    /* offline before the shell was warmed, or a build without the file. The
       page is prose with or without the numbers; it simply says less. */
  }
  if (isStale()) return;

  const root = h(
    "section",
    { class: "colophon" },
    h("header", { class: "colophon__head" },
      h("h1", { class: "colophon__title" }, "Colophon"),
      h(
        "p",
        { class: "colophon__standfirst" },
        "The page at the back of a book names the type, the paper and the press. " +
          "This one names what Commons is made of, and what it is honest to say " +
          "about the copy you are looking at."
      )),
    stack(),
    stats ? h("section", { class: "colophon__section" },
      h("h2", {}, "What that comes to"),
      figures(stats),
      h("p", { class: "colophon__note" },
        "Counted from the repository rather than typed here, and re-counted by CI, " +
        "so a number that moved turns the build red instead of leaving this page lying.")
    ) : null,
    decisions(),
    honest(),
    keyboard(),
    h("footer", { class: "colophon__foot" },
      h("p", {},
        "All of it, including the parts this page is too short for, is in ",
        out(REPO_URL, "the repository"),
        " — the ",
        out(`${REPO_URL}/tree/main/docs/adr`, "decision records"),
        " are the best of it."))
  );

  mountView(root);
}
