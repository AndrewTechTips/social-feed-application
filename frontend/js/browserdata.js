// @ts-check
// What this browser knows about you.
//
// ── why this is a screen at all ────────────────────────────────────────────
// `reading.js` carries an unusually careful comment about why a record of what
// somebody has read belongs on the machine doing the reading and is sent
// nowhere. That reasoning has been true since the day it was written and has
// never been visible to anybody who did not read the source. This is the file
// that puts it on screen: every key the app keeps, in plain English, with its
// size and a control that removes it.
//
// It is a privacy feature that is honest rather than performative. Nothing
// here is a promise about a server — it is a list of what is on your own disk,
// and a button for each line.
//
// ── why it is not a loop over localStorage ─────────────────────────────────
// Two reasons, and both of them are the interesting part.
//
// **The shelf is no longer only local.** Since it grew an account half,
// clearing the mirror would last until the next boot and then syncShelf()
// would put it all back — so "Empty the shelf" signed in has to mean the
// account's shelf. That control is asynchronous and can fail, and the row has
// to be able to say so. A loop over storage cannot.
//
// **Not every key is the reader's.** The demo adapter keeps the entire
// contents of the published site under `commons.demo.v1`. It is in this
// browser's storage and it is emphatically not "what this browser knows about
// you" — wiping it would delete every post on the demo and leave somebody
// looking at an empty app they had no way to refill. It is exempt, by name,
// with the reason next to it.
//
// ── one string per key ─────────────────────────────────────────────────────
// Every key below is imported from the module that owns it rather than typed
// again here. A second copy of `"commons.read"` is a second thing to keep in
// step, and the way that failure shows up is a panel that promises to forget
// something and quietly forgets nothing. `browserdata.spec.js` holds the line
// from the other side: it greps the source for `commons.*` and fails on any
// key that is neither listed here nor exempt by name.

import { THEME_KEY, forgetTheme } from "./actions.js";
import {
  READ_KEY,
  VISIT_KEY,
  SIZE_KEY,
  MEASURE_KEY,
  readCount,
  forgetRead,
  forgetReadingPrefs,
} from "./reading.js";
import { SHELF_KEY, OWNER_KEY, shelfCount, emptyShelf } from "./shelf.js";
import { DRAFT_KEY, readDraft, clearDraft } from "./draft.js";
import {
  IDENTITY_KEY,
  CSRF_KEY,
  LEGACY_SESSION_KEY,
  LEGACY_VOTES_KEY,
  get,
} from "./store.js";

/**
 * Keys this panel deliberately does not offer, and why. Named rather than
 * silently skipped, because the spec reads this list — an exemption somebody
 * has to write down is an exemption somebody has to justify.
 */
export const EXEMPT = {
  "commons.demo.v1":
    "the demo adapter's whole database — every post on the published site. " +
    "Not the reader's data, and clearing it would empty the app.",
  "commons.demo.strip-folded":
    "whether the demo notice is folded up. A scrap of furniture, not a record " +
    "of anybody.",
  "commons.share":
    "sessionStorage, not localStorage — one tab, consumed on arrival, gone " +
    "when the tab closes. There is nothing here to keep.",
};

/**
 * Leftovers from versions of the app that no longer run.
 *
 * Exported because the row that clears them only exists when they are present,
 * and browserdata.spec.js checks the panel accounts for every key in the
 * source — a conditional row is invisible to that check on a fresh browser,
 * which is exactly the browser the test runs in.
 */
export const LEGACY_KEYS = [LEGACY_SESSION_KEY, LEGACY_VOTES_KEY];

/**
 * How much room a key takes, in bytes as stored.
 *
 * `Blob` rather than `String.length`, which counts UTF-16 units — an em dash
 * in a draft is one unit and three bytes, and a panel claiming to report a
 * size should report the one that is true.
 *
 * @param {string} key
 * @returns {number} 0 when the key is absent, which is also "nothing here"
 */
export function sizeOf(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? 0 : new Blob([raw]).size;
  } catch (e) {
    // A private window, or storage switched off. Nothing is stored, so
    // nothing is the honest answer rather than an error the reader can act on.
    return 0;
  }
}

/** @param {string[]} keys */
const totalSize = (keys) => keys.reduce((n, key) => n + sizeOf(key), 0);

