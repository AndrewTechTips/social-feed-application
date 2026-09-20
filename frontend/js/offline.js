// @ts-check
// Saying so when the network has gone.
//
// The app has worked offline since the service worker shipped and has never
// once mentioned it, which is the difference between working offline and
// *looking like* it does. A reader whose train goes into a tunnel gets the
// same screen either way and no reason to believe the second one is deliberate.
//
// ── one line, not a toast storm ────────────────────────────────────────────
// `online` and `offline` fire on every flap of a bad connection, and a toast
// per event would be the app shouting about its own plumbing. So this is a
// band under the header that is simply there or not there — no entrance
// animation, no dismiss control, nothing to interact with. It is a state, not
// an event, and it should read like a state.
//
// ── what it is allowed to claim ────────────────────────────────────────────
// `navigator.onLine` is only trustworthy in one direction. False means there
// is no network interface at all, which is reliable; true means an interface
// exists and says nothing whatever about whether anything is reachable
// through it. So this only ever speaks up for the half it can prove, and the
// words are about what is still true rather than about what has broken:
// what is already here still reads, and what you have typed is still yours.
//
// On the published build that second sentence is the whole story — the API is
// a module in this browser, so nothing is unreachable and nothing is lost.
// Against a real backend it is narrower and still true.

import { h } from "./dom.js";
import { live } from "./live.js";

/** No network interface at all. See the note above about the other direction. */
export const isOffline = () => navigator.onLine === false;

const board = live(() => (isOffline() ? "offline" : null));

addEventListener("online", board.notify);
addEventListener("offline", board.notify);

/**
 * The band under the header.
 *
 * Mounted once, at boot, in the same place the demo notice puts its band —
 * they stack, and on the published build they can both be up at once, which is
 * two true sentences rather than a collision.
 */
export function mountOfflineBand() {
  const band = board.block(
    () => [
      h(
        "p",
        { class: "netband__text" },
        h("strong", { class: "netband__label" }, "Offline"),
        " — what's already here still reads."
      ),
    ],
    {
      class: "netband",
      // polite, not assertive: losing a connection is not an emergency, and a
      // screen reader should finish the sentence it is on before it says so.
      role: "status",
      "aria-live": "polite",
    }
  );
  // After the demo band if there is one, so the notice about what this app *is*
  // stays closest to the header it belongs to.
  const header = document.querySelector(".site-header");
  const demo = document.querySelector(".demo--band");
  (demo || header)?.after(band);
  return band;
}

/**
 * The line in the composer.
 *
 * The one screen where being offline costs something the reader can lose, and
 * therefore the one screen that has to say what it has kept. js/draft.js has
 * been saving every keystroke to localStorage since it shipped; this is that
 * promise said out loud at the moment it matters.
 */
export function draftIsSafeNote() {
  return board.block(
    () => [
      h(
        "p",
        { class: "compose__offline-line" },
        "You're offline, so this can't be posted yet — but it is saved in this " +
          "browser as you type, and it will still be here when you come back."
      ),
    ],
    { class: "compose__offline", role: "status" }
  );
}
