// @ts-check
// The API, reimplemented in the browser.
//
// GitHub Pages is a static host: there is nowhere for FastAPI to run. Rather
// than publish a link that greets people with "Can't reach the server", the
// demo serves the same contract from memory.
//
// This is a port of frontend/tests/mock_api.py — same state model, same
// response shapes, same status codes — with the HTTP layer swapped for a
// fetch-compatible function. The Python version answers the end-to-end suite;
// this one answers the published site. Both exist to mirror
// backend/app/routers/, and the moment either drifts from it, it stops being
// worth having. The e2e suite runs against this file too (see the "demo"
// project in tests/playwright.config.js), which is what keeps the three
// honest.
//
// Everything below returns a real Response, so js/api.js can't tell the
// difference and needs no branch of its own.

// The localStorage namespace, and — separately — the shape of what's in it.
// The key name is a namespace and doesn't move; STATE_VERSION is the schema,
// and bumping it is how a returning visitor's saved demo gets thrown away
// rather than deserialised into code that no longer expects it. It went to 2
// when comments arrived: a v1 blob has no `comments` array, and every read of
// one would have been a TypeError on somebody's second visit. It went to 3 when
// refresh tokens did, for the same reason — a v2 blob has no `sessions`.
const STORAGE_KEY = "commons.demo.v1";
const STATE_VERSION = 3;

// Access-token life, mirroring settings.access_token_expire_minutes and the
// copy in tests/mock_api.py. The demo runs it at full length rather than
// shortening it for effect: a demo that signed you out every two minutes to
// show off its refresh flow would be demonstrating the wrong thing.
const ACCESS_TTL_MS = 15 * 60 * 1000;

// Mirrors oauth2.ROTATION_GRACE: how long the secret a rotation just replaced
// stays acceptable, so two tabs reloading together don't look like a replay.
const ROTATION_GRACE_MS = 15 * 1000;

// Enough delay that the skeletons, the disabled-while-pending buttons and the
// optimistic vote rollback are all visible rather than theoretical. Real
// network latency to a small API is in this range anyway.
const LATENCY_MS = 150;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Mirrors schemas.USERNAME_RE in the real backend, and the copy in
// tests/mock_api.py. One rule, three enforcers — the alternative is a demo that
// accepts names the API would refuse.
const USERNAME_RE = /^[a-z][a-z0-9_-]{2,19}$/;
const RESERVED_USERNAMES = new Set(["me", "admin", "api", "root", "commons"]);
// Mirrors schemas.COMMENT_MAX, and the copy in tests/mock_api.py.
const COMMENT_MAX = 2000;

// Used when seeded or test data arrives without a username, the same way the
// migration derived one for rows that predated the column.
function usernameFromEmail(email, taken) {
  const base =
    String(email || "")
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .replace(/^[0-9_-]+/, "") || "person";
  let candidate = base.slice(0, 20);
  while (candidate.length < 3) candidate += "x";
  let suffix = 1;
  while (taken.has(candidate) || RESERVED_USERNAMES.has(candidate)) {
    suffix += 1;
    const tail = String(suffix);
    candidate = base.slice(0, 20 - tail.length) + tail;
  }
  return candidate;
}

const json = (status, payload) =>
  new Response(payload === null ? null : JSON.stringify(payload), {
    status,
    headers: payload === null ? {} : { "Content-Type": "application/json" },
  });

const nowIso = (offsetSeconds = 0) =>
  new Date(Date.now() + offsetSeconds * 1000).toISOString();

const detail = (status, message) => json(status, { detail: message });

const invalid = (loc, msg, type = "value_error") =>
  json(422, { detail: [{ loc, msg, type }] });

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true }
    );
  });
}

function abortError() {
  // Matches what fetch() rejects with, so api.js's `err.name === "AbortError"`
  // check and feed.js's in-flight cancellation behave identically here.
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function randomToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[^a-z0-9]/gi, "");
}