/** @param {string[]} keys */
const anyPresent = (keys) => keys.some((key) => sizeOf(key) > 0);

/**
 * Bytes, as a person would say them.
 *
 * Whole numbers under a kilobyte and one decimal above, because "1.4 KB" is
 * the size of a thing and "1434 bytes" is a measurement. Nothing here is ever
 * big enough to need a third unit.
 *
 * @param {number} bytes
 */
export function saySize(bytes) {
  // "0 bytes" rather than "nothing" for an absent key. The slot is a
  // measurement and reads down the list as a column of them; a word in it
  // turns one row into prose, and next to a line already saying "Nothing
  // saved" it says the same thing twice in two different registers.
  if (bytes <= 0) return "0 bytes";
  if (bytes < 1024) return `${bytes} bytes`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => (n === 1 ? one : many.replace("%", String(n)));

/**
 * @typedef {object} DataRow
 * @property {string} id            stable, for the test and for the DOM
 * @property {string} title         what it is
 * @property {string} what          how much of it there is, in plain English
 * @property {string} why           what it buys, and where it goes — which is nowhere
 * @property {string[]} keys        the storage keys behind it
 * @property {number} bytes
 * @property {string} [action]      the control's words; absent means no control
 * @property {() => unknown} [run]  what it does; may be async
 * @property {string} [done]        what to say once it has
 */

/**
 * Every row, recomputed on the spot.
 *
 * Built fresh on each call rather than held, because the panel repaints after
 * every control and the counts have to be the ones that are true now. There is
 * nothing expensive in here — a handful of reads off localStorage.
 *
 * @returns {DataRow[]}
 */
export function inventory() {
  const read = readCount();
  const visited = sizeOf(VISIT_KEY) > 0;
  const saved = shelfCount();
  const draft = readDraft(get("session")?.id ?? null);
  const session = get("session");

  /** @type {DataRow[]} */
  const rows = [
    {
      // Two keys and one idea, which is why the control is offered on either
      // of them rather than on the count. A browser that has been here and
      // opened nothing still holds `commons.visit` — the stamp the "new since
      // you were last here" line is drawn from — and the first version of
      // this row read "Nothing yet, 35 bytes" with no button under it. A
      // panel whose whole claim is that you can clear what it lists cannot
      // have a line you can't.
      id: "read",
      title: "What you've read",
      what: read
        ? count(read, "One post", "% posts")
        : visited
          ? "No posts — just when you were last here"
          : "Nothing yet",
      why:
        "Dims a card once you've opened it, and draws the line under what's " +
        "arrived since you were last here. It is a record of your reading and " +
        "it is sent nowhere — it has never left this browser.",
      keys: [READ_KEY, VISIT_KEY],
      bytes: totalSize([READ_KEY, VISIT_KEY]),
      action: read || visited ? "Forget what I've read" : undefined,
      run: forgetRead,
      done: "Forgotten. Nothing is marked as read here any more.",
    },
    {
      id: "shelf",
      title: "Your shelf",
      what: saved ? count(saved, "One post", "% posts") : "Empty",
      why: session
        ? "Posts you put aside to read again. This is the copy in this " +
          "browser; the same shelf is on your account, so emptying it here " +
          "empties it everywhere you're signed in."
        : "Posts you put aside to read again. Yours alone until you sign in, " +
          "at which point it joins your account rather than replacing it.",
      keys: [SHELF_KEY, OWNER_KEY],
      bytes: totalSize([SHELF_KEY, OWNER_KEY]),
      action: saved ? "Empty the shelf" : undefined,
      run: emptyShelf,
      done: "Your shelf is empty.",
    },
    {
      id: "draft",
      title: "A post you were writing",
      what: draft ? (draft.title.trim() || "Untitled").slice(0, 60) : "Nothing saved",
      why:
        "The composer keeps what you type, so a mistyped address or a tab " +
        "the phone decided to reclaim doesn't take it with it. It has never " +
        "been sent anywhere.",
      keys: [DRAFT_KEY],
      bytes: totalSize([DRAFT_KEY]),
      action: draft ? "Discard it" : undefined,
      run: clearDraft,
      done: "Discarded.",
    },
    {
      id: "appearance",
      title: "How you like to read",
      what: anyPresent([THEME_KEY, SIZE_KEY, MEASURE_KEY])
        ? "Theme, text size and line width"
        : "Nothing set — following your system",
      why:
        "Read before the first paint, which is why a post never arrives at " +
        "one size and resets to another. Resetting puts the theme back to " +
        "whatever your system is doing.",
      keys: [THEME_KEY, SIZE_KEY, MEASURE_KEY],
      bytes: totalSize([THEME_KEY, SIZE_KEY, MEASURE_KEY]),
      action: anyPresent([THEME_KEY, SIZE_KEY, MEASURE_KEY]) ? "Reset" : undefined,
      run: () => {
        forgetTheme();
        forgetReadingPrefs();
      },
      done: "Back to the defaults.",
    },
    {
      id: "signin",
      title: "Being signed in",
      what: session ? `Signed in as ${session.username}` : "Signed out",
      // No control, and the plan asked for it that way. Signing out already
      // has two doors — the account menu, and "Sign out everywhere" one
      // section up — and a third here would be a third place for the same
      // idea, in a list whose subject is storage rather than sessions. The
      // row stays because leaving it out would make the list a partial answer
      // to a question about privacy, which is the one kind of answer worth
      // less than none.
      why:
        "Who you are, and the token that proves a request came from this page " +
        "rather than from somewhere else. The password is not here and the " +
        "sign-in itself is a cookie this page cannot read. Sign out from the " +
        "menu, or from Signed in elsewhere above.",
      keys: [IDENTITY_KEY, CSRF_KEY],
      bytes: totalSize([IDENTITY_KEY, CSRF_KEY]),
    },
  ];

  // Only when there are any. A row reading "nothing from older versions" is a
  // line about the app's own history that no reader asked for — but leaving a
  // key unlisted would make the panel a partial answer, so it appears exactly
  // when there is something to appear for, and goes for good once cleared.
  if (anyPresent(LEGACY_KEYS)) {
    rows.push({
      id: "legacy",
      title: "Left over from an older version",
      what: "Data this version of Commons no longer uses",
      why:
        "Kept by a version of the app that has since been replaced. Nothing " +
        "reads it any more; it is only still here because nobody has swept it.",
      keys: LEGACY_KEYS,
      bytes: totalSize(LEGACY_KEYS),
      action: "Clear it",
      run: () => LEGACY_KEYS.forEach(remove),
      done: "Swept.",
    });
  }

  return rows;
}

/** @param {string} key */
function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    /* storage disabled — the key was never there to remove */
  }
}

