// A tiny reactive store: get / set / subscribe. No dependencies, no magic.
// It holds two things — the session, and a small cache of the last feed render
// so going back to the feed from a post feels instant.

const SESSION_KEY = "commons.session";
const VOTES_KEY = "commons.votes";

// The token sits in localStorage. That's readable by any script that runs on
// this origin, so an XSS bug would leak it — the accepted tradeoff here: there's
// no refresh-token flow yet, and the alternative (an httpOnly cookie) needs
// backend work that's out of scope. Revisit if refresh tokens land.
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.token && s.email ? s : null;
  } catch (e) {
    return null;
  }
}

function loadVotes() {
  try {
    return new Set(JSON.parse(localStorage.getItem(VOTES_KEY) || "[]"));
  } catch (e) {
    return new Set();
  }
}

const state = {
  session: loadSession(),
  feedCache: null, // { key, items, page, total, pages, hasNext, scrollY, at }
  knownPosts: [], // what's on screen now, for the command palette to search
  voted: loadVotes(), // post ids this browser has upvoted (best-effort mirror)
};

const subs = new Set();

export function get(key) {
  return state[key];
}

export function set(patch) {
  Object.assign(state, patch);
  subs.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// — session helpers ---------------------------------------------------------
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

export function isMine(post) {
  const s = state.session;
  return !!(s && post && post.user && post.user.email === s.email);
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
  return state.session ? state.session.email : null;
}

export function cacheFeed(snapshot) {
  state.feedCache = { ...snapshot, at: Date.now() };
}

export function readFeedCache(key) {
  const c = state.feedCache;
  if (!c || c.key !== key || c.viewer !== viewerKey()) return null;
  if (Date.now() - c.at >= CACHE_TTL) return null;
  return c;
}

export function dropFeedCache() {
  state.feedCache = null;
}

// — what the palette can search -----------------------------------------------
// The posts currently on screen, so the command palette can filter them without
// going near the network. Like the feed cache this is read, never rendered
// from, so it doesn't go through set()/subscribe.
export function setKnownPosts(posts) {
  state.knownPosts = posts.slice();
}

export function knownPosts() {
  return state.knownPosts || [];
}
