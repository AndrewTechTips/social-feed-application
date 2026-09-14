// @ts-check
// A tiny reactive store: get / set / subscribe. No dependencies, no magic.
// It holds two things — the session, and a small cache of the last feed render
// so going back to the feed from a post feels instant.

const SESSION_KEY = "commons.session";
const VOTES_KEY = "commons.votes";

// The token sits in localStorage. That's readable by any script that runs on
// this origin, so an XSS bug would leak it — the accepted tradeoff here: there's
// no refresh-token flow yet, and the alternative (an httpOnly cookie) needs
// backend work that's out of scope. Revisit if refresh tokens land.
// A session is { token, id, username } — who you are, not just what lets you
// in. The id is the durable half (a username could in principle be changed);
// the username is what's shown.
//
// Sessions saved before usernames existed carried an email instead. They're
// discarded rather than migrated: the token in them is still good, but nothing
// can work out whose posts are whose from an email any more, and a session that
// can't answer that is worse than no session.
/** @returns {import("./types.js").Session | null} */
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.token && s.username && s.id ? s : null;
  } catch (e) {
    return null;
  }
}

/** @returns {Set<number>} */
function loadVotes() {
  try {
    return new Set(JSON.parse(localStorage.getItem(VOTES_KEY) || "[]"));
  } catch (e) {
    return new Set();
  }
}

/**
 * Everything the app holds, in one object. The shape is in js/types.js rather
 * than in a comment now, which is the difference between documentation and
 * something a checker can hold you to.
 * @type {import("./types.js").State}
 */
const state = {
  session: loadSession(),
  feedCache: null,
  knownPosts: [], // what's on screen now, for the command palette to search
  voted: loadVotes(), // post ids this browser has upvoted (best-effort mirror)
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
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch (e) {
    /* storage disabled — session just won't persist across reloads */
  }
  set({ session });
}

export function clearSession() {
  setSession(null);
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

// — vote mirror -----------------------------------------------------------------
// The API has no "did I vote on this" flag, so we keep a local best-effort set.
// If it ever disagrees with the server the vote call returns 409/404 and the
// caller just settles into the real state.
export function hasVoted(id) {
  return state.voted.has(id);
}

export function clearVotes() {
  state.voted = new Set();
  try {
    localStorage.removeItem(VOTES_KEY);
  } catch (e) {
    /* nothing to clear */
  }
}

export function setVoted(id, on) {
  if (on) state.voted.add(id);
  else state.voted.delete(id);
  try {
    localStorage.setItem(VOTES_KEY, JSON.stringify([...state.voted]));
  } catch (e) {
    /* not persisted — fine */
  }
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

/** @param {Omit<import("./types.js").FeedCache, "at">} snapshot */
export function cacheFeed(snapshot) {
  state.feedCache = { ...snapshot, at: Date.now() };
}

/**
 * @param {string} key
 * @returns {import("./types.js").FeedCache | null}
 */
export function readFeedCache(key) {
  const c = state.feedCache;
  if (!c || c.key !== key || c.viewer !== viewerKey()) return null;
  if (Date.now() - (c.at ?? 0) >= CACHE_TTL) return null;
  return c;
}

export function dropFeedCache() {
  state.feedCache = null;
}

// — what the palette can search -----------------------------------------------
// The posts currently on screen, so the command palette can filter them without
// going near the network. Like the feed cache this is read, never rendered
// from, so it doesn't go through set()/subscribe.
/** @param {import("./types.js").Post[]} posts */
export function setKnownPosts(posts) {
  state.knownPosts = posts.slice();
}

export function knownPosts() {
  return state.knownPosts || [];
}
