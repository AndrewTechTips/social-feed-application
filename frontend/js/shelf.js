// @ts-check
// The shelf: posts you meant to come back to.
//
// Sibling to js/reading.js, and deliberately built the same way — one key in
// localStorage, read at boot, sent nowhere. Same reasoning, too: what somebody
// has put aside to read is as revealing as what they have read, and this app
// has nowhere to put it that isn't a machine somebody else owns. The cost is
// the same and is said out loud in the same place: it doesn't follow you to
// another device.
//
// **What's stored is ids, not posts.** A snapshot of each post would render
// instantly and would then be wrong in every way a post can change: an edited
// title, a vote count, a post its author has since deleted. Ids cost a request
// each when the shelf is opened — ten of them, a page at a time, which is what
// the feed already does — and in exchange the shelf is never showing something
// that isn't there any more. Anything that has gone is dropped from the list
// as it's discovered, so the wrong entry corrects itself by being opened.

const SHELF_KEY = "commons.shelf";

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
  if (isShelved(n)) {
    entries = entries.filter((e) => e.id !== n);
    persist();
    return false;
  }
  // Newest first. Saving something already saved is handled above, so there is
  // no case where this can push a duplicate.
  entries = [{ id: n, at: Date.now() }, ...entries];
  persist();
  return true;
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
