// @ts-check
// The post you were part-way through writing.
//
// The app's worst remaining papercut was that a half-written post lived nowhere
// but the textarea: a mistyped hash, a tapped link, a phone deciding to reclaim
// the tab, and it was gone with no way to ask for it back. The composer now
// keeps a copy as you type.
//
// ── what this is not ───────────────────────────────────────────────────────
// It is not the draft the *API* means. A post with `published: false` is a
// draft on the server, belongs to your account, and follows you to another
// device. This is a scrap of local state, in this browser, for something that
// has never been sent anywhere — the same kind of thing as the shelf and the
// read marks, and kept the same way and in the same place.
//
// Only one, and only for a new post. Editing an existing one already has
// somewhere to put the words — the post — and a second slot keyed by id would
// be a cache of half-finished edits nobody asked to keep.
//
// It is stamped with who wrote it, for the reason the feed cache is: two people
// sharing a browser must not be handed each other's unfinished sentences.

const KEY = "commons.draft";

/**
 * @typedef {object} Draft
 * @property {number | null} who   the id of whoever typed it
 * @property {string} title
 * @property {string} content
 * @property {boolean} published
 * @property {number} at           ms epoch of the last keystroke saved
 */

/** @returns {Draft | null} */
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    return {
      who: typeof value.who === "number" ? value.who : null,
      title: String(value.title || ""),
      content: String(value.content || ""),
      published: value.published !== false,
      at: Number(value.at) || 0,
    };
  } catch (e) {
    // Disabled storage, a private window, or something else's key collided
    // with ours. A draft that can't be read is a draft there isn't.
    return null;
  }
}

/**
 * The draft belonging to this reader, if there is one worth offering.
 *
 * "Worth offering" is the part that matters: a blank draft is not a draft, and
 * restoring one would put "Picked up where you left off" above an empty form,
 * which is the app claiming to have saved something it didn't.
 *
 * @param {number | null} who
 * @returns {Draft | null}
 */
export function readDraft(who) {
  const draft = read();
  if (!draft) return null;
  if (draft.who !== who) return null;
  if (!draft.title.trim() && !draft.content.trim()) return null;
  return draft;
}

/**
 * @param {number | null} who
 * @param {{ title: string, content: string, published: boolean }} fields
 */
export function saveDraft(who, fields) {
  // Nothing in it: clear rather than store a blank. Otherwise deleting what you
  // wrote would leave a draft behind that the next visit offers to restore.
  if (!fields.title.trim() && !fields.content.trim()) return clearDraft();
  try {
    localStorage.setItem(KEY, JSON.stringify({ who, ...fields, at: Date.now() }));
  } catch (e) {
    /* storage disabled, or full — the composer still works, it just forgets */
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    /* nothing to do, and nothing worth saying about it */
  }
}
