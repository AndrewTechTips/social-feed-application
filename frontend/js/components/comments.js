// @ts-check
// The conversation under a post.
//
// Lifted out of views/post.js, which had grown into the post, the owner's
// actions, the comment list, one comment and the composer for writing one —
// seven hundred lines in which the screen everybody actually reads was the
// shortest section. This half has a list, a pending state, an error state, its
// own pagination and its own optimistic write, and none of that is the post's
// business; the two things it hands back are a root to put on the page and a
// load() to call once the post has drawn itself.
//
// Nothing in it changed in the move, deliberately. A refactor that also fixes
// things is a refactor nobody can review.

import { api } from "../api.js";
import { h, avatar, relativeTime, fullTime, toast, skeletonBar } from "../ui.js";
import { get } from "../store.js";

// Mirrors schemas.COMMENT_MAX. The server is the one that decides; this is so
// you find out before you've typed another paragraph.
const COMMENT_MAX = 2000;
const COMMENTS_PER_PAGE = 20;
const EMPTY = "Nothing said about this one yet.";

// Same reasoning as SKELETON_AFTER below, applied to the thread: a placeholder
// that is on screen for a hundred and fifty milliseconds and gone is not
// feedback, it's a flinch — and this one flinched on every single post, because
// the request was only started once the post had been drawn and the grey bars
// went up in the same breath. Two of them, taller than the two real comments
// that replaced them, so the page grew and shrank underneath the reader's eye
// as well.
//
// Both halves are fixed: the request now leaves with the post's (see
// commentsFor), and the skeleton is not drawn at all unless the answer is
// genuinely slow to come back. On anything local — the demo backend included —
// the comments are simply there with the post, in one movement, which is what
// it always looked like it was trying to be.
const COMMENTS_SKELETON_AFTER = 250;

/**
 * The first page of a post's comments, asked for now and settled later.
 *
 * Started before the post has even arrived, let alone been laid out. Two
 * requests to the same host go out together and come back together, so the
 * thread costs nothing beyond what the post was already waiting for — where
 * before it cost a second round trip that could only begin once the first had
 * finished and the screen had been drawn. That gap is the whole of the
 * "why is it loading, there are three comments" in the recording.
 *
 * Neither rejection nor a slow answer can hurt the post: the outcome is folded
 * into a value rather than left as a rejection (an unhandled one is still
 * unhandled even when nobody ends up needing it — the post may 404 before this
 * is ever read), and the post screen never awaits it.
 */
export function prefetchComments(id) {
  const qs = new URLSearchParams({ page: "1", page_size: String(COMMENTS_PER_PAGE) });
  return api
    .get(`/posts/${encodeURIComponent(id)}/comments?${qs}`)
    .then((data) => ({ data }), (error) => ({ error }));
}

