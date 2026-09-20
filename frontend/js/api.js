// @ts-check
// fetch wrapper: attaches the auth header, sends/parses JSON, normalises errors,
// keeps the access token fresh, and handles the three cross-cutting status
// codes (401 / 403 / 429) in one place.

import { apiFetch } from "./config.js";
import { get, clearSession, setAccess, accessToken, csrfToken } from "./store.js";

export class ApiError extends Error {
  constructor(status, detail, data) {
    super(detail || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.data = data;
  }
}

// Pull a human string out of FastAPI's error shapes:
//   {"detail": "message"}  or  {"detail": [{loc, msg, ...}]}  (422)
function readDetail(data, status) {
  if (!data) return `Request failed (${status})`;
  const d = data.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d.length)
    return d[0].msg || "That didn't go through. Try again?";
  return `Request failed (${status})`;
}

// — keeping the token fresh ----------------------------------------------------
// The access token lives for minutes and only in memory, so two ordinary things
// leave the app without one: a reload, and sitting on a page long enough for it
// to expire. Both are answered here rather than by sending someone back to a
// sign-in form they don't need — the refresh cookie the browser is holding is
// what says they're still signed in.
//
// One flight at a time. A feed render fires several requests at once; without
// this they would each start their own refresh, and because every refresh
// rotates the cookie, the ones that arrived second would be presenting a secret
// the first had already spent — which the server correctly reads as a stolen
// cookie and answers by ending the session. The single worst way to implement
// this feature is a dozen honest requests logging you out.
/** @type {Promise<"ok" | "signed-out" | "unavailable"> | null} */
let inFlight = null;

/**
 * Three outcomes, and they are not interchangeable — which is most of what
 * this function is for.
 *
 *   "ok"          there is a usable access token
 *   "signed-out"  the cookie is gone, expired or revoked. Genuinely signed
 *                 out: forget the identity and carry on anonymously, because
 *                 most of this app is readable that way.
 *   "unavailable" the request never reached anybody. Not a reason to throw
 *                 away an identity that is probably still good — treating a
 *                 dropped connection as a sign-out is the app punishing a
 *                 reader for their own bad train tunnel.
 *
 * @returns {Promise<"ok" | "signed-out" | "unavailable">}
 */
function refreshAccess() {
  if (inFlight) return inFlight;
  const flight = (async () => {
    try {
      const data = await request("/auth/refresh", {
        method: "POST",
        auth: false,
        credentials: true,
        csrf: true,
        // No signal: this is shared work. Letting the first caller's
        // AbortController cancel it would cancel it for everyone waiting.
        recover: false,
      });
      setAccess(data);
      return "ok";
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        return "signed-out";
      }
      return "unavailable";
    } finally {
      inFlight = null;
    }
  })();
  inFlight = flight;
  return flight;
}

/** Called by the sign-out path, so a logout mid-refresh can't be undone. */
export function forgetPendingRefresh() {
  inFlight = null;
}

// — what we already have, and the fingerprint that proves it ------------------
//
// The API puts an `ETag` on the feed. Hand it back as `If-None-Match` and an
// unchanged feed answers `304` with no body at all, which on a phone is the
// difference between a few kilobytes and a few hundred bytes. See
// backend/app/etag.py, including the honest note about what it does *not*
// save: the server does all the same work either way.
//
// Keyed by the full path, query string and all, because `?page=2` and
// `?search=x` are different answers. Capped, because a session that searches
// all afternoon would otherwise accumulate one entry per keystroke.
//
// Held in memory only. It is a cache of responses that can contain the
// reader's own drafts, and the one thing worse than not having it would be
// leaving it on a shared machine.
const CONDITIONAL_MAX = 24;
/** @type {Map<string, { etag: string, data: unknown }>} */
const conditional = new Map();

/**
 * Forget every cached response. Called when the session changes.
 *
 * Strictly it is belt and braces: the server fingerprints the body it *would*
 * send, so a signed-out reader presenting a signed-in validator is answered
 * with a fresh 200 rather than a 304. But "the server will catch it" is a poor
 * reason to keep somebody's drafts in memory after they have signed out.
 */
export function forgetConditional() {
  conditional.clear();
}

