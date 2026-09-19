// @ts-check
// How many things have been said to you, and keeping that number current.
//
// The count and the list are the same endpoint: `?unread=true&page_size=1` and
// read the envelope's `total`. That is the trick the "new posts" pill plays
// against `/posts/?since=`, and it is worth the small oddity of asking for one
// row in order to be told a number — one shape to keep in step across the API,
// the mock and the demo adapter instead of two.
//
// ── why polling, again ─────────────────────────────────────────────────────
// The same argument as the feed's, and it applies harder here: notifications on
// this app arrive a few times a day. A socket held open for hours to deliver
// three messages is a connection per reader, async machinery in an otherwise
// synchronous codebase, and — the part that settles it — something that could
// only ever be demonstrated on a machine running the backend, because the
// published build has no server at all.
//
// Same interval as the feed's poll, deliberately: two timers at different
// periods would drift into a pattern where the app talks to the server twice in
// quick succession and then not at all.

import { api } from "./api.js";
import { get, subscribe } from "./store.js";

const POLL_MS = 45000;

let unread = 0;
let timer = null;
let inFlight = null;

/** How many unread notifications this reader has, as far as we know. */
export const unreadCount = () => unread;

function announce(next) {
  if (next === unread) return;
  unread = next;
  // The header draws from this. An event rather than a subscription on the
  // store, because the count is not part of the session and repainting the
  // whole account cluster on a number changing would be the app telling the
  // reader about its own plumbing.
  dispatchEvent(new CustomEvent("commons:notifications", { detail: next }));
}

/**
 * Ask once. Safe to call whenever; concurrent calls share one request.
 *
 * Failure is silent on purpose. This runs in the background on a timer, and a
 * toast saying "couldn't check your notifications" is the app apologising for
 * something the reader did not ask for and cannot act on.
 */
export async function refreshUnread() {
  if (!get("session")) return announce(0);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const page = await api.get("/notifications/?unread=true&page_size=1", {
        // Nobody asked for this. A 401 here means "not signed in", and the
        // reader must not be moved off the screen they are on to be told so.
        background: true,
      });
      announce(page.total || 0);
    } catch (e) {
      /* leave the last known count alone */
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Say locally that they have all been seen, without waiting for a round trip. */
export function markAllSeen() {
  announce(0);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function start() {
  stop();
  if (!get("session")) return;
  // Not while the tab is in the background. A timer that keeps firing on a
  // phone in somebody's pocket is a battery cost with nobody looking at the
  // result — and the first thing that happens when they come back is a fresh
  // ask, below, so nothing is missed by not having counted in the meantime.
  if (document.visibilityState !== "visible") return;
  refreshUnread();
  timer = setInterval(refreshUnread, POLL_MS);
}

/**
 * Begin. Called once from the boot path.
 *
 * Three things restart it: signing in or out, the tab becoming visible again,
 * and the initial call. Signing out stops it and zeroes the count, so the lamp
 * does not sit in the header with somebody else's number on it.
 */
export function startNotifications() {
  subscribe(() => {
    if (!get("session")) {
      stop();
      announce(0);
      return;
    }
    start();
  });
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") start();
    else stop();
  });
  start();
}
