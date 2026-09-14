// @ts-check
// Post detail (#/posts/:id) — public. Full content, byline with timestamps
// ("edited" when it's been changed), the vote control, and Edit / Delete when
// the post is yours. Delete asks first, inline — never window.confirm.
//
// Below the post: the conversation. Comments load after the post rather than
// with it, because the post is what the reader came for and a comment list is
// a second request that shouldn't hold it up.

import { api } from "../api.js";
import { h, icon, mountView, avatar, relativeTime, fullTime, wasEdited, voteControl, toast } from "../ui.js";
import { get, isMine, dropFeedCache } from "../store.js";
import { nameForMorph, morphingBackTo } from "../transitions.js";
import { navigate } from "../router.js";

// Mirrors schemas.COMMENT_MAX. The server is the one that decides; this is so
// you find out before you've typed another paragraph.
const COMMENT_MAX = 2000;
const COMMENTS_PER_PAGE = 20;
const EMPTY = "Nothing said about this one yet.";

const backLink = () =>
  h("a", { class: "back", href: "#/" }, icon("chevron-left", 15), "Back to the feed");

const sk = (style) => h("span", { class: "sk", style: { display: "block", ...style } });

function loadingSkeleton() {
  return h("section", { class: "detail" },
    backLink(),
    sk({ width: "62%", height: "30px", marginBottom: "20px" }),
    sk({ width: "40%", height: "14px", marginBottom: "28px" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line sk--short" }));
}

export async function renderPost({ params, isStale }) {
  const id = params.id;
  mountView(loadingSkeleton());

  let post;
  try {
    post = await api.get(`/posts/${encodeURIComponent(id)}`);
  } catch (err) {
    if (isStale()) return;
    const gone = err.status === 404;
    mountView(h("section", { class: "detail" },
      backLink(),
      h("h1", { class: "detail__title" }, gone ? "That post is gone." : "That didn't load."),
      h("p", { style: { color: "var(--text-dim)" } },
        gone ? "It may have been deleted." : "Try again in a moment.")));
    return;
  }
  if (isStale()) return;

  const mine = isMine(post);

  const timeBits = [
    h("time", { datetime: post.created_at, title: fullTime(post.created_at) },
      relativeTime(post.created_at)),
  ];
  if (wasEdited(post)) {
    // No separator dot: the tag is already a chip, and space does the job.
    timeBits.push(
      h("span", { class: "tag", title: "Last edited " + fullTime(post.updated_at) }, "edited"));
  }

  const byline = h("div", { class: "detail__byline" },
    avatar(post.user.username, "lg"),
    h("div", { class: "stack" },
      h("a", {
        class: "name",
        href: `#/u/${encodeURIComponent(post.user.username)}`,
        title: `Everything by ${post.user.username}`,
      }, post.user.username),
      h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px" } }, timeBits)));

  const actions = h("div", { class: "detail__actions" });

  // The other end of the morph: whatever title the reader tapped arrives here.
  const title = h("h1", { class: "detail__title" }, post.title);
  nameForMorph(title);
  // And on the way back out, the card for this post takes the name so the
  // journey reverses rather than fading.
  morphingBackTo(post.id);

  const conversation = comments(post, isStale);

  const root = h("section", { class: "detail" },
    backLink(),
    title,
    byline,
    h("div", { class: "detail__row" }, voteControl(post, { inline: true })),
    h("div", { class: "detail__content" }, post.content),
    mine ? actions : null,
    conversation.root);

  if (mine) mountActions();
  mountView(root);
  conversation.load();

  // — owner actions -----------------------------------------------------------
  // Returns the Delete button it just built. cancel() needs that: it calls
  // mountActions() to put the row back, which replaces the button, and
  // focusing the one from the previous call would be focusing a detached
  // element — silently dropping the cursor to the body, which is precisely
  // what Escape is supposed to avoid.
  function mountActions() {
    const deleteBtn = h("button",
      { class: "btn btn--quiet danger", type: "button", onclick: askDelete }, "Delete");
    actions.replaceChildren(
      h("a", { class: "btn btn--ghost", href: `#/posts/${post.id}/edit` }, "Edit"),
      deleteBtn);
    return deleteBtn;

    function askDelete() {
      const yes = h("button", { class: "btn btn--danger", type: "button" }, "Delete");
      const no = h("button", { class: "btn btn--quiet", type: "button", onclick: cancel }, "Keep it");
      const box = h("div",
        { class: "confirm", role: "alertdialog", "aria-label": "Confirm delete", tabindex: "-1" },
        h("p", { class: "confirm__text" }, "Delete this post? There's no undo."),
        no, yes);

      const onKey = (e) => e.key === "Escape" && cancel();
      function cancel() {
        mountActions().focus();
      }
      yes.addEventListener("click", async () => {
        yes.disabled = no.disabled = true;
        yes.textContent = "Just a sec…";
        try {
          await api.del(`/posts/${post.id}`);
          dropFeedCache();
          toast("Post deleted.");
          navigate("/");
        } catch (err) {
          if (err.status === 403 || err.status === 401) {
            mountActions();
          } else {
            yes.disabled = no.disabled = false;
            yes.textContent = "Delete";
            toast("That didn't go through. Try again?");
          }
        }
      });
      box.addEventListener("keydown", onKey);
      actions.replaceChildren(box);
      box.focus();
    }
  }
}

// — the conversation ---------------------------------------------------------
// Built as its own closure rather than more branches inside renderPost: it has
// a list, a pending state, an error state, its own pagination and its own
// optimistic write, and none of that is the post's business.
function comments(post, isStale) {
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

  async function load() {
    if (loading) return;
    loading = true;
    const wantPage = page + 1;
    if (wantPage === 1) list.replaceChildren(skeletonComments(2));

    try {
      const qs = new URLSearchParams({
        page: String(wantPage),
        page_size: String(COMMENTS_PER_PAGE),
      });
      const data = await api.get(`/posts/${post.id}/comments?${qs}`);
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
          sk({ width: "30%", height: "12px", marginBottom: "10px" }),
          h("span", { class: "sk sk--line" }),
          h("span", { class: "sk sk--line sk--short" })))
    );
  }
  return frag;
}