// — search ---------------------------------------------------------------------
// The real backend hands this to Postgres: a generated tsvector over title
// (weight A) and body (weight B), a GIN index, websearch_to_tsquery, and
// ts_rank for the ordering. A browser has none of that, so what follows is a
// deliberate approximation with the same observable behaviour — words not
// substrings, AND across terms, stop words ignored, a title hit worth more
// than a body hit, punctuation treated as text.
//
// Line for line the same as the copy in tests/mock_api.py, which is the point:
// one search, three implementations, and the same Playwright specs run against
// all of them.
//
// STOP_WORDS is verbatim from Postgres 18's share/tsearch_data/english.stop,
// so a query of nothing but stop words parses to nothing here exactly as it
// does there. STEM_SUFFIXES is emphatically not a Porter stemmer: it is a
// crude strip that agrees with Postgres on what a search box actually sees
// (repair / repairing / repaired / repairs collapsing together) and is
// internally consistent everywhere else.
const STOP_WORDS = new Set(
  `i me my myself we our ours ourselves you your yours yourself yourselves he
   him his himself she her hers herself it its itself they them their theirs
   themselves what which who whom this that these those am is are was were be
   been being have has had having do does did doing a an the and but if or
   because as until while of at by for with about against between into through
   during before after above below to from up down in out on off over under
   again further then once here there when where why how all any both each few
   more most other some such no nor not only own same so than too very s t can
   will just don should now`.split(/\s+/)
);

// Order matters: the longest applicable suffix wins, and the bare "e" comes
// last so "kettle" and "kettles" both land on "kettl" — which is what Postgres
// does, and the case that showed this list was one entry short.
const STEM_SUFFIXES = ["ies", "ing", "ed", "es", "s", "e"];
const WORD_RE = /[a-z0-9]+/g;

// ts_rank's default weights: a word in the title counts 1.0, the same word in
// the body 0.4.
const TITLE_WEIGHT = 1.0;
const BODY_WEIGHT = 0.4;

function stem(word) {
  for (const suffix of STEM_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const base = word.slice(0, -suffix.length);
      return suffix === "ies" ? base + "i" : base;
    }
  }
  return word;
}

function words(value) {
  return String(value || "").toLowerCase().match(WORD_RE) || [];
}

/** The words of a piece of text, as the index would keep them. */
function lexemes(value) {
  return new Set(words(value).filter((w) => !STOP_WORDS.has(w)).map(stem));
}

/** What the caller actually asked for — empty when they asked nothing: an
 *  empty box, punctuation only, or nothing but stop words. */
function searchTerms(search) {
  return words(search).filter((w) => !STOP_WORDS.has(w)).map(stem);
}

/** How well one post answers a search, or null if it doesn't. Every term has
 *  to land somewhere: bare words are ANDed, as websearch_to_tsquery joins
 *  them. */
function searchRank(row, terms) {
  const title = lexemes(row.title);
  const body = lexemes(row.content);
  let score = 0;
  for (const term of terms) {
    if (title.has(term)) score += TITLE_WEIGHT;
    else if (body.has(term)) score += BODY_WEIGHT;
    else return null;
  }
  return score;
}

// — state ---------------------------------------------------------------------
// Kept as plain JSON so it can go straight into localStorage. Sets and Maps
// would be tidier in memory and a nuisance on the way out.
/**
 * @typedef {object} DemoUser
 * @property {number} id
 * @property {string} username
 * @property {string} email
 * @property {string} password
 * @property {string} created_at
 */
/**
 * @typedef {object} DemoPost
 * @property {number} id
 * @property {string} title
 * @property {string} content
 * @property {boolean} published
 * @property {string} author_email
 * @property {string} created_at
 * @property {string} updated_at
 */
/**
 * @typedef {object} DemoComment
 * @property {number} id
 * @property {number} post_id
 * @property {string} author_email
 * @property {string} content
 * @property {string} created_at
 */
/**
 * @typedef {object} DemoState
 * @property {number} version
 * @property {DemoUser[]} users
 * @property {Record<string, { email: string, expiresAt: number }>} tokens
 *   access tokens, with an expiry — the demo lets one run out exactly as the
 *   real API does, because the client's recovery from that is the interesting
 *   part and it can't be tested against a token that never expires
 * @property {Record<string, { email: string, secret: string,
 *   previous: string | null, rotatedAt: number, csrf: string,
 *   revoked: boolean }>} sessions  refresh families, keyed by family id
 * @property {string | null} cookie  the refresh cookie this "browser" holds —
 *   see the note on `openSession` for why it lives in here
 * @property {DemoPost[]} posts
 * @property {string[]} votes                 "email\0postId"
 * @property {DemoComment[]} comments
 * @property {number} nextUserId
 * @property {number} nextPostId
 * @property {number} nextCommentId
 * @property {{ method: string, path: string, status: number, detail?: string,
 *             network?: boolean }[]} [failures]
 */

