// @ts-check
// The shelf: posts you meant to come back to.
//
// **Two shelves, and one of them is only a mirror.**
//
// Signed out, this is what it always was: one key in localStorage, read at
// boot, sent nowhere. Signed in, the `saves` table is the truth and this key
// is a local copy of it — which is what makes `isShelved` answerable without
// a request, on every card, while a list is being scrolled.
//
// That mirror is why the toggle is optimistic. A save is a press on a control
// beside a card and the answer has to be instant; the request follows, and a
// failure puts the pixel back. Same pattern the vote control has used since
// the beginning, for the same reason, and it is the reason `PUT`/`DELETE` on
// the server are idempotent — an optimistic client repeats itself.
//
// **What happens at the seam.** Signing in *merges*: everything on this
// browser's shelf is pushed up (idempotent, so a post already saved costs a
// 204 and nothing else), then the account's shelf is pulled down and becomes
// the mirror. Nobody loses a save by signing in, which is the one thing that
// would make the feature feel unsafe. Signing out clears the mirror, but only
// if it was an account's — a shelf built while signed out belongs to the
// browser and stays there.
//
// **What's stored is ids, not posts.** A snapshot of each post would render
// instantly and would then be wrong in every way a post can change: an edited
// title, a vote count, a post its author has since deleted. Ids cost a request
// each when the shelf is opened — ten of them, a page at a time, which is what
// the feed already does — and in exchange the shelf is never showing something
// that isn't there any more. Anything that has gone is dropped from the list
// as it's discovered, so the wrong entry corrects itself by being opened.

import { api } from "./api.js";
import { get, subscribe } from "./store.js";

export const SHELF_KEY = "commons.shelf";
// Whose shelf the mirror holds, or absent when it is this browser's own.
// It is what lets sign-out tell "an account's saves, which should go" from
// "saves made before there was an account, which should not".
export const OWNER_KEY = "commons.shelf.owner";

// A shelf is a reading list, not an archive. Two hundred is far past anything
// anyone will put on one and still a bounded value in storage; the oldest save
// falls off the end, which is the one you are least likely to be looking for.
const SHELF_LIMIT = 200;

/**
 * One saved post: its id, and when it was put there. The order is by `at`,
 * newest first, so the shelf reads as a stack rather than as a set.
 * @typedef {{ id: number, at: number }} ShelfEntry
 */

/** @returns {ShelfEntry[]} */
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHELF_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) => ({ id: Number(e && e.id), at: Number(e && e.at) || 0 }))
      .filter((e) => Number.isInteger(e.id));
  } catch (e) {
    return [];
  }
}

/** @type {ShelfEntry[]} */
let entries = load();

function persist() {
  if (entries.length > SHELF_LIMIT) entries = entries.slice(0, SHELF_LIMIT);
  try {
    localStorage.setItem(SHELF_KEY, JSON.stringify(entries));
  } catch (e) {
    /* storage disabled — the shelf is then this tab only, and empty on the
       next one. Nothing else breaks. */
  }
  // The header shows a way in only while there is something to go to, and the
  // save control on a post has to agree with it. One event, so neither has to
  // poll and neither can be repainted out of step with the other.
  dispatchEvent(new CustomEvent("commons:shelf", { detail: entries.length }));
}

/** @param {number | string} id */
export function isShelved(id) {
  const n = Number(id);
  return entries.some((e) => e.id === n);
}

export function shelfCount() {
  return entries.length;
}

/** Ids, newest save first. */
export function shelfIds() {
  return entries.map((e) => e.id);
}

/**
 * Put a post on the shelf, or take it off.
 * @param {number | string} id
 * @returns {boolean} whether it is on the shelf now
 */
export function toggleShelf(id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return false;

  const before = entries;
  let now;
  if (isShelved(n)) {
    entries = entries.filter((e) => e.id !== n);
    now = false;
  } else {
    // Newest first. Saving something already saved is handled above, so there
    // is no case where this can push a duplicate.
    entries = [{ id: n, at: Date.now() }, ...entries];
    now = true;
  }
  persist();

  // Optimistic, and synchronous on purpose: the caller is a toggle next to a
  // card and it repaints from the value this returns. The request follows.
  //
  // Signed out there is nothing to send — the browser's shelf *is* the shelf,
  // and the merge on the next sign-in is what carries it up.
  if (get("session")) {
    const send = now ? api.put(`/posts/${n}/save`, null) : api.del(`/posts/${n}/save`);
    send.catch(() => {
      // Put the pixel back. Restoring the whole list rather than undoing the
      // one entry, because `at` is what orders the shelf and re-adding a save
      // would move it to the top — a failed save that silently reordered the
      // list would be worse than the failure.
      //
      // 401 is not special-cased: the session has already been cleared by the
      // time this lands, the sign-out path clears an account's mirror anyway,
      // and rolling back on top of that is harmless.
      entries = before;
      persist();
    });
  }

  return now;
}