/**
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {unknown} [options.body]     JSON body
 * @param {Record<string, string>} [options.form]  form-encoded body, for /login
 * @param {boolean} [options.auth]     send the bearer token if there is one
 * @param {boolean} [options.credentials]  send and accept cookies — /auth only
 * @param {boolean} [options.csrf]     attach X-CSRF-Token — /auth only
 * @param {boolean} [options.recover]  try a refresh-and-retry on a 401
 * @param {boolean} [options.background]  nobody asked for this request, so its
 *   failure must not be narrated. A 401 here means "not signed in", not "you
 *   have been signed out" — see the note at the 401 branch.
 * @param {AbortSignal} [options.signal]
 */
async function request(
  path,
  {
    method = "GET",
    body,
    form,
    auth = true,
    credentials = false,
    csrf = false,
    recover = true,
    background = false,
    signal,
  } = {}
) {
  // Whether this request is *meant* to be authenticated, decided before the
  // refresh below can change the answer. The 401 handling at the bottom keys
  // off this rather than off whether a header actually went out — a write that
  // was supposed to carry a session and didn't needs the same "you've been
  // signed out" as one that carried a stale token.
  const intendedAuth = auth && !!get("session");

  // Signed in, but with no token in hand — a reload, or one that expired while
  // the tab sat open. Trade the cookie for one before asking, rather than
  // sending an unauthenticated request and repairing it after the 401: the
  // feed would come back without your drafts in it, and the retry would arrive
  // after it had already been drawn.
  if (intendedAuth && !accessToken()) {
    const outcome = await refreshAccess();
    if (outcome === "unavailable") {
      // Don't send a request that is certain to be wrong. It would go out
      // unauthenticated, come back 401, and report a lost session to someone
      // whose connection is the only thing that's actually missing.
      throw new ApiError(0, "Can't reach the server. Is the backend running?");
    }
  }

  /** @type {Record<string, string>} */
  const headers = {};
  const bearer = auth ? accessToken() : null;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (csrf) {
    const token = csrfToken();
    if (token) headers["X-CSRF-Token"] = token;
  }

  // Only on a plain GET, and only where we have both halves. A conditional
  // write would be a very quiet way to drop something on the floor.
  const held = method === "GET" ? conditional.get(path) : undefined;
  if (held) headers["If-None-Match"] = held.etag;

  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let res;
  try {
    // apiFetch is the real network on a dev machine and the in-browser demo
    // backend on the published site — same arguments, same Response either way.
    res = await apiFetch(path, {
      method,
      headers,
      body: payload,
      signal,
      // Only where a cookie is actually in play. The refresh cookie is scoped
      // to /auth on the server, so a browser wouldn't attach it elsewhere in
      // any case — but "include" is also what lets a cross-origin response set
      // one at all, and saying it only where it's needed keeps the reason
      // visible at the call site.
      credentials: credentials ? "include" : "same-origin",
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    // fetch only rejects on network-level failure (server down, DNS, CORS block)
    throw new ApiError(0, "Can't reach the server. Is the backend running?");
  }

  // Before anything reads the body, because there isn't one — and before the
  // `res.ok` check below, which counts 304 as a failure and would report "that
  // didn't go through" about a request that went through perfectly.
  if (res.status === 304 && held) return held.data;

  let data = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { detail: text };
      }
    }
  }

  if (res.ok) {
    const tag = method === "GET" ? res.headers.get("ETag") : null;
    if (tag) {
      // Re-inserted rather than updated, so the Map's insertion order is a
      // least-recently-used order and the oldest entry is the right one to drop.
      conditional.delete(path);
      conditional.set(path, { etag: tag, data });
      if (conditional.size > CONDITIONAL_MAX) {
        // The Map is non-empty — we have just inserted into it — so there is
        // always a first key. The checker cannot see that, and a cast would
        // be a louder way of saying the same thing than a guard.
        const oldest = conditional.keys().next().value;
        if (oldest !== undefined) conditional.delete(oldest);
      }
    }
    return data;
  }

  // — cross-cutting handling ------------------------------------------------
  //
  // None of it for a request nobody asked for. A poll that runs on a timer must
  // never move the reader: on a boot with a dead refresh cookie the poll and
  // the feed race, and if the poll wins, a visitor who should have landed on
  // the feed signed out is thrown onto the sign-in screen instead — by a
  // request they did not make, about a session they were not using. The caller
  // catches and forgets; the next thing the reader actually does will report a
  // dead session properly.
  if (background) throw new ApiError(res.status, readDetail(data, res.status), data);

  if (res.status === 401 && intendedAuth) {
    // A token was sent and refused. That is almost always "it expired a moment
    // ago" — the server's clock and ours disagree by a second, or the request
    // sat in a queue — so trade the cookie for a new one and ask exactly once
    // more. Twice would be a retry loop wearing a disguise.
    if (bearer && recover) {
      const outcome = await refreshAccess();
      if (outcome === "ok") {
        return request(path, {
          method,
          body,
          form,
          auth,
          credentials,
          csrf,
          recover: false,
          signal,
        });
      }
      if (outcome === "unavailable") {
        // The token was refused and we couldn't reach anybody to replace it.
        // Which of those is the real problem is unknowable from here, so say
        // the one that's recoverable and leave the session alone: being signed
        // out is permanent, and a train tunnel isn't.
        throw new ApiError(0, "Can't reach the server. Is the backend running?");
      }
    }
    // No session left to recover with. clearSession() has already run wherever
    // the refresh came back 401; calling it again here covers the path where
    // no token was sent at all, which is what a 401 on a write means once the
    // identity has been dropped.
    clearSession();
    // Only here. A 401 on a request that never carried a token is not a
    // session ending — it is a signed-out reader touching something that needs
    // one, which the screen they are on already knows how to say. Announcing it
    // would send somebody who is simply browsing to a sign-in form they did not
    // ask for, and on a boot with a dead cookie it would replace the feed.
    announce(401);
  } else if (res.status === 403 || res.status === 429) {
    announce(res.status);
  }

  throw new ApiError(res.status, readDetail(data, res.status), data);
}

