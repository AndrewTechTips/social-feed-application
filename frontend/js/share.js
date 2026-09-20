// @ts-check
// Receiving something shared *into* Commons.
//
// Installed on Android, the app appears in the system share sheet; pick it from
// a browser, a notes app or anywhere else, and the composer opens with what was
// shared already in it. For an app whose entire point is writing things down,
// this is the best-fitting thing the platform offers.
//
// ── why it works on a static host, which nothing else about it does ────────
// A share target is normally a POST to a server. `method: "GET"` in the
// manifest instead means the browser simply *navigates* to the app with the
// shared fields as query parameters — no endpoint, no handler, nothing to
// deploy. GitHub Pages serves a file and this reads `location.search`, which
// is the same trick demo mode plays and works for the same reason.
//
// The hash router never sees any of this: the fragment is untouched, so the
// app boots on whatever screen the URL asked for and this redirects afterwards.
//
// ── what comes through, and what it means ──────────────────────────────────
// Three fields, and no app agrees on which to fill. Chrome sharing a page
// sends `title` and `url`. A notes app sends `text` and nothing else. Several
// put the whole thing — a sentence and a link — in `text` and leave `url`
// empty. So this does not trust the names: it takes what it was given, keeps
// the order the reader would expect to read it in, and never drops anything.
//
// ── the handover ───────────────────────────────────────────────────────────
// What arrives is kept under its own key rather than written straight into
// js/draft.js. Two reasons, and the second is the one that made the decision:
//
//   · a draft is stamped with who wrote it, and a share can arrive while
//     nobody is signed in — after which `readDraft` would correctly refuse to
//     hand it back to the person who signs in a moment later, and the shared
//     text would be gone;
//   · a half-written post already in the composer is somebody's work, and
//     silently replacing it with a shared link would be the worst thing this
//     feature could do. Keeping the two apart lets the composer decide.

const KEY = "commons.share";

/**
 * @typedef {object} SharedIn
 * @property {string} title
 * @property {string} content
 */

/** The parameter names, matching `share_target.params` in the manifest. */
const FIELDS = ["title", "text", "url"];

/**
 * Pull a share out of the current URL, if this navigation was one.
 *
 * Returns null for an ordinary visit, which is nearly all of them.
 * @param {string} [search]
 * @returns {SharedIn | null}
 */
export function readSharedUrl(search = location.search) {
  const params = new URLSearchParams(search);
  const got = FIELDS.map((f) => (params.get(f) || "").trim());
  const [title, text, url] = got;
  if (!title && !text && !url) return null;

  // The body is the text and the link, in that order, with a blank line between
  // them when there are both — which is how somebody would have typed it.
  // A link that is already inside the text is not repeated.
  const parts = [];
  if (text) parts.push(text);
  if (url && !text.includes(url)) parts.push(url);

  return {
    // A title is a title; a bare link with no title is not one, and putting a
    // URL in the title field would be handing the reader something to delete.
    title: title.slice(0, 120),
    content: parts.join("\n\n").slice(0, 5000),
  };
}

/**
 * Take the share out of the URL and put it where the composer will find it.
 *
 * The URL is rewritten with `replaceState` so that a reload — or a Back into
 * this entry — does not deliver the same share a second time. Only the share's
 * own parameters are removed, and the fragment is preserved exactly: the router
 * has not started yet, and the address it is about to read must not change
 * under it.
 *
 * @returns {boolean} whether there was one
 */
export function takeSharedFromUrl() {
  const shared = readSharedUrl();
  if (!shared) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(shared));
  } catch (e) {
    /* storage disabled — the share is lost, and the composer opens empty,
       which is a worse outcome than this is a reason to stop for */
  }
  try {
    // Only the share's own parameters come out. Everything else stays — `?demo=1`
    // is the obvious one, and dropping it would take the app out of demo mode
    // on the next reload, which is a stranger bug to find than it is to avoid.
    const rest = new URLSearchParams(location.search);
    for (const field of FIELDS) rest.delete(field);
    const query = rest.toString();
    history.replaceState(
      history.state,
      "",
      location.pathname + (query ? `?${query}` : "") + location.hash
    );
  } catch (e) {
    /* a browser that refuses replaceState still works; the share is simply
       offered again if the reader reloads, which is harmless */
  }
  return true;
}

/**
 * Whatever was shared in, once. Reading it consumes it.
 *
 * sessionStorage rather than localStorage: a share is about this visit, and a
 * shared link still sitting in the composer next week would be the app
 * remembering something nobody asked it to.
 *
 * @returns {SharedIn | null}
 */
export function consumeShare() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const title = String(value.title || "");
    const content = String(value.content || "");
    if (!title && !content) return null;
    return { title, content };
  } catch (e) {
    return null;
  }
}
