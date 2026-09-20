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
import { h, icon, skeletonBar } from "../dom.js";
import { toast } from "../toast.js";
import { avatar, fullTime, relativeTime, wasEdited } from "../format.js";
import { mountView } from "../view.js";
import { voteControl } from "../components/vote.js";
import { get, isMine, dropFeedCache, knownPosts, knownFrom } from "../store.js";
import { markReadOnceSeen } from "../reading.js";
import { isShelved, toggleShelf } from "../shelf.js";
import { readerControl } from "../components/reader.js";
import { commentsFor, prefetchComments } from "../components/comments.js";
import {
  nameForMorph,
  clearMorph,
  morphingBackTo,
  morphPending,
} from "../transitions.js";
import { navigate, previousScreen } from "../router.js";

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
  if (profile)
    return { href: from, label: `Back to ${decodeURIComponent(profile[1])}` };
  if (/^#\/\?search=/.test(from)) return { href: from, label: "Back to the results" };
  return { href: "#/", label: "Back to the feed" };
}

const backLink = () => {
  const { href, label } = backTo();
  return h("a", { class: "back", href }, icon("chevron-left", 15), label);
};

/**
 * What to read next, at the end of what you were reading.
 *
 * The list is whichever one was last drawn — the feed, a set of results, or
 * somebody's page — which the store keeps for the palette anyway. Reading it
 * from there rather than from `previousScreen()` is what makes two steps in a
 * row work: after one onward link the screen you came from is another post,
 * but the *list* hasn't changed and you can keep going down it.
 *
 * "Previous" and "Next" rather than "Newer" and "Older", because the list is
 * not always in time order — a set of search results is ranked by relevance,
 * and a pair of links promising newer and older would be quietly lying on
 * every one of them. The heading says which list it means, so the direction
 * words don't have to carry that too.
 *
 * Nothing is drawn when there is no list, which is the honest answer for a
 * pasted link: this offers more of something you were already reading, and
 * somebody who arrived cold wasn't.
 *
 * One limit worth knowing: the list is what has been *loaded*, so the last
 * card of an un-scrolled feed has no next. Asking the API for a neighbour
 * would need an endpoint that doesn't exist, and inventing one to paper over
 * the end of a page the reader never reached is a poor trade.
 *
 * @param {import("../types.js").Post} post
 * @param {HTMLElement} heldTitle the post's own heading, which is wearing the
 *   morph name — see the note on the click handler
 */
function onward(post, heldTitle) {
  const list = knownPosts();
  const at = list.findIndex((p) => String(p.id) === String(post.id));
  if (at === -1) return null;

  const prev = at > 0 ? list[at - 1] : null;
  const next = at < list.length - 1 ? list[at + 1] : null;
  if (!prev && !next) return null;

  /**
   * @param {import("../types.js").Post} p
   * @param {string} dir
   * @param {string} variant
   */
  const item = (p, dir, variant) => {
    const title = h("span", { class: "onward__title" }, p.title);
    const link = h(
      "a",
      { class: `onward__item onward__item--${variant}`, href: `#/posts/${p.id}` },
      h("span", { class: "onward__dir" }, dir),
      title
    );
    // The same journey the feed's cards make, continued. The one thing that
    // has to happen first is releasing the heading above: it is *held* (see
    // nameForMorph's `hold`) so that going back can reverse, and two elements
    // wearing one view-transition-name is an ambiguous name — which
    // pairOrStrip would answer by dropping the morph altogether. So the
    // heading hands the name on rather than sharing it.
    link.addEventListener("click", () => {
      clearMorph(heldTitle);
      nameForMorph(title);
    });
    return link;
  };

  return h(
    "nav",
    { class: "onward", "aria-labelledby": "onward-head" },
    h(
      "p",
      { class: "onward__head", id: "onward-head" },
      `More from ${knownFrom() || "the feed"}`
    ),
    h(
      "div",
      { class: "onward__pair" },
      prev ? item(prev, "Previous", "prev") : null,
      next ? item(next, "Next", "next") : null
    )
  );
}

/**
 * Put this post aside, or take it back off.
 *
 * It lives beside the vote control rather than on every card, and that is a
 * choice about what a card is. A card carries one control because a feed of
 * toolbars is not a feed; the moment you know a post is worth coming back to
 * is the moment you are looking at it, which is here.
 *
 * The visible word is the accessible name — no aria-label — because hiding the
 * label the way the header's buttons do would leave a control named after
 * nothing, and a name that didn't contain the visible word would fail the rule
 * that says it has to. `aria-pressed` carries the state on top of it.
 *
 * @param {import("../types.js").Post} post
 */