/**
 * Is there anything here the sweep could actually remove?
 *
 * A question about rows rather than about bytes, and both halves of that were
 * bugs on screen before it was. Summing every row counted the sign-in, which
 * `forgetEverything` deliberately leaves alone — so a browser holding nothing
 * but an identity still offered "Forget everything on this browser", and
 * pressing it did nothing at all. Summing only the clearable rows was closer
 * and still wrong: an emptied shelf leaves `[]` behind, three honest bytes
 * that no control can remove and that kept the button alive after a sweep had
 * finished.
 *
 * A row's `action` is already the answer — it is set only when that row has
 * something to clear — so the button is offered exactly when pressing it
 * would do something.
 */
export const anythingToForget = () => inventory().some((row) => !!row.action);

/**
 * Forget the lot.
 *
 * **Except being signed in, and it says so on the button.** Two reasons, and
 * neither is squeamishness. The row above states that the sign-in is not
 * deletable here, and a control underneath it that quietly deleted it anyway
 * would make the table a lie. And a reader who pressed this would be thrown
 * out to the sign-in screen mid-action, by a button whose subject was their
 * own stored data rather than their session — the wrong ending for the right
 * intention.
 *
 * Built out of the rows rather than by clearing storage wholesale, so the
 * exemptions hold: `localStorage.clear()` would take the demo's entire
 * database with it and leave the published site empty.
 *
 * @returns {Promise<boolean>} false when the shelf could not be emptied on the
 *   server, which is the one part of this that can fail
 */
export async function forgetEverything() {
  let ok = true;
  for (const row of inventory()) {
    if (!row.run) continue;
    const result = await row.run();
    if (result === false) ok = false;
  }
  return ok;
}
