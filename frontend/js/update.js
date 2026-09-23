// @ts-check
// Noticing that a new version has been published, without being asked to.
//
// ── the gap this closes ────────────────────────────────────────────────────
// sw.js is network-first, so a reload always gets the current app. Nothing,
// however, made anyone reload. A tab left open across a deploy went on running
// the old code until its reader happened to refresh — and on an installed PWA,
// which opens to whatever it was last showing, that can be days. The app had
// no way to say "there is a newer one of me" because it had no way to know.
//
// ── why this lives in the page and not in sw.js ────────────────────────────
// The question is not "what is the newest version" — it is "is the newest
// version the one this document is running", and only the document knows the
// second half. A worker outlives the pages it serves and is shared between
// them; it would have to be told, by each page, which sha that page booted
// under, which is a message protocol invented to carry a fact the page already
// has. So the page holds its own baseline and compares against it. The worker
// is not involved at all, beyond declining to cache version.json.
//
// A consequence worth having: this works with no service worker, in a browser
// that has none, and on the very first visit before one has installed.
//
// ── what version.json is ───────────────────────────────────────────────────
// One object with the commit sha in it, written by .github/workflows/pages.yml
// at deploy time. It is not in the repository and not in SHELL: it is the one
// file whose whole purpose is to be current, so it is never cached, never
// precached, and never served by the worker.
//
// Locally it does not exist. That is not a failure case to handle so much as
// the ordinary state of a checkout — see `read()` for what "no answer" means.

import { h } from "./dom.js";
import { live } from "./live.js";

/** Where the deploy writes the sha. */
const VERSION_URL = new URL("../version.json", import.meta.url);

/**
 * The sha this document booted under, or null if we never got one.
 *
 * Null is load-bearing and is the whole of the first-visit case: a comparison
 * needs two sides, and until the first read comes back there is only one. A
 * checkout with no version.json, a first visit whose request is still in
 * flight, and a reader who is offline all land here, and all of them mean the
 * same thing — "no opinion" — which is the only honest thing to show.
 */
let baseline = null;

/** Latched: once a deploy has been seen, it stays seen until the page reloads. */
let superseded = false;

const board = live(() => (superseded ? "superseded" : null));

/**
 * The current sha according to the server, or null if it wouldn't say.
 *
 * `no-store` rather than `no-cache`: this must not be read from a cache and
 * must not be written to one either. GitHub Pages puts `max-age=600` on every
 * file it serves, this one included, so without it the beacon would be capable
 * of reporting a ten-minute-old present — a freshness check answered out of
 * the staleness it exists to detect.
 *
 * Every failure is the same answer. A 404 (no deploy has run), a parse error,
 * an offline reader, a Pages hiccup: none of them are evidence that the app
 * changed, so none of them may produce a claim that it did.
 */
async function read() {
  try {
    const response = await fetch(VERSION_URL, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.sha === "string" && body.sha ? body.sha : null;
  } catch (err) {
    return null;
  }
}

/**
 * Ask once, and decide what it means.
 *
 * The three branches, in the order they matter:
 *   · no answer            → say nothing. Not evidence of anything.
 *   · no baseline yet      → this *is* the baseline. The first visit ends here,
 *                            which is why nobody is ever greeted by a notice
 *                            that the app they have just opened is out of date.
 *   · answer ≠ baseline    → a deploy happened while this document was open.
 */
async function check() {
  const sha = await read();
  if (!sha) return;
  if (baseline === null) {
    baseline = sha;
    return;
  }
  if (sha === baseline || superseded) return;
  superseded = true;
  board.notify();
}

/**
 * The band under the header.
 *
 * Deliberately the same furniture as the offline notice in js/offline.js —
 * same class, same place, no entrance animation, no accent. A published
 * deploy is not news about the reader's world; it is a thing they can do
 * something about whenever they like, and the difference between that and an
 * emergency should be visible from across the room.
 *
 * `role="status"` and `aria-live="polite"` for the same reason it is polite
 * there: a screen reader should finish the sentence it is on. There is no
 * dismiss control because reloading is the dismiss control, and a notice you
 * can wave away is a notice that has to remember it was waved away.
 */
export function mountUpdateBand() {
  const band = board.block(
    () => [
      h(
        "p",
        { class: "updateband__text" },
        h("strong", { class: "updateband__label" }, "A new version is ready"),
        " — reload when you like; nothing here will be lost. ",
        h(
          "button",
          {
            type: "button",
            class: "btn btn--quiet updateband__action",
            onclick: () => location.reload(),
          },
          "Reload"
        )
      ),
    ],
    {
      class: "updateband",
      role: "status",
      "aria-live": "polite",
    }
  );
  // Its own class rather than a modifier on .netband, which is what it looked
  // like it wanted to be. The offline band is counted by tests/network.spec.js
  // — "in the document, not on the page" is a real claim about it — and a
  // second .netband would have made that count read 2 and every locator for it
  // ambiguous. They share their appearance in styles/components.css, where
  // sharing an appearance belongs; they do not share an identity.
  //
  // Under the offline band if there is one, which puts the bands in the order
  // they want acting on: what is broken now, then what is available whenever.
  const header = document.querySelector(".site-header");
  const offline = document.querySelector(".netband");
  const demo = document.querySelector(".demo--band");
  (offline || demo || header)?.after(band);
  return band;
}

/**
 * Start watching.
 *
 * Three triggers, and no timer among them. A poll would spend a request every
 * N seconds on a tab nobody is looking at, for a notice nobody can read, and
 * would still be slower than this in the case that matters.
 *
 *   · once at start, to take the baseline;
 *   · whenever the tab becomes visible, which is the exact moment a reader
 *     comes back to it — and on a phone, the moment they reopen the installed
 *     app. This is what makes "instant" true in the only sense a reader
 *     experiences: it is current by the time they are looking at it;
 *   · when the connection returns, because a reader who was offline across a
 *     deploy is precisely the one whose check failed and returned nothing.
 *
 * Nothing here needs tearing down: it is called once at boot and the listeners
 * live as long as the document does.
 */
export function watchForUpdates() {
  check();
  // On `document`, which is where visibilitychange is specified to fire. It
  // reaches window too, by bubbling — but only for an event that bubbles, and
  // the first version of this listened on window and was silent under a
  // synthetic `new Event("visibilitychange")` for exactly that reason. The
  // target the spec names is the target to listen on.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  // `online` does fire at the window, and not at the document.
  addEventListener("online", check);
}