/** @returns {DemoState} */
function emptyState() {
  return {
    version: STATE_VERSION,
    users: [],
    tokens: {},
    sessions: {},
    cookie: null,
    posts: [],
    votes: [], // ["email\u0000postId", ...]
    comments: [],
    nextUserId: 1,
    nextPostId: 1,
    nextCommentId: 1,
  };
}

function stateFromSeed(seed) {
  const state = emptyState();
  if (!seed) return state;

  const taken = new Set();
  for (const person of seed.users || []) {
    const username =
      (person.username || "").toLowerCase() ||
      usernameFromEmail(person.email, taken);
    taken.add(username);
    state.users.push({
      id: state.nextUserId++,
      username,
      email: person.email,
      password: person.password,
      created_at: person.created_at || nowIso(-60 * 60 * 24 * 30),
    });
  }

  // Seed posts carry an age in minutes rather than a timestamp, so the feed
  // reads as "16m ago / 3h ago / 5d ago" whenever someone opens it, instead of
  // drifting further into the past the longer the seed file sits in git.
  for (const post of seed.posts || []) {
    const created = nowIso(-(post.minutes_ago || 0) * 60);
    state.posts.push({
      id: state.nextPostId++,
      title: post.title,
      content: post.content,
      published: post.published !== false,
      author_email: post.author,
      created_at: created,
      updated_at: created,
    });
  }

  for (const vote of seed.votes || []) {
    const post = state.posts[vote.post - 1];
    if (!post) continue;
    for (const email of vote.by) state.votes.push(voteKey(email, post.id));
  }

  // Seeded comments carry an age rather than a timestamp, the same way posts
  // do, so a thread reads as a conversation that happened recently whenever
  // somebody opens it. `post` is a 1-based index into posts[], as with votes.
  for (const comment of seed.comments || []) {
    const post = state.posts[comment.post - 1];
    if (!post) continue;
    state.comments.push({
      id: state.nextCommentId++,
      post_id: post.id,
      author_email: comment.author,
      content: comment.content,
      created_at: nowIso(-(comment.minutes_ago || 0) * 60),
    });
  }

  return state;
}

// A vote is the pair (voter, post), and the pair is stored as one string with
// a NUL between the halves — a byte that cannot occur in an email address, so
// no address can be made to collide with another by containing the separator.
//
// Written as the escape and not as the character. A raw NUL in the source is a
// valid string literal and runs correctly, and it also makes this file binary
// to every tool that reads text: `file` reports "data", `grep` finds nothing
// in it, and `git diff` refuses to show it. That cost an afternoon once. Same
// value, same behaviour, and the file is text again.
const voteKey = (email, postId) => `${email}\u0000${postId}`;

/**
 * @param {object} [options]
 * @param {any} [options.seed]        the parsed seed.json, or null for an empty store
 * @param {number} [options.latency]  milliseconds before every response
 * @param {string} [options.storageKey]
 * @param {boolean} [options.persist] false keeps it off localStorage, for Node
 */
