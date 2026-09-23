// @ts-check
// The address Commons doesn't have.
//
// ── why this screen exists at all ──────────────────────────────────────────
// The router used to answer an unmatched hash with `navigate("/")`, and the
// test that pinned it argued that a mistyped fragment is not a screen that
// broke, so sending somebody to an apology for it would be the app blaming
// itself for a typo. That argument is right about *tone* and wrong about
// *silence*. A redirect answers a question nobody asked: the reader typed or
// followed something, it went nowhere, and the app replaced their address with
// a different one without ever saying so. If the link came out of somebody's
// notes or somebody else's message, the one fact worth having — this address
// is not a thing here — is exactly the fact the redirect threw away.
//
// So the fix is not to apologise. It is to *answer*. This screen says what was
// asked for, says plainly that it isn't an address the app has, says nothing is
// broken, and then spends the rest of its space on getting the reader somewhere
// they actually wanted — which is the job the redirect was trying to do, done
// where the reader can see it happening and choose.
//
// The hash is left alone. The bad address stays in the bar, for the same reason
// the router's error boundary leaves it there: a page that quietly rewrites the
// URL is a page you cannot bookmark, cannot report, and cannot press Back out
// of in the way you expect.
//
// ── the one loud thing in a quiet app ──────────────────────────────────────
// Everything else in Commons is deliberately unshowy — the error boundary is
// "serif, quiet, no red, no icon, no panel", and the accent is spent on a vote,
// on warmth and on where you are. This screen is the exception, on purpose: it
// is the only screen in the app that nobody chose to be on, so it has to
// establish where it is in one glance, before any sentence is read. It buys
// that with one gesture — the numerals, lit — and then goes straight back to
// the house voice for everything underneath. No second colour is introduced:
// the gradient runs from the accent to the page's own ink, so it is the same
// palette in both themes without a theme override anywhere in this file.
//
// The numerals are SVG text, not HTML text with `background-clip: text`. That
// is an accessibility decision rather than a visual one: clipping a gradient to
// HTML text needs `color: transparent`, which is a shape axe's colour-contrast
// rule has to guess about, and a decorative flourish has no business making a
// scan ambiguous. SVG text is outside that rule entirely, it is `aria-hidden`
// like the flourish it is, and the <h1> under it carries the whole message.

import { h } from "../dom.js";
import { mountView } from "../view.js";
import { get, knownPosts, knownFrom } from "../store.js";
import { openPalette } from "../components/palette.js";

// A pasted address can be any length. Past this it stops being a fact the
// reader can read back and starts being a wall, so it is cut — with the
// original left in the `title` for anyone who wants the whole of it.
const MAX_SHOWN = 64;

// Each mount gets its own gradient id. One 404 is ever on the page, so this is
// insurance rather than necessity — but a duplicated `id` is the kind of bug
// that shows up as "the numerals are black on one route and not the other",
// and a counter is cheaper than diagnosing that.
let seq = 0;

/** The numerals: one gesture, `aria-hidden`, and the only colour on the screen. */
function numerals() {
  const ink = `nf-ink-${++seq}`;

  return h(
    "div",
    { class: "notfound__mark", "aria-hidden": "true" },
    // A lamp behind the nought. The app's own metaphor — focus mode is
    // described as moving the lamp — and the reason the glow is centred rather
    // than spread: it lands inside the 0, which reads as the light still being
    // on in a room you walked past.
    h("span", { class: "notfound__glow" }),
    h(
      "svg",
      {
        class: "notfound__numerals",
        viewBox: "0 0 360 160",
        // Decorative, and already hidden by the wrapper. Both attributes are
        // here because Safari has historically exposed <svg> to the tree on
        // its own terms.
        role: "presentation",
        focusable: "false",
      },
      h(
        "defs",
        {},
        h(
          "linearGradient",
          { id: ink, x1: "0", y1: "0", x2: "0.85", y2: "1" },
          h("stop", { class: "notfound__stop-a", offset: "0" }),
          h("stop", { class: "notfound__stop-b", offset: "1" })
        )
      ),
      h(
        "text",
        { x: "180", y: "128", "text-anchor": "middle", fill: `url(#${ink})` },
        "404"
      )
    )
  );
}

