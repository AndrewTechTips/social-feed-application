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
import { setAppBadge } from "./install.js";

const POLL_MS = 45000;

// The most unread rows this will look through when a kind has been switched
// off. Matches the endpoint's own page_size ceiling.
const COUNT_CAP = 50;

// — what you want to hear about ---------------------------------------------
//
// Two kinds and a badge, kept in one key because they are one idea and
// because the panel on #/settings lists keys: three keys for three switches
// would be three lines there saying the same thing.
//
// ── this filters the view, it does not stop the record ────────────────────
// The server knows nothing about any of this. Turning a kind off hides it
// here; the rows are still made, and turning it back on shows what arrived
// while you were not listening. That is the honest behaviour for a setting
// somebody may change twice in a week, and it is also the only one available
// without a preferences table nobody asked for.
//
// ── and it is deliberately not a server query ─────────────────────────────
// `/notifications/` has no `kind` parameter, and adding one would be the
// right answer if this were a filter the server should know about. It isn't:
// see above. So the filtering happens here, and the cost is described where
// it is paid, in refreshUnread below.
export const NOTIFY_KEY = "commons.notify";

const DEFAULTS = { reply: true, comment: true, badge: true };

/** @returns {{reply: boolean, comment: boolean, badge: boolean}} */
export function notifyPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIFY_KEY) || "{}");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    return {
      reply: raw.reply !== false,
      comment: raw.comment !== false,
      badge: raw.badge !== false,
    };
  } catch (e) {
    // Disabled storage, or something else's key. Everything on is the state
    // somebody who has never opened settings is in, so it is the right
    // answer to "we could not read your choices".
    return { ...DEFAULTS };
  }
}

/**
 * Change one of them.
 *
 * Written as the difference from the defaults rather than as the whole
 * object, so a browser that has never changed anything stores nothing — the
 * same rule the theme follows, and the same reason: the data panel can then
 * say truthfully that it is holding nothing of yours.
 *
 * @param {"reply" | "comment" | "badge"} which
 * @param {boolean} on
 */
export function setNotifyPref(which, on) {
  const next = { ...notifyPrefs(), [which]: on };
  const changed = Object.fromEntries(
    Object.entries(next).filter(([k, v]) => v !== DEFAULTS[k])
  );
  try {
    if (Object.keys(changed).length) {
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(changed));
    } else {
      localStorage.removeItem(NOTIFY_KEY);
    }
  } catch (e) {
    /* storage disabled — the choice holds for this page and no longer */
  }
  // Anything already in flight was asked under the old preferences and is
  // about to answer the wrong question — see refreshUnread.
  generation++;
  dispatchEvent(new CustomEvent("commons:notifyprefs", { detail: next }));
  // The badge, directly and now.
  //
  // announce() is the only other caller and it returns early when the number
  // has not changed — which is exactly this case: switching the badge off
  // changes no count, so the icon would have kept yesterday's number until
  // the next reply arrived. The one place the reader cannot see the switch
  // work is the one place it has to.
  setAppBadge(next.badge ? unread : 0);
  // And the count, which can change: a kind switched off stops being
  // counted, and the header should not wait up to forty-five seconds to say
  // so.
  void refreshUnread();
  return next;
}

/**
 * Is this row one the reader still wants to hear about?
 *
 * Exported because the list screen has to make the same decision, and two
 * copies of "which kinds count" is how a screen and its badge start
 * disagreeing about the same word.
 *
 * @param {{kind?: string}} row
 * @param {{reply: boolean, comment: boolean}} [prefs]
 */
export function wanted(row, prefs) {
  const p = prefs || notifyPrefs();
  return row && row.kind === "reply" ? p.reply : p.comment;
}

/** Is either kind still being listened for? */
export const listeningForAny = () => {
  const p = notifyPrefs();
  return p.reply || p.comment;
};

let unread = 0;
let timer = null;
let inFlight = null;
// Bumped whenever the preferences change, so a count that was asked for under
// the old ones can tell that it is no longer the answer. See refreshUnread.
let generation = 0;

/** How many unread notifications this reader has, as far as we know. */
export const unreadCount = () => unread;

function announce(next) {
  if (next === unread) return;
  unread = next;
  // The same number, in the one place it can be seen with the app shut. It
  // goes here rather than beside the header's lamp because this is where the
  // count actually changes, and a badge kept in step from a render is a badge
  // that goes stale the moment nothing renders.
  // Only if asked. The badge is the one part of this that survives the tab
  // being closed, so a reader who turned it off and found yesterday's number
  // still on the icon would be right to call it broken — hence zero rather
  // than "leave it alone".
  setAppBadge(notifyPrefs().badge ? next : 0);
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
  const prefs = notifyPrefs();
  // Above the in-flight check, not below it. With nothing to listen for the
  // answer is zero and needs no request — and putting this second meant a
  // second press arriving while the first press's request was still out got
  // swallowed by the share below, so nobody ever announced the zero.
  if (!prefs.reply && !prefs.comment) return announce(0);
  if (inFlight) return inFlight;
  // ── the answer can arrive after the question has changed ────────────────
  // Turning both kinds off in two presses does this: the first press starts
  // a request that counts the kind still switched on, the second answers
  // zero without asking anybody — and then the first lands and puts its
  // count back. Last write wins, and the last write is the stale one.
  //
  // Found by the demo project and not by the mock, which is the whole reason
  // the suite runs twice: the two adapters resolve on different schedules and
  // only one of them lost the race on the machine this was written on.
  const asked = generation;
  let stale = false;
  inFlight = (async () => {
    try {
      // ── one request either way ──────────────────────────────────────────
      // With both kinds on — which is everybody who has never opened
      // settings — this is the original ask: one row, and the answer is the
      // envelope's `total`. With one kind off the server cannot count for
      // us, so the same single request comes back with a page of rows
      // instead and the matching ones are counted here. Same round trip,
      // larger body, and only for the reader who asked for it.
      //
      // COUNT_CAP is where this stops being exact. A reader with more than
      // fifty unread has a number that is already not a number they are
      // reading, and asking for every page on a forty-five second timer to
      // refine it would be the app spending somebody's battery on the
      // difference between "lots" and "lots".
      const filtered = !prefs.reply || !prefs.comment;
      const size = filtered ? COUNT_CAP : 1;
      const page = await api.get(`/notifications/?unread=true&page_size=${size}`, {
        // Nobody asked for this. A 401 here means "not signed in", and the
        // reader must not be moved off the screen they are on to be told so.
        background: true,
      });
      // The preferences moved while this was out, so this is the answer to
      // the question that was asked and not to the one being asked now.
      // Dropping it is not enough: the call that moved them was very likely
      // the one the in-flight share above turned away, so if this simply
      // stays quiet the count keeps whatever it had. Ask again instead —
      // see the `finally`, which runs once this has let go of `inFlight`.
      if (asked !== generation) {
        stale = true;
        return;
      }
      if (!filtered) {
        announce(page.total || 0);
      } else {
        const rows = page.items || [];
        announce(rows.filter((row) => wanted(row, prefs)).length);
      }
    } catch (e) {
      /* leave the last known count alone */
    } finally {
      inFlight = null;
      // Converges: each retry captures the generation it was asked under, and
      // only a further change while *it* is out can make it stale again.
      if (stale) void refreshUnread();
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
  // A badge outlives the window that set it: it is on the icon, and the icon
  // is still there tomorrow. So the first thing to do on a fresh boot is say
  // zero — announce() below is a no-op when the count has not changed, and at
  // this point it has not, which would otherwise leave yesterday's number on
  // the home screen until the first notification of the day arrived.
  setAppBadge(unread);

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
