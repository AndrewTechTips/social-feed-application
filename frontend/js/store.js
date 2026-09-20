// @ts-check
// A tiny reactive store: get / set / subscribe. No dependencies, no magic.
// It holds two things — the session, and a small cache of the last feed render
// so going back to the feed from a post feels instant.

// What's in storage is who you are. What lets you in is not.
//
// The split is the whole of the refresh-token change on this side. An access
// token lives in `state.access` — a variable, gone on reload, readable by
// nothing that isn't already running in this page's world. The thing that
// survives a reload is an httpOnly cookie the browser holds and this code
// cannot read, cannot copy, and cannot accidentally log.
//
// `commons.identity` holds { id, username }: the two things the app needs to
// draw the right header and work out which posts are yours, both of which are
// public and neither of which gets anybody in. On boot it is believed
// optimistically — the header paints signed-in straight away — and the first
// request that needs a token trades the cookie for one. If that fails, the
// identity is dropped and the app settles into signed-out.
export const IDENTITY_KEY = "commons.identity";
// The CSRF token that goes with the refresh cookie. It is in storage rather
// than in memory for a reason that only shows up on a reload: the cookie
// survives one and everything in memory doesn't, so a client with nowhere to
// keep this would be holding a live session it could never refresh.
//
// Storing it gives nothing away. It is not a credential — presented without
// the cookie it opens nothing — and its only job is to prove that whoever sent
// a request to /auth could read one of our responses, which a page on another
// origin cannot do and cannot read this to fake. The thing that *is* a
// credential is in a cookie this code cannot see.
export const CSRF_KEY = "commons.csrf";
export const LEGACY_SESSION_KEY = "commons.session";
// The API had no "did I vote on this" flag, so this held a set of post ids and
// the app guessed from it. PostOut carries `voted` now, so the guess is gone —
// and so is the key, actively rather than by being left alone. A guess about
// somebody's voting left in their browser is still a record of it.
export const LEGACY_VOTES_KEY = "commons.votes";

/** @returns {import("./types.js").Session | null} */
function loadIdentity() {
  try {
    // The old key held a bearer token. Not simply ignored — removed. Leaving a
    // credential in storage after deciding credentials don't belong there
    // would be the change in name only, and it's the browsers of people who
    // used the app *before* this landed that would keep it.
    localStorage.removeItem(LEGACY_SESSION_KEY);
    localStorage.removeItem(LEGACY_VOTES_KEY);

    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.username && s.id ? { id: s.id, username: s.username } : null;
  } catch (e) {
    return null;
  }
}

/**
 * Everything the app holds, in one object. The shape is in js/types.js rather
 * than in a comment now, which is the difference between documentation and
 * something a checker can hold you to.
 * @type {import("./types.js").State}
 */
const state = {
  session: loadIdentity(),
  // The credential half: an access token, the CSRF token that goes with the
  // refresh cookie, and when the token stops being worth sending. Never
  // written to storage, never persisted, gone on reload — see the note above.
  access: null,
  listCache: [],
  knownPosts: [], // the list last drawn — see setKnownPosts
  knownFrom: null,
};

/** @type {Set<(state: import("./types.js").State) => void>} */
const subs = new Set();

/**
 * @template {keyof import("./types.js").State} K
 * @param {K} key
 * @returns {import("./types.js").State[K]}
 */
export function get(key) {
  return state[key];
}

