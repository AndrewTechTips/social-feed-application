// @ts-check
/**
 * The shapes the API hands back, written down once.
 *
 * There is no TypeScript here and no build step: these are JSDoc `@typedef`s,
 * `tsconfig.json` turns on `checkJs`, and `npm run typecheck` runs `tsc
 * --noEmit` over them in CI. The files that ship are byte-for-byte the files
 * in this directory — the thing a reviewer reads is the thing the browser
 * runs, which is the whole point of the app being hand-written in the first
 * place.
 *
 * Why this rather than actually adopting TypeScript: see
 * docs/adr/0001-vanilla-js-with-jsdoc-types.md, including the line that says
 * when to change our minds.
 *
 * This module exports nothing at runtime. `export {}` at the bottom is what
 * makes it a module rather than a script, so the typedefs are importable with
 * `@import` without leaking into global scope.
 */

/**
 * A person, as everybody else sees them. Note what isn't here: the email.
 * That's a credential and it only ever comes back from `/users/me`.
 * @typedef {object} User
 * @property {number} id
 * @property {string} username
 * @property {string} created_at  ISO 8601
 */

/**
 * A person, as they see themselves — the answer from `GET /users/me`, and the
 * only place an address crosses the wire.
 * @typedef {User & { email: string }} Me
 */

/**
 * What the app keeps about who you are — and note what isn't in it. The
 * credential moved out when refresh tokens landed: an access token lives in
 * `State.access` for as long as the tab is open, and the thing that survives a
 * reload is an httpOnly cookie this code cannot read. What's left here is
 * public information, kept so the header can paint the right thing before the
 * first request comes back.
 *
 * The id is the durable half (a username could in principle be changed); the
 * username is what gets drawn.
 * @typedef {object} Session
 * @property {number} id
 * @property {string} username
 */

/**
 * The credential half, held in memory only.
 * @typedef {object} Access
 * @property {string} token      the access token, sent as a Bearer header
 * @property {string} csrf       echoed to /auth as X-CSRF-Token
 * @property {number} expiresAt  ms epoch, already backed off from the server's
 *   own expiry so a token can't run out mid-flight
 */

/**
 * @typedef {object} Post
 * @property {number} id
 * @property {string} title
 * @property {string} content
 * @property {boolean} published  An access rule, not a display hint — an
 *   unpublished post is only ever returned to its own author.
 * @property {string} created_at  ISO 8601
 * @property {string} updated_at  ISO 8601; equal to created_at until edited
 * @property {number} user_id
 * @property {User} user
 * @property {number} votes  how many the room gave it
 * @property {boolean} voted whether *this* reader is one of them — a property
 *   of the pair rather than of the post, and false for anybody signed out
 * @property {string | null} [excerpt] the sentence a search matched on, with
 *   the matches wrapped in two control characters. Null unless the caller
 *   searched. **Not HTML** — see highlighted() in ui.js, which is the only
 *   thing allowed to read it.
 */

/**
 * @typedef {object} Comment
 * @property {number} id
 * @property {string} content
 * @property {string} created_at  ISO 8601
 * @property {number} post_id
 * @property {number} user_id
 * @property {User} user
 */

/**
 * One page of anything. The API returns this same envelope for posts and for
 * comments, so a client that can walk one can walk the other.
 * @template T
 * @typedef {object} Page
 * @property {T[]} items
 * @property {number} total
 * @property {number} page
 * @property {number} page_size
 * @property {number} pages
 * @property {boolean} has_next
 * @property {boolean} has_prev
 */

/** @typedef {Page<Post>} PostPage */
/** @typedef {Page<Comment>} CommentPage */

/**
 * A cached list render, so coming back from a post feels instant. The feed, a
 * profile and a set of search results are all one of these.
 * @typedef {object} FeedCache
 * @property {string} key         which list this is — the feed's sort and
 *   search term, or `u/<username>` for a profile. It is also the cache slot,
 *   so two lists that should not be mistaken for each other must not agree
 *   on it
 * @property {number | null} viewer  who it was fetched *as* — a signed-in
 *   snapshot must never be replayed to a signed-out visitor, because it may
 *   contain their own drafts
 * @property {Post[]} items
 * @property {number} page
 * @property {number} pages
 * @property {boolean} hasNext
 * @property {number} total
 * @property {string | null} anchor  the `as_of` the later pages were fetched
 *   with, so a page fetched after a cache restore is still the same feed
 * @property {number} scrollY
 * @property {number} [at]        set by the store when it's written
 */

/**
 * Everything the store holds.
 * @typedef {object} State
 * @property {Session | null} session
 * @property {Access | null} access   never persisted; see the note in store.js
 * @property {FeedCache[]} listCache  the last few lists that were drawn,
 *   newest first — the feed, a profile, a set of results. See CACHE_SLOTS.
 * @property {Post[]} knownPosts   the list last drawn — what the palette
 *   searches, and what the post screen reads on from
 * @property {string | null} knownFrom  where that list came from, named as a
 *   place the way the Back link names one: "the feed", "these results", or a
 *   username. Null when nothing has drawn a list yet.
 */

/**
 * One row in the command palette — an action, or a post from the loaded feed.
 * @typedef {object} Command
 * @property {string} id
 * @property {string} label
 * @property {string} [key]   the global shortcut that also runs it; rows
 *   without one show ↵, which is true of every row
 * @property {boolean} [owned] the key is registered by the control it belongs
 *   to rather than by the palette — set on contextual keys the palette can
 *   honestly advertise but has no business dispatching
 * @property {boolean} [post] set on the rows that are posts rather than actions
 * @property {() => void} run
 */

export {};