// — the conversation ---------------------------------------------------------
// Built as its own closure rather than more branches inside renderPost: it has
// a list, a pending state, an error state, its own pagination and its own
// optimistic write, and none of that is the post's business.
export function commentsFor(post, isStale, firstComments) {
  // role="list" because the CSS removes the markers, and Safari drops the list
  // semantics along with them — so a screen reader stops announcing how many
  // comments there are, which is most of what the element was for.
  const list = h("ol", { class: "comments__list", role: "list" });
  const status = h("p", { class: "comments__status", hidden: true });
  const tail = h("div", { class: "comments__more", hidden: true });
  const count = h("span", { class: "comments__count" });
  const head = h("h2", { class: "comments__head" }, "Comments", count);

  const root = h("section", { class: "comments", "aria-label": "Comments" },
    head,
    get("session") ? composer() : signInPrompt(),
    list,
    status,
    tail);

  let page = 0;
  let total = 0;
  let loading = false;

  function setStatus(text) {
    status.textContent = text || "";
    status.hidden = !text;
  }

  function paintCount() {
    count.textContent = total ? String(total) : "";
  }

  // The list is server-ordered oldest-first, so a new comment belongs at the
  // end and nothing above it moves. That's the whole reason the optimistic
  // append is safe to do here and wouldn't be on the feed.
  function shift(by) {
    total = Math.max(0, total + by);
    paintCount();
    setStatus(total === 0 ? EMPTY : "");
  }

  // The prefetched first page, claimed once. A retry after a failure, or a
  // second mount, has to go back to the network — replaying a settled promise
  // would hand the reader the same error twice and call it a retry.
  let pending = firstComments;
  function firstPage() {
    if (!pending) {
      const qs = new URLSearchParams({ page: "1", page_size: String(COMMENTS_PER_PAGE) });
      return api.get(`/posts/${post.id}/comments?${qs}`);
    }
    const claimed = pending;
    pending = null;
    return claimed.then(({ data, error }) => {
      if (error) throw error;
      return data;
    });
  }

  async function load() {
    if (loading) return;
    loading = true;
    const wantPage = page + 1;

    // Armed rather than drawn. If the answer is already in hand — which is the
    // usual case now that the request left with the post's — this timer is
    // cleared in `finally` a microtask later and the reader never sees a
    // placeholder for something that wasn't a wait.
    let skeleton = null;
    if (wantPage === 1) {
      skeleton = setTimeout(() => {
        if (!isStale()) list.replaceChildren(skeletonComments(2));
      }, COMMENTS_SKELETON_AFTER);
    }

    try {
      let data;
      if (wantPage === 1) {
        data = await firstPage();
      } else {
        const qs = new URLSearchParams({
          page: String(wantPage),
          page_size: String(COMMENTS_PER_PAGE),
        });
        data = await api.get(`/posts/${post.id}/comments?${qs}`);
      }
      if (isStale()) return;

      if (wantPage === 1) list.replaceChildren();
      page = data.page;
      total = data.total;
      paintCount();
      list.append(...data.items.map((c) => commentRow(c)));
      // Oldest first, so the next page is the *newer* half — "more", not
      // "older", which would be pointing the wrong way down the thread.
      tail.hidden = !data.has_next;
      tail.replaceChildren(
        data.has_next
          ? h("button", { class: "btn btn--quiet", type: "button", onclick: load },
              "More comments")
          : null);
      setStatus(total === 0 ? EMPTY : "");
    } catch (err) {
      if (isStale()) return;
      if (wantPage === 1) list.replaceChildren();
      setStatus("");
      tail.hidden = false;
      tail.replaceChildren(
        h("div", { class: "feed__error" },
          h("p", {}, "Couldn't load the comments."),
          h("button", { class: "btn btn--ghost", type: "button", onclick: load },
            "Try again")));
    } finally {
      if (skeleton) clearTimeout(skeleton);
      loading = false;
    }
  }

  // — one comment -------------------------------------------------------------
  function commentRow(comment, { pending = false } = {}) {
    const session = get("session");
    const mine = !!(session && comment.user && comment.user.id === session.id);

    const meta = h("div", { class: "comment__meta" },
      h("a", {
        class: "comment__author",
        href: `#/u/${encodeURIComponent(comment.user.username)}`,
        title: `Everything by ${comment.user.username}`,
      }, comment.user.username),
      h("time", { datetime: comment.created_at, title: fullTime(comment.created_at) },
        relativeTime(comment.created_at)));

    const row = h("li", { class: "comment" + (pending ? " comment--pending" : "") },
      avatar(comment.user.username, "sm"),
      h("div", { class: "comment__body" }, meta,
        h("p", { class: "comment__text" }, comment.content)));

    // Nothing to remove until the server has given it an id, so a pending
    // comment doesn't offer the control at all.
    if (mine && !pending) meta.append(removeControl(comment, row));
    return row;
  }

  // Two taps, not a dialog. A modal for one line of text is heavier than the
  // thing it's protecting; a button that asks once is enough, and it lets go
  // again on Escape or as soon as you look somewhere else.
  function removeControl(comment, row) {
    const btn = h("button",
      { class: "comment__remove", type: "button", "aria-label": "Remove your comment" },
      "Remove");
    let armed = false;

    const relax = () => {
      armed = false;
      btn.textContent = "Remove";
      btn.setAttribute("aria-label", "Remove your comment");
    };
    btn.addEventListener("blur", relax);
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") relax();
    });

    btn.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        btn.textContent = "Sure?";
        btn.setAttribute("aria-label", "Confirm removing your comment");
        return;
      }
      btn.disabled = true;
      btn.textContent = "Just a sec…";
      try {
        await api.del(`/comments/${comment.id}`);
        row.remove();
        shift(-1);
        toast("Comment removed.");
      } catch (err) {
        btn.disabled = false;
        relax();
        // 401 and 403 have already said their piece in api.js.
        if (err.status !== 401 && err.status !== 403) {
          toast("That didn't go through. Try again?");
        }
      }
    });
    return btn;
  }

  // — writing one -------------------------------------------------------------
  function composer() {
    const box = h("textarea", {
      id: "comment-body",
      class: "textarea",
      placeholder: "Add a comment",
      "aria-label": "Add a comment",
      maxlength: String(COMMENT_MAX + 200),
    });
    const counter = h("span", { class: "counter", "aria-live": "off" });
    const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Comment");

    const paint = () => {
      const n = box.value.trim().length;
      // Silent until it matters: a counter that ticks from zero on an empty
      // box is telling you about a limit you're nowhere near.
      counter.textContent = n > COMMENT_MAX * 0.8
        ? `${n.toLocaleString()} / ${COMMENT_MAX.toLocaleString()}`
        : "";
      counter.classList.toggle("counter--over", n > COMMENT_MAX);
    };
    box.addEventListener("input", paint);

    const form = h("form", { class: "composer", novalidate: true },
      box,
      h("div", { class: "composer__row" }, counter, submit));

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const content = box.value.trim();
      if (!content) return box.focus();
      if (content.length > COMMENT_MAX) {
        toast("That's a bit long for a comment. Trim it down?");
        return box.focus();
      }
      box.value = "";
      paint();
      send(content, box);
    });

    return form;
  }

  function signInPrompt() {
    return h("p", { class: "composer__prompt" },
      h("a", { href: "#/login" }, "Sign in"),
      " to join in.");
  }

  // The optimistic bit. The comment goes on screen built from what we already
  // know — the session says who you are, the text is in your hand — and the
  // request catches up. If it doesn't, the row comes back out and the words go
  // back in the box, because losing what someone typed is the one failure
  // that isn't recoverable from their side.
  async function send(content, box) {
    const session = get("session");
    // Signed out in another tab between opening the composer and pressing the
    // button: there's nobody to attribute the optimistic row to, so let the
    // request go and let the 401 handler do the talking.
    if (!session) return;
    const ghost = commentRow(
      {
        id: null,
        content,
        created_at: new Date().toISOString(),
        user: { id: session.id, username: session.username },
      },
      { pending: true }
    );
    list.append(ghost);
    shift(1); // which also clears the empty state, if this is the first word

    try {
      const saved = await api.post(`/posts/${post.id}/comments`, { content });
      if (isStale()) return;
      ghost.replaceWith(commentRow(saved));
    } catch (err) {
      if (isStale()) return;
      ghost.remove();
      shift(-1);
      if (box.isConnected && !box.value.trim()) box.value = content;
      if (err.status === 404) toast("That post is gone.");
      else if (err.status !== 401) toast("That comment didn't post. Try again?");
    }
  }

  return { root, load };
}

function skeletonComments(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    frag.append(
      h("li", { class: "comment" },
        h("span", { class: "sk avatar avatar--sm" }),
        h("div", { class: "comment__body" },
          skeletonBar({ width: "30%", height: "12px", marginBottom: "10px" }),
          h("span", { class: "sk sk--line" }),
          h("span", { class: "sk sk--line sk--short" })))
    );
  }
  return frag;
}
