// @ts-check
// The vote control, and the threshold it crosses.
//
// A component rather than a helper: it holds state, it writes to the network,
// it rolls itself back, and it is the one thing on a card that can change what
// the card *is*. It lived in `ui.js` beside the time formatter, which is the
// clearest single argument for having split that file.
//
// The warmth threshold lives here too, because warmth is a fact about a vote
// count and this is what maintains it — see `paint()`.

import { h } from "../dom.js";
import { toast } from "../toast.js";
import { api } from "../api.js";
import { get, notePostVote } from "../store.js";

// Where a post stops being one person's opinion and starts being the room's.
// Three is a judgement, not a measurement, and it's written here rather than
// computed from the page on purpose: a threshold that moved with whatever
// happened to be loaded would mean a card could warm up because you scrolled.
// Against the seeded demo — five authors, a fourteen-post feed — it marks four
// cards: often enough to mean something, rare enough to notice.
export const WARM_AT = 3;

/** @param {{ votes?: number } | null | undefined} post */
export const isWarm = (post) => Number(post?.votes || 0) >= WARM_AT;

// — vote control (optimistic) ---------------------------------------------
export function voteControl(post, { inline = false } = {}) {
  let count = Math.max(0, post.votes || 0);
  // Straight off the post. This used to be a lookup in a set of ids kept in
  // localStorage, because the API had no way of saying — so your own votes
  // were invisible on a second device, invisible in a private window, and
  // wrong after clearing site data. PostOut carries `voted` now.
  let on = post.voted === true;
  let busy = false;

  const label = (o, n) =>
    (o ? "Remove your upvote, now " : "Upvote, now ") +
    n +
    (n === 1 ? " vote" : " votes");

  const caret = h(
    "svg",
    {
      class: "vote__caret",
      viewBox: "0 0 16 16",
      width: 15,
      height: 15,
      "aria-hidden": "true",
    },
    h("path", { d: "M8 3 L14 12.5 L2 12.5 Z" })
  );
  const num = h("span", { class: "vote__count" }, String(count));
  const btn = h(
    "button",
    {
      class: "vote" + (inline ? " vote--inline" : "") + (on ? " vote--on" : ""),
      type: "button",
      "aria-pressed": String(on),
      "aria-busy": "false",
      "aria-label": label(on, count),
    },
    caret,
    num
  );

  // Whether this control's card was warm the last time it painted. It is what
  // makes the ignite below a *crossing* rather than a state — see there.
  let wasWarm = count >= WARM_AT;

  const paint = ({ byMe = false } = {}) => {
    btn.classList.toggle("vote--on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", label(on, count));
    num.textContent = String(count);
    // Your vote is the one that can carry a card over the line, so the warmth
    // has to move when the count does — including back again when an
    // optimistic vote is rolled back, which is why it lives in paint() rather
    // than in the click handler. Null off a card (the post screen draws the
    // same control inline), where there is no edge to warm.
    const warm = count >= WARM_AT;
    const card = btn.closest(".card");
    card?.classList.toggle("card--warm", warm);

    // The hairline draws itself in exactly once: when *this reader's* press is
    // the one that takes the count from below the threshold to at it.
    //
    // Three conditions, and each rules out a case where playing it would be a
    // small lie. `byMe` — a repaint from the store, or a card rendered into a
    // feed that was already warm, is not an event that just happened.
    // `!wasWarm && warm` — the crossing, not the state, so holding at four
    // votes does nothing. And `on` — going *up*, since removing a vote from a
    // warm post also changes `warm`, in the direction nothing should celebrate.
    //
    // Rollback needs no special case because of where this sits: an optimistic
    // vote paints with byMe and may ignite, and if the request then fails the
    // rollback paints *without* it and simply takes the class off.
    if (byMe && on && warm && !wasWarm && card) {
      card.classList.remove("card--igniting");
      void (/** @type {HTMLElement} */ (card).offsetWidth); // restart it
      card.classList.add("card--igniting");
      card.addEventListener(
        "animationend",
        () => card.classList.remove("card--igniting"),
        { once: true }
      );
    }
    wasWarm = warm;
    // And onto the data, not just the pixels. The feed's copy of this post and
    // the post screen's are two different objects fetched at two different
    // moments; without this, voting on one leaves the other saying otherwise
    // when the cache puts it back on screen.
    post.votes = count;
    post.voted = on;
    notePostVote(post.id, count, on);
  };

  btn.addEventListener("click", async () => {
    if (busy) return;
    if (!get("session")) {
      toast("Sign in to upvote.");
      return;
    }
    const next = !on;
    on = next;
    count = Math.max(0, count + (next ? 1 : -1));
    paint({ byMe: true });
    btn.classList.remove("vote--pulse");
    void btn.offsetWidth; // restart the pop animation
    if (next) btn.classList.add("vote--pulse");

    // A second click while the first is still in flight is ignored — two
    // racing vote calls settle in whichever order the network feels like.
    // aria-busy says so out loud: assistive tech announces it, and it gives a
    // test something to wait on other than a guess about latency.
    busy = true;
    btn.setAttribute("aria-busy", "true");
    try {
      await api.post("/vote/", { post_id: post.id, dir: next ? 1 : 0 });
    } catch (err) {
      // 409 = the server already recorded our upvote; 404 = nothing to remove.
      // Either way we're already in the state we wanted — leave it.
      const benign = (next && err.status === 409) || (!next && err.status === 404);
      if (!benign) {
        on = !next;
        count = Math.max(0, count + (next ? -1 : 1));
        paint();
        if (err.status !== 401) toast("That vote didn't take. Try again?");
      }
    } finally {
      busy = false;
      btn.setAttribute("aria-busy", "false");
    }
  });

  return btn;
}
