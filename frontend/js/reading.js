// @ts-check
// What you've read, and when you were last here.
//
// This is the first thing in the app that is about the *reader* rather than
// about the posts, and it is deliberately the smallest possible version of
// that: two keys in localStorage, read at boot, sent nowhere. There is no
// endpoint behind it, no column in the database and nothing for the demo
// adapter to implement — which is also why it works identically on the
// published site and against a real backend.
//
// Keeping it here is a decision, not a shortcut. A record of what somebody has
// read is the most revealing thing a reading app could hold; the honest place
// for it is the machine doing the reading, and saying so out loud is worth
// more than the sync it gives up.
//
// It is keyed to the **browser, not the account**. The obvious alternative — a
// read set per user id — loses your history at the moment it matters most: you
// read half the feed signed out, sign in, and everything you just read is
// unread again. What a read mark says is "this browser opened post 7", which
// is neither a secret nor a credential, so there is nothing here that needs an
// account to protect it. The cost is a shared machine, where the next person
// sees a feed already half-dimmed — a small and reversible wrong, against
// losing the feature for every reader who signs in halfway through.

const READ_KEY = "commons.read";
const VISIT_KEY = "commons.visit";

// Enough to cover any plausible amount of reading and still be a bounded value
// in storage. Trimmed from the front, so what falls off is what you read
// longest ago — which is also what the feed is least likely to show you again.
const READ_LIMIT = 500;

// Average adult silent reading speed for general prose is usually put between
// 200 and 250 words a minute. 220 is the middle of that. The number is named
// here rather than written inline so there is one place where it was decided.
const WORDS_PER_MINUTE = 220;

// How long a post stays open before it counts as read. See markReadOnceSeen.
const SETTLE_MS = 2000;

const DAY_MS = 86400000;

// — what you've read ---------------------------------------------------------

/** @returns {number[]} */
function loadRead() {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((n) => Number.isInteger(n)) : [];
  } catch (e) {
    return [];
  }
}

// A Set keeps insertion order, which is what makes the trim above meaningful.
const readIds = new Set(loadRead());

function persistRead() {
  try {
    if (readIds.size > READ_LIMIT) {
      const keep = [...readIds].slice(-READ_LIMIT);
      readIds.clear();
      keep.forEach((id) => readIds.add(id));
    }
    localStorage.setItem(READ_KEY, JSON.stringify([...readIds]));
  } catch (e) {
    /* storage disabled — nothing is remembered, and nothing else breaks */
  }
}

/** @param {number | string} id */
export function hasRead(id) {
  return readIds.has(Number(id));
}

/**
 * @param {number | string} id
 * @returns {boolean} whether this was news
 */
export function markRead(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || readIds.has(n)) return false;
  readIds.add(n);
  persistRead();
  return true;
}

/**
 * Mark a post read once the reader has actually had it open — two seconds of
 * it being on screen and looked at.
 *
 * Marking on open would be wrong for the commonest mistake in any feed:
 * tapping the wrong card and going straight back. That reader would return to
 * a list with a card already dimmed that they never read, and no way to put it
 * back. Two seconds is longer than a mis-tap and shorter than anybody notices.
 *
 * **Two seconds and nothing else.** The first version of this also took the
 * first scroll as proof, on the reasoning that a scroll is engagement and
 * needs no waiting. It isn't, quite: a `scroll` listener on `window` hears
 * every scroll in the document, including the ones the machinery causes on its
 * way out — restoring a position, bringing a link into view before it is
 * clicked — and those arrive *before* the `hashchange` that would have told
 * this that the reader had left. So leaving a post could mark it read, which
 * is precisely the case the delay exists to prevent. One rule, no listener, no
 * ordering to get wrong.
 *
 * The clock only runs while the tab is visible, which is what makes
 * middle-clicking a card honest: a post opened into a background tab is not a
 * post anybody has read, and it stays unread until it is looked at.
 *
 * `isStale` is the router's, so a reader who leaves first takes the decision
 * with them.
 *
 * @param {number | string} id
 * @param {() => boolean} isStale
 */
export function markReadOnceSeen(id, isStale) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const done = () => {
    stop();
    if (!isStale()) markRead(id);
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    removeEventListener("visibilitychange", sync);
  };

  // Hidden and shown again starts the two seconds over rather than resuming
  // them. Keeping a running total would be the more precise answer to a
  // question nobody asks; what this has to get right is that a post glanced at
  // for a moment, buried, and dug up an hour later is read when it is read.
  function sync() {
    if (document.visibilityState === "visible") {
      if (!timer) timer = setTimeout(done, SETTLE_MS);
    } else if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  addEventListener("visibilitychange", sync);
  sync();
}