/**
 * The list the reader was last looking at, offered as a way back into it.
 *
 * Free, and only sometimes there. `knownPosts()` is the list the feed, a
 * profile or a set of results last drew; it lives in memory and outlives the
 * screen that set it, so on a 404 reached from inside the app there is usually
 * something to offer and on a 404 reached from a pasted link there is usually
 * not. Nothing is fetched for this — a screen that exists to catch a failure
 * has no business having a failure mode of its own — so when the list is empty
 * the line simply isn't there, and nobody is shown a spinner on a dead end.
 *
 * @returns {HTMLElement | null}
 */
function resumeLine() {
  const posts = knownPosts();
  if (!posts.length) return null;
  const post = posts[0];
  if (!post || post.id == null || !post.title) return null;

  // knownFrom() names the list as a place — "the feed", "these results", a
  // username — because the post screen draws it in a sentence. Reusing it here
  // keeps the offer honest: the reader is not sent to "the feed" when what
  // they were reading was somebody's profile.
  const where = knownFrom();

  return h(
    "p",
    { class: "notfound__resume" },
    where ? `Or pick up where you were, in ${where}: ` : "Or pick up where you were: ",
    h("a", { class: "notfound__resume-link", href: `#/posts/${post.id}` }, post.title)
  );
}

/** One quiet link in the row of places that do exist. */
const place = (href, label) => h("li", {}, h("a", { href }, label));

export function renderNotFound() {
  // What they actually asked for, not what the router made of it: the query and
  // any trailing nonsense included, because that is the string they can compare
  // against wherever they copied it from.
  const asked = location.hash || "#/";
  const shown = asked.length > MAX_SHOWN ? asked.slice(0, MAX_SHOWN - 1) + "…" : asked;

  const search = h(
    "button",
    {
      class: "btn btn--ghost",
      type: "button",
      onclick: () => openPalette(),
    },
    "Search Commons"
  );

  // Notifications is the one place in this row that turns a signed-out reader
  // straight around into the sign-in form. Offering it to them would be a link
  // that lies about where it goes, so signed out it isn't offered.
  const places = [
    place("#/", "The feed"),
    place("#/shelf", "Your shelf"),
    get("session") && place("#/notifications", "Notifications"),
    place("#/settings", "Settings"),
    place("#/colophon", "Colophon"),
  ].filter(Boolean);

  const root = h(
    "section",
    { class: "notfound", "aria-labelledby": "notfound-title" },
    numerals(),
    h(
      "h1",
      { class: "notfound__title", id: "notfound-title" },
      "There's nothing down this path."
    ),
    h(
      "p",
      { class: "notfound__line" },
      "You've landed on an address Commons doesn't have — an old link, most " +
        "likely, or a slip on the way in. Nothing is broken, and nothing you " +
        "were doing is lost."
    ),
    h("p", { class: "notfound__asked" }, h("code", { title: asked }, shown)),
    h(
      "div",
      { class: "notfound__actions" },
      h("a", { class: "btn btn--primary", href: "#/" }, "Take me to the feed"),
      search
    ),
    resumeLine(),
    h(
      "nav",
      { class: "notfound__elsewhere", "aria-label": "Elsewhere in Commons" },
      h("p", { class: "notfound__elsewhere-label" }, "Or start somewhere else"),
      h("ul", { class: "notfound__places" }, places)
    )
  );

  // A journey, not a failure. The error boundary opts out of the page
  // transition because the screen the reader asked for never happened; here it
  // *did* happen — this is the real and complete answer to the address they
  // gave, so it arrives the way every other screen arrives.
  mountView(root);
}