/**
 * Take everything off the shelf.
 *
 * **The one control on the data panel that is not purely local, and the
 * reason the panel could not be a loop over localStorage.** Since the shelf
 * grew an account half, clearing the mirror alone would last exactly until
 * the next boot: syncShelf() pushes the local list up and pulls the account's
 * down, so every post would come straight back and the control would read as
 * broken. Signed in, emptying the shelf has to mean emptying the account's.
 *
 * Local first and synchronously, because the caller repaints from it and the
 * count in the header should drop on the press rather than after a round
 * trip — the same optimism toggleShelf is built on.
 *
 * The rollback is what is left, not what there was. `allSettled` rather than
 * `all`, so one refused delete does not abandon the rest half-done: whatever
 * the server still holds is exactly the set whose request failed, so putting
 * that back leaves the mirror agreeing with the account instead of guessing.
 * The original entries are reused rather than rebuilt, which keeps `at` — the
 * save order — intact for the ones that survived.
 *
 * @returns {Promise<boolean>} whether the shelf is now empty everywhere
 */
export async function emptyShelf() {
  const before = entries;
  if (!before.length) return true;

  entries = [];
  persist();

  if (!get("session")) return true;

  const results = await Promise.allSettled(
    before.map((e) => api.del(`/posts/${e.id}/save`))
  );
  const left = before.filter((_, i) => results[i].status === "rejected");
  if (!left.length) return true;

  entries = left;
  persist();
  return false;
}

/**
 * Take an id off without it being a choice the reader made — a post that has
 * been deleted, or one that was a draft and is no longer visible.
 * @param {number | string} id
 */
export function dropFromShelf(id) {
  const n = Number(id);
  if (!isShelved(n)) return false;
  entries = entries.filter((e) => e.id !== n);
  persist();
  return true;
}

// — the account's copy --------------------------------------------------------

/** @returns {number | null} */
function owner() {
  try {
    const raw = localStorage.getItem(OWNER_KEY);
    return raw ? Number(raw) || null : null;
  } catch (e) {
    return null;
  }
}

/** @param {number | null} id */
function setOwner(id) {
  try {
    if (id == null) localStorage.removeItem(OWNER_KEY);
    else localStorage.setItem(OWNER_KEY, String(id));
  } catch (e) {
    /* storage disabled — the merge just runs again next time, which is free */
  }
}

/** Replace the mirror wholesale. Used only by a sync. */
function replaceAll(ids) {
  const now = Date.now();
  // The server hands them back in shelf order, newest save first, so position
  // is the only ordering information there is — the save timestamps live in
  // the `saves` table and are not in `PostPage`. Descending fake stamps keep
  // that order through the local sort without inventing a history.
  entries = ids.map((id, i) => ({ id: Number(id), at: now - i }));
  persist();
}

/**
 * Bring this browser and the account into agreement.
 *
 * Pushes first, then pulls, and the order is the whole of it: pulling first
 * would make the account's shelf authoritative and quietly drop anything saved
 * before signing in. Pushing first means the merge is a union, which is the
 * only version of this a reader would call correct.
 *
 * Failures are survivable by design. If the push fails the local save stays
 * local and the next sign-in tries again; if the pull fails the mirror is left
 * exactly as it was. There is no state in which this function loses a save.
 */
export async function syncShelf() {
  const session = get("session");
  if (!session) return;

  const local = shelfIds();

  // Every request here is `background`, and that flag is doing real work.
  //
  // Nobody asked for this. It runs at boot and on sign-in, beside whatever the
  // reader actually came for — so on a boot with a dead refresh cookie it races
  // the feed, and without this a 401 on the sync would throw a visitor who
  // should have landed on a readable signed-out feed onto the sign-in screen
  // instead. By a request they did not make, about a session they were not
  // using. `background` is what stops api.js reporting it to the app at all,
  // and it is the same reason the notification poller sets it.
  const quietly = { background: true };

  try {
    // Idempotent, so this is safe to run on every sign-in — a post already on
    // the account's shelf answers 204 and changes nothing.
    await Promise.all(
      local.map((id) => api.put(`/posts/${id}/save`, null, quietly).catch(() => null))
    );

    /** @type {number[]} */
    const ids = [];
    // A shelf is a reading list; SHELF_LIMIT pages of it is far past anything
    // anyone will have, and stopping is better than looping on a server that
    // keeps saying has_next.
    for (let page = 1; page <= Math.ceil(SHELF_LIMIT / 100); page++) {
      const res = await api.get(`/shelf?page=${page}&page_size=100`, quietly);
      for (const post of res.items || []) ids.push(post.id);
      if (!res.has_next) break;
    }

    replaceAll(ids);
    setOwner(session.id);
  } catch (e) {
    // Offline, or the server said no. The mirror is untouched and still usable;
    // the next sign-in, or the next reload while signed in, tries again.
  }
}

/**
 * Forget an account's shelf when its session ends.
 *
 * Only an account's. A shelf built before anybody signed in is this browser's
 * and signing out of somebody else's account is no reason to empty it.
 */
export function forgetAccountShelf() {
  if (owner() == null) return;
  setOwner(null);
  entries = [];
  persist();
}

// The seam, wired once. `subscribe` fires on every change to the session, so
// this has to be able to tell the three cases apart: signed in and not synced
// (merge), signed out with an account's mirror (forget), and everything else
// (do nothing, including every unrelated store update).
let syncedFor = null;
subscribe(() => {
  const session = get("session");
  if (session) {
    if (syncedFor !== session.id) {
      syncedFor = session.id;
      void syncShelf();
    }
    return;
  }
  syncedFor = null;
  forgetAccountShelf();
});

// A reload keeps the identity in localStorage but fires no store change, so
// the subscription above never runs for a returning reader. This is what keeps
// a shelf saved on a phone showing up on a laptop.
const returning = get("session");
if (returning) {
  syncedFor = returning.id;
  void syncShelf();
}