/**
 * Tell the app that a request came back with a status the whole app cares
 * about, and let the app decide what that looks like.
 *
 * This file used to do it itself: it imported `toast` and it assigned to
 * `location.hash`, which meant the transport layer put things on the screen
 * and navigated between screens. It worked — and it was the one place in this
 * codebase where the layering ran backwards, which made it the one place a
 * change to the interface could break a fetch.
 *
 * An event rather than a callback passed in from `main.js`, because there is
 * no single caller to pass one: `request()` is reached from every view, from
 * the vote control, from the notification poller. An event has one publisher
 * and any number of subscribers, which is the shape this actually is. It is
 * the same mechanism the theme toggle and the focus mode already use.
 *
 * What subscribes is `main.js`, in one place, and that is also where the
 * wording lives now — which is where wording belongs.
 *
 * @param {number} status
 */
function announce(status) {
  dispatchEvent(new CustomEvent("commons:api-error", { detail: { status } }));
}

export const api = {
  get: (path, opts) => request(path, { ...opts, method: "GET" }),
  post: (path, body, opts) => request(path, { ...opts, method: "POST", body }),
  put: (path, body, opts) => request(path, { ...opts, method: "PUT", body }),
  patch: (path, body, opts) => request(path, { ...opts, method: "PATCH", body }),
  del: (path, opts) => request(path, { ...opts, method: "DELETE" }),
  form: (path, form, opts) => request(path, { ...opts, method: "POST", form }),

  // — the three calls that talk to /auth ------------------------------------
  // Grouped here rather than spread across the views, because they are the
  // only places in the app that send a cookie, and having one list of them is
  // what makes "does anything else touch the cookie?" a question with an
  // answer.

  /** Sign in. Returns the token body; the caller decides what to do with it. */
  login: (email, password) =>
    request("/login", {
      method: "POST",
      form: { username: email, password },
      auth: false,
      credentials: true,
    }),

  /** Sign out, server-side. Revokes the session rather than only forgetting it. */
  logout: () =>
    request("/auth/logout", {
      method: "POST",
      auth: false,
      credentials: true,
      csrf: true,
      recover: false,
    }),

  /** Exposed for the boot path and the tests; everything else gets it for free. */
  refresh: refreshAccess,
};