/** @param {Partial<import("./types.js").State>} patch */
export function set(patch) {
  Object.assign(state, patch);
  subs.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// — session helpers ---------------------------------------------------------
/** @param {import("./types.js").Session | null} session */
export function setSession(session) {
  try {
    if (session) localStorage.setItem(IDENTITY_KEY, JSON.stringify(session));
    else localStorage.removeItem(IDENTITY_KEY);
  } catch (e) {
    /* storage disabled — the app still works, it just won't remember you */
  }
  set({ session });
}

export function clearSession() {
  clearAccess();
  // The list the palette searches and the post screen reads on from is
  // whichever one was drawn last, and a list drawn for a signed-in reader can
  // hold that reader's own drafts. The feed comes back without them a moment
  // later, but "a moment later" is long enough to open the palette in — so the
  // list goes when the session does, the same way the vote mirror does.
  setKnownPosts([]);
  setSession(null);
}

// — the credential half -------------------------------------------------------
// Deliberately not routed through set()/subscribe(). Getting a new access
// token is not a change anybody on screen should notice: repainting the header
// every fifteen minutes because a token rotated would be the app telling the
// reader about its own plumbing.

/**
 * @param {{ access_token: string, csrf_token: string, expires_in?: number }} token
 */
export function setAccess(token) {
  try {
    localStorage.setItem(CSRF_KEY, token.csrf_token);
  } catch (e) {
    /* storage disabled — refreshing still works for as long as this page is
       open, which is as much as anything else survives without storage */
  }
  state.access = {
    token: token.access_token,
    csrf: token.csrf_token,
    // A minute early on purpose: a token that expires while the request
    // carrying it is in flight costs a round trip and a retry, and the clock
    // here is the browser's rather than the server's.
    expiresAt: Date.now() + Math.max(0, (token.expires_in || 900) - 60) * 1000,
  };
}

export function clearAccess() {
  state.access = null;
  try {
    localStorage.removeItem(CSRF_KEY);
  } catch (e) {
    /* nothing to clear */
  }
}

/** The token to send, or null if there isn't one worth sending. */
export function accessToken() {
  const a = state.access;
  if (!a) return null;
  return a.expiresAt > Date.now() ? a.token : null;
}

/** Proves a request to /auth came from code that could read one of our
 * responses. Falls back to storage, which is the case that matters: on the
 * first refresh after a reload there is nothing in memory yet. */
export function csrfToken() {
  if (state.access) return state.access.csrf;
  try {
    return localStorage.getItem(CSRF_KEY);
  } catch (e) {
    return null;
  }
}

// Ownership is decided by id, which is the one thing about a person that
// doesn't change. This used to compare email addresses, which only worked
// because posts carried their author's address — the reason it can't any more
// is the whole point of the change.
/** @param {import("./types.js").Post | null | undefined} post */
export function isMine(post) {
  const s = state.session;
  return !!(s && post && post.user && post.user.id === s.id);
}

// — a vote, remembered on the copies of a post in hand ------------------------
//
// What this replaces: a set of post ids in localStorage, kept because the API
// could not say whether you had voted. It can now, so the answer arrives with
// the post — but a post arrives more than once. The feed fetches one copy, the
// post screen fetches another, and voting on the second used to leave the
// first saying something different when the cache put it back on screen.
//
// So a vote is written onto every copy this session is holding. It patches
// real data rather than keeping a parallel record of it, which is the
// difference between this and the thing it replaces.
/**
 * @param {number | string} id
 * @param {number} votes
 * @param {boolean} voted
 */
export function notePostVote(id, votes, voted) {
  /** @param {import("./types.js").Post} p */
  const patch = (p) => {
    if (p && String(p.id) === String(id)) {
      p.votes = votes;
      p.voted = voted;
    }
  };
  state.knownPosts.forEach(patch);
  // The same objects, usually — both are built from the feed's `items` — but
  // not always, and patching twice costs nothing.
  state.listCache.forEach((c) => c.items.forEach(patch));
}

// — feed cache ----------------------------------------------------------------
// Nothing renders off this, so it doesn't go through set()/subscribe — writing
// it shouldn't repaint the header.
const CACHE_TTL = 60000;

// The feed isn't the same page for everyone — you see your own drafts, nobody
// else does — so a snapshot taken while signed in must never be replayed to a
// signed-out visitor.
//
// The snapshot carries the viewer it was *fetched* for, which the caller
// supplies; reading it back compares against whoever is here now. Note that
// dropFeedCache() alone does not cover this, and neither would stamping the
// viewer at write time: leaving a feed caches it during teardown, and
// renderFeed tears the outgoing instance down *after* sign-out has cleared
// both the session and the cache — so the stale list would be written back
// already wearing the new viewer's name, one line before it's read.
export function viewerKey() {
  return state.session ? state.session.id : null;
}

// How many lists are held at once.
//
// It used to be one, and one was wrong the moment the profile learned to
// restore its own scroll: the feed, a profile and a set of search results are
// all the same kind of screen, and going feed → profile → back would have had
// the profile evict the feed on its way past. Four covers the journeys somebody
// actually makes — the feed under two orderings, a profile, and the search they
// came from — and is small enough that the oldest falling off is a reload of
// something they have stopped looking at.
const CACHE_SLOTS = 4;

/** @param {Omit<import("./types.js").FeedCache, "at">} snapshot */
export function cacheFeed(snapshot) {
  const fresh = { ...snapshot, at: Date.now() };
  state.listCache = [
    fresh,
    ...state.listCache.filter((c) => c.key !== fresh.key),
  ].slice(0, CACHE_SLOTS);
}

/**
 * @param {string} key
 * @returns {import("./types.js").FeedCache | null}
 */
export function readFeedCache(key) {
  const c = state.listCache.find((entry) => entry.key === key);
  if (!c || c.viewer !== viewerKey()) return null;
  if (Date.now() - (c.at ?? 0) >= CACHE_TTL) return null;
  return c;
}

export function dropFeedCache() {
  state.listCache = [];
}

// — the list you were last looking at ------------------------------------------
// The posts on screen, so the command palette can filter them without going
// near the network — and, since the post screen learned to offer what's next,
// so a reader can carry on down the list they arrived from. Like the feed cache
// this is read, never rendered from, so it doesn't go through set()/subscribe.
//
// It outlives the screen that set it on purpose: that is what lets the post
// screen know there was a list at all, and what lets two onward steps in a row
// keep working.
/**
 * @param {import("./types.js").Post[]} posts
 * @param {string} [from] the list, named as a place — "the feed", "these
 *   results", a username. The post screen draws it; the palette ignores it.
 */
export function setKnownPosts(posts, from) {
  state.knownPosts = posts.slice();
  state.knownFrom = from || null;
}

export function knownPosts() {
  return state.knownPosts || [];
}

export function knownFrom() {
  return state.knownFrom || null;
}