// — when you were last here ---------------------------------------------------
//
// Two numbers under one key, and the difference between them is the whole of
// this section:
//
//   seen   when the app was last open. Written at boot and again every time
//          the page is hidden or goes away, so it tracks the reader rather
//          than the page load.
//   since  the moment the feed is counting *from*. It is what the reader is
//          shown, and it holds still for as long as they are here.
//
// The naive version of this — one timestamp, overwritten at boot — was wrong
// in a way that only shows up when you use it. Reloading the page writes "you
// were last here a moment ago" *before* the new document reads it, so a
// refresh silently threw away the "four new posts" line before the reader had
// done anything about it. F5 is not leaving.
//
// So a return only counts as a return after a gap. Under thirty minutes this
// is the same visit continuing — a reload, a tab switch, a phone put down and
// picked up — and `since` is carried across unchanged. Past it, the reader has
// genuinely been away, and where they got to becomes the new mark. Thirty
// minutes is the conventional session window and is a judgement, not a
// measurement; what matters is that it is longer than a refresh and shorter
// than a lunch.

const SESSION_GAP_MS = 30 * 60 * 1000;

/** @returns {{ seen: number, since: number | null } | null} */
function loadVisit() {
  try {
    const raw = JSON.parse(localStorage.getItem(VISIT_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const seen = Number(raw.seen);
    if (!Number.isFinite(seen) || seen <= 0) return null;
    const since = Number(raw.since);
    return { seen, since: Number.isFinite(since) && since > 0 ? since : null };
  } catch (e) {
    return null;
  }
}

// Resolved once, at boot, and held for the life of the page.
/** @type {number | null} */
const previousVisit = (() => {
  const stored = loadVisit();
  if (!stored) return null; // nobody has been here before
  if (Date.now() - stored.seen > SESSION_GAP_MS) return stored.seen;
  return stored.since;
})();

function stampVisit() {
  try {
    // `since` is written back as it stands, which is what carries it across a
    // reload. There is no separate code path for that — the value the page was
    // using is simply the value it saves.
    localStorage.setItem(
      VISIT_KEY,
      JSON.stringify({ seen: Date.now(), since: previousVisit })
    );
  } catch (e) {
    /* storage disabled — every visit is then a first visit, which is the right
       degradation: the app says nothing rather than saying something wrong */
  }
}

// At boot, so a crash, a force-quit or a closed lid still leaves a mark; and
// on the way out, which is the accurate one — "when you were last here" means
// when you left.
stampVisit();
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") stampVisit();
});
// Safari on iOS does not reliably fire the one above when an app is swiped
// away; pagehide is the one that survives it.
addEventListener("pagehide", stampVisit);

/** ms epoch, or null on a first visit — in which case nothing is "new". */
export function lastVisit() {
  return previousVisit;
}

/**
 * Was this written since the reader was last here?
 *
 * Time only, deliberately — not "time, *and* you haven't opened it". A post
 * read in an earlier session is older than that session's stamp anyway, and
 * mixing the two rules would stop the boundary the feed draws from being a
 * straight line through time, which is the one thing it has to be.
 *
 * @param {{ created_at?: string } | null | undefined} post
 */
export function isNewSince(post) {
  if (previousVisit === null) return false;
  const at = Date.parse((post && post.created_at) || "");
  return Number.isFinite(at) && at > previousVisit;
}

// — how long it takes to read --------------------------------------------------

/** @param {string | null | undefined} text */
export function readingMinutes(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  // Never zero: a one-line post still costs you the tap and the look.
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

// — saying it in words ---------------------------------------------------------

// Spelled out below eleven, which is the ordinary typographic convention for
// running prose and the reason this line reads as a sentence rather than as a
// notification count.
const NUMBER_WORDS = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
];

/** @param {number} n */
export function spellCount(n) {
  return NUMBER_WORDS[n] || String(n);
}

/** @param {number} ms */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "…since **yesterday**", "…since **Tuesday**", "…since **3 March**".
 *
 * Calendar days, not 24-hour blocks: at nine on Tuesday morning, a visit at ten
 * the previous evening is eleven hours ago and is still yesterday. Rounding the
 * difference between two midnights also absorbs the 23- and 25-hour days that
 * daylight saving produces twice a year.
 *
 * @param {number} ms
 */
export function sinceLabel(ms) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return "you were last here";
  if (days === 1) return "yesterday";
  if (days < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
  return new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric" });
}
