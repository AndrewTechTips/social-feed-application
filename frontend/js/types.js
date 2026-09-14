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
 * What the app keeps about who you are. The id is the durable half (a username
 * could in principle be changed); the username is what gets drawn.
 * @typedef {object} Session
 * @property {string} token
 * @property {number} id
 * @property {string} username
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
 * @property {number} votes
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
 * A cached feed render, so coming back from a post feels instant.
 * @typedef {object} FeedCache
 * @property {string} key         the search term this page was fetched for
 * @property {number | null} viewer  who it was fetched *as* — a signed-in
 *   snapshot must never be replayed to a signed-out visitor, because it may
 *   contain their own drafts
 * @property {Post[]} items
 * @property {number} page
 * @property {number} pages
 * @property {boolean} hasNext
 * @property {number} total
 * @property {number} scrollY
 * @property {number} [at]        set by the store when it's written
 */

/**
 * Everything the store holds.
 * @typedef {object} State
 * @property {Session | null} session
 * @property {FeedCache | null} feedCache
 * @property {Post[]} knownPosts   what's on screen now, for the palette
 * @property {Set<number>} voted   post ids this browser has upvoted
 */

/**
 * One row in the command palette — an action, or a post from the loaded feed.
 * @typedef {object} Command
 * @property {string} id
 * @property {string} label
 * @property {string} [key]   the global shortcut that also runs it; rows
 *   without one show ↵, which is true of every row
 * @property {boolean} [post] set on the rows that are posts rather than actions
 * @property {() => void} run
 */

export {};