function saveControl(post) {
  const btn = h("button", { class: "btn btn--quiet shelved", type: "button" });

  const paint = () => {
    const on = isShelved(post.id);
    btn.classList.toggle("shelved--on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.replaceChildren(
      icon(on ? "bookmark-filled" : "bookmark"),
      h("span", {}, on ? "Saved" : "Save")
    );
  };

  btn.addEventListener("click", () => {
    const on = toggleShelf(post.id);
    paint();
    toast(on ? "Saved to your shelf." : "Removed from your shelf.");
  });

  // Repaint whenever the shelf changes, whoever changed it.
  //
  // This exists for one case in particular and it is not a hypothetical: a save
  // made while signed in is written to the server, and if that write fails
  // js/shelf.js puts the list back. Without this the button would go on saying
  // "Saved" over a shelf that no longer holds this post — the app asserting
  // something it knows to be untrue, which is the worst thing an optimistic
  // control can do. It also covers the sync at sign-in and a change made in
  // another tab.
  //
  // Nothing removes the listener, because nothing has to: the button goes with
  // the screen and `paint` closes over an element that is then unreachable.
  // Same arrangement main.js uses for the header's own copy of this count.
  addEventListener("commons:shelf", paint);

  paint();
  return btn;
}

function loadingSkeleton() {
  return h(
    "section",
    { class: "detail" },
    backLink(),
    skeletonBar({ width: "62%", height: "30px", marginBottom: "20px" }),
    skeletonBar({ width: "40%", height: "14px", marginBottom: "28px" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line sk--short" })
  );
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
    mountView(
      h(
        "section",
        { class: "detail" },
        backLink(),
        h(
          "h1",
          { class: "detail__title" },
          gone ? "That post is gone." : "That didn't load."
        ),
        h(
          "p",
          { style: { color: "var(--text-dim)" } },
          gone ? "It may have been deleted." : "Try again in a moment."
        )
      )
    );
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
    h(
      "time",
      { datetime: post.created_at, title: fullTime(post.created_at) },
      relativeTime(post.created_at)
    ),
  ];
  if (wasEdited(post)) {
    // No separator dot: the tag is already a chip, and space does the job.
    timeBits.push(
      h(
        "span",
        { class: "tag", title: "Last edited " + fullTime(post.updated_at) },
        "edited"
      )
    );
  }

  const byline = h(
    "div",
    { class: "detail__byline" },
    avatar(post.user.username, "lg"),
    h(
      "div",
      { class: "stack" },
      h(
        "a",
        {
          class: "name",
          href: `#/u/${encodeURIComponent(post.user.username)}`,
          title: `Everything by ${post.user.username}`,
        },
        post.user.username
      ),
      h(
        "span",
        { style: { display: "inline-flex", alignItems: "center", gap: "8px" } },
        timeBits
      )
    )
  );

  const actions = h("div", { class: "detail__actions" });

  // The other end of the morph: whatever title the reader tapped arrives here.
  // Held, so the name is still on it when the reader leaves and the card on
  // the other side comes looking for something to travel from.
  const title = h("h1", { class: "detail__title" }, post.title);
  nameForMorph(title, { hold: true });
  // And on the way back out, the card for this post takes the name so the
  // journey reverses rather than fading.
  morphingBackTo(post.id);

  const conversation = commentsFor(post, isStale, firstComments);
  // Two halves: a button for the toolbar row, and the row it opens under it.
  const reading = readerControl();

  const root = h(
    "section",
    { class: "detail" },
    backLink(),
    title,
    byline,
    h(
      "div",
      { class: "detail__row" },
      voteControl(post, { inline: true }),
      saveControl(post),
      reading.button
    ),
    reading.panel,
    h("div", { class: "detail__content" }, post.content),
    mine ? actions : null,
    conversation.root,
    // Last, after the conversation, because that is where the page actually
    // ends — and because slipping it between the post and its comments would
    // interrupt the one sequence this screen is built around.
    onward(post, title)
  );

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
    const deleteBtn = h(
      "button",
      { class: "btn btn--quiet danger", type: "button", onclick: askDelete },
      "Delete"
    );
    actions.replaceChildren(
      h("a", { class: "btn btn--ghost", href: `#/posts/${post.id}/edit` }, "Edit"),
      deleteBtn
    );
    return deleteBtn;

    function askDelete() {
      const yes = h("button", { class: "btn btn--danger", type: "button" }, "Delete");
      const no = h(
        "button",
        { class: "btn btn--quiet", type: "button", onclick: cancel },
        "Keep it"
      );
      // `alertdialog` with **no focus trap**, and that is deliberate rather
      // than unfinished.
      //
      // A focus trap is what makes a *modal* dialog safe: it is the mechanism
      // that stops a screen reader wandering out of a box that is covering the
      // page. This box covers nothing. It expands in place where the Delete
      // button was, the post is still there above it and still readable, and
      // the rest of the page is still legitimately reachable — so trapping the
      // cursor inside it would take away an exit that is genuinely open.
      //
      // The role is still right: this interrupts to ask something whose answer
      // cannot be undone, which is what `alertdialog` is for, and the
      // announcement it triggers is the point. What is deliberately absent is
      // `aria-modal`, because claiming that would be claiming the trap.
      //
      // Escape cancels and puts focus back on the button that opened it, which
      // is the part of modal behaviour that *is* owed here — see cancel().
      const box = h(
        "div",
        {
          class: "confirm",
          role: "alertdialog",
          "aria-label": "Confirm delete",
          tabindex: "-1",
        },
        h("p", { class: "confirm__text" }, "Delete this post? There's no undo."),
        no,
        yes
      );

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