export function createDemoBackend({
  seed,
  latency = LATENCY_MS,
  storageKey = STORAGE_KEY,
  persist = true,
} = {}) {
  let state = load();

  function load() {
    if (!persist) return stateFromSeed(seed);
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        // The key is versioned; anything older is discarded rather than
        // migrated. It's demo data — the seed is always a fine answer.
        if (parsed && parsed.version === STATE_VERSION) return parsed;
      }
    } catch (e) {
      /* private mode, disabled storage — fall through to the seed */
    }
    return stateFromSeed(seed);
  }

  function save() {
    if (!persist) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (e) {
      /* quota or disabled storage — the session still works, it just won't
         survive a refresh */
    }
  }

  function reset() {
    state = stateFromSeed(seed);
    try {
      localStorage.removeItem(storageKey);
    } catch (e) {}
    save();
  }

  // — lookups ------------------------------------------------------------------
  const userByEmail = (email) => state.users.find((u) => u.email === email);
  const postById = (id) => state.posts.find((p) => p.id === id);
  const emailForToken = (token) => {
    const row = token ? state.tokens[token] : null;
    if (!row) return null;
    return row.expiresAt > Date.now() ? row.email : null;
  };

  const userByUsername = (name) =>
    state.users.find((u) => u.username === String(name || "").toLowerCase());

  // UserOut: the username is what everyone can see. The email belongs to the
  // account and only leaves it through /users/me.
  const publicUser = (email) => {
    const u = userByEmail(email);
    return u ? { id: u.id, username: u.username, created_at: u.created_at } : null;
  };

  // `viewer` decides `voted` and nothing else. The count is the room's and the
  // flag is the reader's — the same row answers differently for two people,
  // which is why neither is stored on it. Mirrors PostOut in
  // backend/app/schemas.py.
  const postOut = (row, viewer) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    published: row.published,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user_id: userByEmail(row.author_email)?.id ?? 0,
    user: publicUser(row.author_email),
    votes: state.votes.filter((v) => v.endsWith(`\u0000${row.id}`)).length,
    // False for a reader who isn't signed in, which is the truthful answer
    // rather than a missing one.
    voted: !!viewer && state.votes.includes(voteKey(viewer, row.id)),
  });

  // Published posts are public; a draft belongs to its author. Mirrors
  // visible_to() in backend/app/routers/post.py.
  const maySee = (row, viewer) => row.published || row.author_email === viewer;

  const commentOut = (row) => ({
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    post_id: row.post_id,
    user_id: userByEmail(row.author_email)?.id ?? 0,
    user: publicUser(row.author_email),
  });

  // — endpoints ----------------------------------------------------------------
  function register(body) {
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const username = String(body.username || "").trim().toLowerCase();
    const errors = [];

    if (!USERNAME_RE.test(username) || RESERVED_USERNAMES.has(username)) {
      errors.push({
        loc: ["body", "username"],
        msg: "3–20 characters: letters, digits, - and _, starting with a letter",
        type: "value_error",
      });
    }
    if (!EMAIL_RE.test(email)) {
      errors.push({
        loc: ["body", "email"],
        msg: "value is not a valid email address",
        type: "value_error",
      });
    }
    if (password.length < 8) {
      errors.push({
        loc: ["body", "password"],
        msg: "String should have at least 8 characters",
        type: "string_too_short",
      });
    } else if (new TextEncoder().encode(password).length > 72) {
      errors.push({
        loc: ["body", "password"],
        msg: "password must be at most 72 bytes long",
        type: "value_error",
      });
    }
    if (errors.length) return json(422, { detail: errors });

    // The two can collide independently; say which one did.
    if (userByUsername(username)) return detail(409, "That username is taken");
    if (userByEmail(email)) {
      return detail(409, "An account with this email already exists");
    }

    const user = {
      id: state.nextUserId++,
      username,
      email,
      password,
      created_at: nowIso(),
    };
    state.users.push(user);
    save();
    return json(201, publicUser(email));
  }

  // Who the caller is. A token says nothing about the person it signed in, and
  // the client needs an id and a name to tell its own posts from everyone
  // else's — see the note in backend/app/routers/user.py.
  function me(viewer) {
    const u = userByEmail(viewer);
    if (!u) return detail(401, "Could not validate credentials");
    return json(200, {
      id: u.id,
      username: u.username,
      email: u.email,
      created_at: u.created_at,
    });
  }

  function profile(username) {
    const u = userByUsername(username);
    if (!u) return detail(404, `There's nobody here called ${username}`);
    return json(200, publicUser(u.email));
  }

  function mintToken(email) {
    const token = randomToken();
    state.tokens[token] = { email, expiresAt: Date.now() + ACCESS_TTL_MS };
    save();
    return token;
  }

  // — the refresh flow, minus the one thing a browser can't give it -----------
  //
  // The real backend puts the refresh token in an httpOnly cookie, which works
  // because there is a server on the other side of an origin boundary. Here
  // there is neither: this "backend" is a function running in the same page as
  // the app, so there is no Set-Cookie to send and nothing an httpOnly flag
  // could hide the value from. Simulating one would be theatre — and the kind
  // that implies something untrue about the published site.
  //
  // So the contract is real and the storage is honest about itself: the same
  // endpoints, the same rotation, the same reuse detection, the same flat 401
  // for every way of being wrong — and the token sits in `state.cookie`, which
  // is part of the blob in localStorage, alongside everything else the demo
  // pretends is a database. The frontend cannot tell the difference, because
  // in neither case does it ever see the value. The README says this plainly;
  // see docs/adr/0003-token-in-an-httponly-cookie.md.
  function openSession(email) {
    const family = randomToken();
    state.sessions[family] = {
      email,
      secret: "",
      previous: null,
      rotatedAt: Date.now(),
      // Issued once and handed back unchanged on every refresh, exactly as the
      // real backend does — see the note on the column in models.py.
      csrf: randomToken(),
      revoked: false,
    };
    rotateInPlace(family);
    return state.sessions[family].csrf;
  }

  function rotateInPlace(family) {
    const row = state.sessions[family];
    row.previous = row.secret || null;
    row.rotatedAt = Date.now();
    row.secret = randomToken();
    state.cookie = `${family}.${row.secret}`;
    save();
    return row.csrf;
  }

  function tokenBody(email, csrf) {
    return {
      access_token: mintToken(email),
      token_type: "bearer",
      expires_in: Math.round(ACCESS_TTL_MS / 1000),
      csrf_token: csrf,
    };
  }

  function login(form) {
    const email = String(form.get("username") || "").trim();
    const password = String(form.get("password") || "");
    const user = userByEmail(email);
    if (!user || user.password !== password) {
      return detail(401, "Invalid Credentials");
    }
    return json(200, tokenBody(email, openSession(email)));
  }

  // Mirrors oauth2.rotate_refresh_session. One answer for every way of being
  // wrong: which way a refresh token is wrong is exactly what someone holding
  // half of a real one wants to be told.
  function refresh(csrf) {
    const raw = state.cookie || "";
    const cut = raw.indexOf(".");
    const family = cut > 0 ? raw.slice(0, cut) : "";
    const secret = cut > 0 ? raw.slice(cut + 1) : "";
    const row = family && secret ? state.sessions[family] : null;

    // Two kinds of no. A cookie that is missing, forged, expired, revoked or
    // replayed can only ever fail again, so it goes — the equivalent of the
    // real backend's clearing Set-Cookie, and what lets the client tell
    // "signed out" from "temporarily broken". A *good* cookie without a
    // matching CSRF token is a different statement, and the answer to it is to
    // refuse the request and change nothing: clearing there would turn a
    // forged request into a forced sign-out.
    const dead = () => {
      state.cookie = null;
      save();
      return detail(401, "Invalid Credentials");
    };
    const forged = () => detail(401, "Invalid Credentials");

    if (!row || row.revoked) return dead();
    if (row.secret !== secret) {
      const graced =
        row.previous === secret && Date.now() - row.rotatedAt <= ROTATION_GRACE_MS;
      if (!graced) {
        // A live family, an old secret, and no window left to explain it: the
        // cookie was copied. End the session rather than guess which holder is
        // the thief.
        row.revoked = true;
        return dead();
      }
    }
    if (!csrf || row.csrf !== csrf) return forged();

    return json(200, tokenBody(row.email, rotateInPlace(family)));
  }

  function logout(csrf) {
    const raw = state.cookie || "";
    const cut = raw.indexOf(".");
    const family = cut > 0 ? raw.slice(0, cut) : "";
    const row = family ? state.sessions[family] : null;
    const secret = raw.slice(cut + 1);
    const known = row && (row.secret === secret || row.previous === secret);
    if (row && !row.revoked && known && csrf === row.csrf) {
      row.revoked = true;
    }
    // Only clear what was presented. Somebody asking to leave is never told
    // no, but a request that carried nothing has nothing to expire — which is
    // what stops a cross-site POST from signing a reader out.
    if (raw) {
      state.cookie = null;
      save();
    }
    return new Response(null, { status: 204 });
  }

  function listPosts(query, viewer, onlyAuthor) {
    const page = Math.max(1, parseInt(query.get("page") || "1", 10) || 1);
    const pageSize = parseInt(query.get("page_size") || "10", 10);
    if (!(pageSize >= 1 && pageSize <= 100)) {
      return invalid(["query", "page_size"], "out of range");
    }
    const search = query.get("search") || "";
    if (search.length > 100) {
      return invalid(["query", "search"], "too long");
    }

    const byNewest = (a, b) =>
      a.created_at === b.created_at
        ? b.id - a.id
        : a.created_at < b.created_at
          ? 1
          : -1;

    const visible = state.posts.filter(
      (r) =>
        maySee(r, viewer) &&
        (onlyAuthor === undefined || r.author_email === onlyAuthor)
    );

    const terms = searchTerms(search);
    let rows;
    if (terms.length) {
      // Relevance leads, recency breaks the tie — the ORDER BY in
      // page_of_posts().
      rows = visible
        .map((row) => ({ row, rank: searchRank(row, terms) }))
        .filter((hit) => hit.rank !== null)
        .sort((a, b) => (b.rank - a.rank) || byNewest(a.row, b.row))
        .map((hit) => hit.row);
    } else {
      rows = visible.slice().sort(byNewest);
    }

    const total = rows.length;
    const pages = total ? Math.ceil(total / pageSize) : 0;
    const start = (page - 1) * pageSize;

    return json(200, {
      // Not `.map(postOut)` — map passes the index as the second argument,
      // which would arrive here as the viewer.
      items: rows.slice(start, start + pageSize).map((r) => postOut(r, viewer)),
      total,
      page,
      page_size: pageSize,
      pages,
      has_next: page < pages,
      has_prev: page > 1,
    });
  }

  function getPost(id, viewer) {
    const row = postById(id);
    if (!row || !maySee(row, viewer)) {
      // Someone else's draft is 404, not 403 — a 403 would confirm it exists.
      return detail(404, `Post with id: ${id} was not found`);
    }
    return json(200, postOut(row, viewer));
  }

  function createPost(body, email) {
    if (typeof body.title !== "string" || typeof body.content !== "string") {
      return json(422, {
        detail: [{ loc: ["body"], msg: "title and content are required", type: "missing" }],
      });
    }
    const ts = nowIso();
    const row = {
      id: state.nextPostId++,
      title: body.title,
      content: body.content,
      published: body.published !== false,
      author_email: email,
      created_at: ts,
      updated_at: ts,
    };
    state.posts.push(row);
    save();
    return json(201, postOut(row, email));
  }

  function updatePost(id, body, email, { partial }) {
    const row = postById(id);
    if (!row) return detail(404, `Post with id: ${id} does not exist`);
    if (row.author_email !== email) {
      return detail(403, "Not authorized to perform requested action");
    }

    let fields;
    if (partial) {
      fields = {};
      for (const key of ["title", "content", "published"]) {
        if (key in body) fields[key] = body[key];
      }
      if (!Object.keys(fields).length) {
        return detail(400, "No fields provided to update");
      }
    } else {
      if (typeof body.title !== "string" || typeof body.content !== "string") {
        return json(422, {
          detail: [
            { loc: ["body"], msg: "title and content are required", type: "missing" },
          ],
        });
      }
      fields = {
        title: body.title,
        content: body.content,
        published: body.published !== false,
      };
    }

    Object.assign(row, fields, { updated_at: nowIso() });
    save();
    return json(200, postOut(row, email));
  }

  function deletePost(id, email) {
    const row = postById(id);
    if (!row) return detail(404, `Post with id: ${id} does not exist`);
    if (row.author_email !== email) {
      return detail(403, "Not authorized to perform requested action");
    }
    state.posts = state.posts.filter((p) => p.id !== id);
    // ON DELETE CASCADE, by hand — the real schema has Postgres do this.
    state.comments = state.comments.filter((c) => c.post_id !== id);
    state.votes = state.votes.filter((v) => !v.endsWith(`\u0000${id}`));
    save();
    return json(204, null);
  }

  // — comments ---------------------------------------------------------------
  // Comments inherit the post's visibility whole: a draft you can't see has no
  // comments as far as you're concerned, and you can't add one either. Mirrors
  // backend/app/routers/comment.py.
  function visiblePost(id, viewer) {
    const row = postById(id);
    return row && maySee(row, viewer) ? row : null;
  }

  const postMissing = (id) => detail(404, `Post with id: ${id} was not found`);

  function listComments(postId, query, viewer) {
    if (!visiblePost(postId, viewer)) return postMissing(postId);

    const page = Math.max(1, parseInt(query.get("page") || "1", 10) || 1);
    const pageSize = parseInt(query.get("page_size") || "20", 10);
    if (!(pageSize >= 1 && pageSize <= 100)) {
      return invalid(["query", "page_size"], "out of range");
    }

    // Oldest first — a thread is read top to bottom, where a feed is read
    // newest first. The id breaks ties, exactly as the real ORDER BY does.
    const rows = state.comments
      .filter((c) => c.post_id === postId)
      .sort((a, b) =>
        a.created_at === b.created_at
          ? a.id - b.id
          : a.created_at < b.created_at
            ? -1
            : 1
      );

    const total = rows.length;
    const pages = total ? Math.ceil(total / pageSize) : 0;
    const start = (page - 1) * pageSize;

    return json(200, {
      items: rows.slice(start, start + pageSize).map(commentOut),
      total,
      page,
      page_size: pageSize,
      pages,
      has_next: page < pages,
      has_prev: page > 1,
    });
  }

  function createComment(postId, body, email) {
    if (!visiblePost(postId, email)) return postMissing(postId);

    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      return invalid(["body", "content"], "a comment needs something in it");
    }
    if (content.length > COMMENT_MAX) {
      return invalid(
        ["body", "content"],
        `a comment can be at most ${COMMENT_MAX} characters`
      );
    }

    const row = {
      id: state.nextCommentId++,
      post_id: postId,
      author_email: email,
      content,
      created_at: nowIso(),
    };
    state.comments.push(row);
    save();
    return json(201, commentOut(row));
  }

  function deleteComment(id, email) {
    const row = state.comments.find((c) => c.id === id);
    if (!row) return detail(404, `Comment with id: ${id} does not exist`);
    // Yours to remove and nobody else's — the author of the post it sits on
    // doesn't get to either.
    if (row.author_email !== email) {
      return detail(403, "Not authorized to perform requested action");
    }
    state.comments = state.comments.filter((c) => c.id !== id);
    save();
    return json(204, null);
  }

  function vote(body, email) {
    const postId = body.post_id;
    const row = postById(postId);
    if (!row || !maySee(row, email)) {
      return detail(404, `Post with id: ${postId} does not exist`);
    }
    const key = voteKey(email, postId);
    if (body.dir === 1) {
      if (state.votes.includes(key)) {
        return detail(409, `User has already voted on post ${postId}`);
      }
      state.votes.push(key);
      save();
      return json(201, { message: "Successfully added vote" });
    }
    if (!state.votes.includes(key)) return detail(404, "Vote does not exist");
    state.votes = state.votes.filter((v) => v !== key);
    save();
    return json(201, { message: "successfully deleted vote" });
  }

  // Only reachable from the test control surface below, never from the UI.
  // `votes` hangs that many upvotes on each post it creates. The voters are
  // synthetic addresses with no accounts behind them, exactly as in
  // mock_api.py: a vote is a (voter, post) pair and the count is a tally of
  // pairs, so inventing five accounts to raise one number would be furniture.
  function seedPosts({
    count = 0,
    author = "seed@commons.test",
    password = "seedpassword",
    votes = 0,
  }) {
    if (!userByEmail(author)) {
      state.users.push({
        id: state.nextUserId++,
        username: usernameFromEmail(
          author,
          new Set(state.users.map((u) => u.username))
        ),
        email: author,
        password,
        created_at: nowIso(),
      });
    }
    const created = [];
    for (let i = 0; i < count; i++) {
      const n = state.nextPostId;
      // offset by n seconds so created_at ordering is stable and distinct
      const ts = nowIso(n);
      state.posts.push({
        id: state.nextPostId++,
        title: `Seeded post ${n}`,
        content:
          `This is the body of seeded post number ${n}. ` +
          "It exists so the feed has something to paginate through.",
        published: true,
        author_email: author,
        created_at: ts,
        updated_at: ts,
      });
      for (let v = 0; v < votes; v++) {
        state.votes.push(voteKey(`voter${v + 1}@commons.test`, n));
      }
      created.push(n);
    }
    save();
    return created;
  }

  // — the routing table --------------------------------------------------------
  // Deliberately the same shape as mock_api.py's _route, so the two can be read
  // side by side.
  async function handle(path, init) {
    const url = new URL(path, "http://demo.invalid");
    const method = (init.method || "GET").toUpperCase();
    const route = url.pathname;

    const failures = state.failures || (state.failures = []);
    for (let i = 0; i < failures.length; i++) {
      const rule = failures[i];
      if (rule.method === method && new RegExp(rule.path).test(route)) {
        failures.splice(i, 1);
        save();
        if (rule.network) throw new TypeError("Failed to fetch");
        return detail(rule.status, rule.detail || "Forced failure");
      }
    }

    const body = () => {
      try {
        return init.body ? JSON.parse(init.body) : {};
      } catch (e) {
        return {};
      }
    };
    const form = () => new URLSearchParams(init.body || "");
    const token = (init.headers?.Authorization || "").replace(/^Bearer /, "");
    const viewer = emailForToken(token);
    const csrfHeader = init.headers?.["X-CSRF-Token"] || null;

    // Endpoints that need a signed-in caller all answer the same way without one.
    const requireAuth = () => (viewer ? null : detail(401, "Could not validate credentials"));

    if (route === "/") return json(200, { service: "commons-demo-api" });
    if (route === "/healthz") return json(200, { status: "ok" });

    if (route === "/users/" && method === "POST") return register(body());
    if (route === "/users/me" && method === "GET") return me(viewer);
    if (route === "/login" && method === "POST") return login(form());
    if (route === "/auth/refresh" && method === "POST") return refresh(csrfHeader);
    if (route === "/auth/logout" && method === "POST") return logout(csrfHeader);

    const profilePosts = route.match(/^\/users\/([^/]+)\/posts$/);
    if (profilePosts && method === "GET") {
      const author = userByUsername(profilePosts[1]);
      if (!author) {
        return detail(404, `There's nobody here called ${profilePosts[1]}`);
      }
      return listPosts(url.searchParams, viewer, author.email);
    }
    const profileOnly = route.match(/^\/users\/([^/]+)$/);
    if (profileOnly && method === "GET") return profile(profileOnly[1]);

    if (route === "/posts/" && method === "GET") {
      return listPosts(url.searchParams, viewer);
    }
    if (route === "/posts/" && method === "POST") {
      return requireAuth() || createPost(body(), viewer);
    }
    if (route === "/vote/" && method === "POST") {
      return requireAuth() || vote(body(), viewer);
    }

    const comments = route.match(/^\/posts\/(\d+)\/comments$/);
    if (comments) {
      const postId = Number(comments[1]);
      if (method === "GET") return listComments(postId, url.searchParams, viewer);
      if (method === "POST") {
        return requireAuth() || createComment(postId, body(), viewer);
      }
    }

    const oneComment = route.match(/^\/comments\/(\d+)$/);
    if (oneComment && method === "DELETE") {
      return requireAuth() || deleteComment(Number(oneComment[1]), viewer);
    }

    const match = route.match(/^\/posts\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      if (method === "GET") return getPost(id, viewer);
      if (method === "PUT") {
        return requireAuth() || updatePost(id, body(), viewer, { partial: false });
      }
      if (method === "PATCH") {
        return requireAuth() || updatePost(id, body(), viewer, { partial: true });
      }
      if (method === "DELETE") return requireAuth() || deletePost(id, viewer);
    }

    return detail(404, "Not Found");
  }

  async function demoFetch(path, init = {}) {
    await sleep(latency, init.signal);
    return handle(path, init);
  }

  return {
    fetch: demoFetch,
    reset,
    // The control surface the end-to-end suite drives in place of mock_api.py's
    // /__reset, /__seed and /__fail_next. Exposed on window by config.js.
    control: {
      reset,
      seed: (opts) => seedPosts(opts || {}),
      register: (email, password, username) =>
        register({
          email,
          password,
          username: username || usernameFromEmail(email, new Set(state.users.map((u) => u.username))),
        }).status,
      // Open a session without walking the sign-in screen, for tests that need
      // to start on a signed-in page. It goes through the same login() the app
      // does rather than minting a token directly: a fixture that skipped the
      // refresh session would put the page in a state a real sign-in can never
      // produce, and the first /auth/refresh would sign it straight back out.
      signIn: (email, password) => {
        const user = userByEmail(email);
        if (!user || user.password !== password) return null;
        return { email, csrf: openSession(email) };
      },
      // Age every outstanding access token, leaving the refresh session alone
      // — the exact state a client is supposed to recover from without anybody
      // seeing a sign-in form. The mock API's /__expire_access does the same.
      expireAccess: () => {
        const past = Date.now() - 1000;
        for (const token of Object.keys(state.tokens)) {
          state.tokens[token] = { ...state.tokens[token], expiresAt: past };
        }
        save();
      },
      // The two ways a refresh cookie stops being any good, which a spec can
      // do to a real browser with cookies.clear() and a forged Set-Cookie and
      // has to be handed here.
      dropRefreshCookie: () => {
        state.cookie = null;
        save();
      },
      forgeRefreshCookie: () => {
        state.cookie = `${randomToken()}.${randomToken()}`;
        save();
      },
      refreshCookie: () => state.cookie,
      failNext: (rule) => {
        (state.failures || (state.failures = [])).push({
          method: (rule.method || "GET").toUpperCase(),
          path: rule.path || "/",
          status: Number(rule.status || 500),
          detail: rule.detail,
          network: !!rule.network,
        });
        save();
      },
      // Who an address belongs to — the test fixture needs the id and name to
      // plant a session, the same pair /users/me hands the app.
      whoIs: (email) => {
        const u = userByEmail(email);
        return u ? { id: u.id, username: u.username } : null;
      },
      snapshot: () => JSON.parse(JSON.stringify(state)),
      restore: (next) => {
        state = next;
        save();
      },
    },
  };
}

export { STORAGE_KEY, stateFromSeed };
