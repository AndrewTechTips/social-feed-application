// @ts-check
// Post detail (#/posts/:id) — public. Full content, byline with timestamps
// ("edited" when it's been changed), the vote control, and Edit / Delete when
// the post is yours. Delete asks first, inline — never window.confirm.
//
// Below the post: the conversation. Comments are asked for at the same moment
// as the post and drawn independently of it — the post never waits on them,
// and by the time it has been laid out its comments are usually already in
// hand. See commentsFor() below.

import { api } from "../api.js";
import { h, icon, mountView, avatar, relativeTime, fullTime, wasEdited, voteControl, toast } from "../ui.js";
import { get, isMine, dropFeedCache } from "../store.js";
import { markReadOnceSeen } from "../reading.js";
import { nameForMorph, morphingBackTo, morphPending } from "../transitions.js";
import { navigate, previousScreen } from "../router.js";

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

// How long the post gets to arrive before the reader is shown a loading state.
//
// Under about a fifth of a second a screen change reads as instant, and a
// skeleton that appears and is gone again inside that window isn't feedback —
// it's a flinch. It also cost the app the one piece of choreography it has:
// the title you tapped can only become the heading of the post if the heading
// is what arrives. Mount a skeleton first and the morph is handed a screen
// with no title in it, the tapped words hang over the placeholder with nowhere
// to go, and the real post then needs a second transition to get in. Two
// animations and a flash of the thing you tapped, to cover a wait that hadn't
// happened yet.
//
// So the skeleton waits its turn. A local API — or the in-browser demo backend
// — answers long before this and the reader goes from card to post in one
// movement, which is what the transition was written for. A slow connection
// still gets its skeleton, a quarter of a second late, which is the point at
// which it starts being reassuring rather than noisy.
//
// 250 rather than 200 for headroom: the published demo answers in a deliberate
// 150ms (LATENCY_MS in js/demo/backend.js) and a threshold thirty milliseconds
// above that is a coin toss on a slow phone, not a threshold. The tap itself
// is acknowledged immediately either way — see .card--opening in
// components.css — so nothing about this window is silent.
const SKELETON_AFTER = 250;

// "Back" should name the place it goes back to.
//
// The title-morph already carries the reader here from whichever card they
// tapped, and reverses on the way out — and that card is as often on someone's
// profile, or in a set of search results, as it is on the feed. A link that
// says "the feed" regardless is the one thing that can make the journey they
// just watched feel like it lied. It also quietly loses work: the feed cache
// is keyed by search term, so "#/" from a set of results refetches the
// unfiltered feed and the query is gone.
function backTo() {
  const from = previousScreen() || "";
  const profile = from.match(/^#\/u\/([^?]+)$/);
  if (profile) return { href: from, label: `Back to ${decodeURIComponent(profile[1])}` };
  if (/^#\/\?search=/.test(from)) return { href: from, label: "Back to the results" };
  return { href: "#/", label: "Back to the feed" };
}

const backLink = () => {
  const { href, label } = backTo();
  return h("a", { class: "back", href }, icon("chevron-left", 15), label);
};

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
function prefetchComments(id) {
  const qs = new URLSearchParams({ page: "1", page_size: String(COMMENTS_PER_PAGE) });
  return api
    .get(`/posts/${encodeURIComponent(id)}/comments?${qs}`)
    .then((data) => ({ data }), (error) => ({ error }));
}

export async function renderPost({ params, isStale }) {
  const id = params.id;
  const firstComments = prefetchComments(id);

  const placeholder = () => {
    if (!isStale()) mountView(loadingSkeleton(), { transition: false });
  };

  // Whether the screen the reader is leaving is worth leaving up for a moment.
  //
  // It is, when they got here by tapping a title: the list is still there,
  // still readable, the card they tapped is holding its pressed state, and the
  // post is about to grow out of it. Replacing all that with grey bars for a
  // sixth of a second says the app threw the page away and started again.
  //
  // It is not, in any other case — and the difference matters more than it
  // looks. Arrive from a pasted link and there is no screen to hold, only an
  // empty page, which is worse company than a skeleton. Arrive from the
  // compose form, having just pressed Post, and the screen being held is the
  // form itself: it sits there full of the words you just sent, looking for
  // all the world like the button didn't take. So the wait is spent only where
  // waiting reads as continuity, and everywhere else the skeleton is immediate,
  // exactly as it was.
  const holdTheOldScreen = morphPending();
  if (!holdTheOldScreen) placeholder();
  const pending = holdTheOldScreen ? setTimeout(placeholder, SKELETON_AFTER) : null;

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
  } finally {
    // Whichever way the request went, the loading state has missed its moment.
    // Cleared in `finally` so the error path above can't leave a timer behind
    // that redraws a skeleton over the message it just wrote.
    if (pending) clearTimeout(pending);
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
  // Held, so the name is still on it when the reader leaves and the card on
  // the other side comes looking for something to travel from.
  const title = h("h1", { class: "detail__title" }, post.title);
  nameForMorph(title, { hold: true });
  // And on the way back out, the card for this post takes the name so the
  // journey reverses rather than fading.
  morphingBackTo(post.id);

  const conversation = comments(post, isStale, firstComments);

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
  // Only from here. A post that 404'd or failed to load returns above, and
  // marking one of those read would dim a card for something the reader never
  // saw — and give them no way to undo it.
  markReadOnceSeen(post.id, isStale);

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
function comments(post, isStale, firstComments) {
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
          sk({ width: "30%", height: "12px", marginBottom: "10px" }),
          h("span", { class: "sk sk--line" }),
          h("span", { class: "sk sk--line sk--short" })))
    );
  }
  return frag;
}
