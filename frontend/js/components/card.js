// @ts-check
// One post, as a card.
//
// Used by the feed, by a profile and by the shelf. A profile is a feed with
// one author in it and a shelf is a feed of what you kept, so it would be
// strange for any of them to draw a post differently — and stranger still for
// only one of them to hand the title to the view transition on the way out.

import { h } from "../dom.js";
import { avatar, relativeTime } from "../format.js";
import { hasRead, readingMinutes } from "../reading.js";
import { nameForMorph, claimReturn } from "../transitions.js";
import { voteControl, isWarm } from "./vote.js";

function preview(text) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 280 ? t.slice(0, 280).trimEnd() + "…" : t;
}

// The two markers ts_headline is configured with — see the long note beside
// HEADLINE_START in backend/app/routers/post.py.
const MARK_START = "\u0002";
const MARK_STOP = "\u0003";

/**
 * The sentence a search matched on, with the matches drawn as <mark>.
 *
 * **Split, never parsed.** The excerpt is somebody's post, passed through a
 * Postgres function whose handling of markup is a side effect of how the
 * text-search parser classifies tokens — it drops some of a tag and leaves the
 * rest, closing bracket and all. It is not escaped and was never trying to be.
 *
 * So this walks the string and appends text nodes and real elements. There is
 * no innerHTML here and there must never be one: the markers are control
 * characters precisely so that nothing downstream is tempted to treat any of
 * this as HTML, and the one place that could is this function.
 *
 * @param {string} excerpt
 * @param {string} content the post it was cut from, only so the ellipsis below
 *   is added when it is true and not when it isn't
 */
function highlighted(excerpt, content) {
  const p = h("p", { class: "card__preview card__preview--excerpt" });

  // A fragment from the middle of a post starts mid-sentence, on a lowercase
  // word, directly under a title — which reads like a rendering fault rather
  // than like a quotation. One leading ellipsis says "this is from further in".
  //
  // Only when it is: a post whose match is in its opening sentence gets a
  // fragment that *is* the opening, and an ellipsis in front of that would be
  // saying something untrue. First word against first word rather than a
  // prefix comparison, because ts_headline rejoins its tokens with single
  // spaces and the original may not have been written with them.
  const firstWord = (text) =>
    (String(text || "")
      .trim()
      .match(/^\S+/) || [""])[0]
      .split(MARK_START)
      .join("")
      .split(MARK_STOP)
      .join("");
  if (firstWord(excerpt) && firstWord(excerpt) !== firstWord(content)) {
    p.append(document.createTextNode("…"));
  }
  // Everything before the first marker is ordinary text; after that each chunk
  // is a match followed by the text up to the next one. An unbalanced marker —
  // a start with no stop — falls through as text, which is the safe reading.
  String(excerpt)
    .split(MARK_START)
    .forEach((chunk, i) => {
      if (i === 0) return p.append(document.createTextNode(chunk));
      const stop = chunk.indexOf(MARK_STOP);
      if (stop === -1) return p.append(document.createTextNode(chunk));
      p.append(
        h("mark", {}, chunk.slice(0, stop)),
        document.createTextNode(chunk.slice(stop + MARK_STOP.length))
      );
    });
  return p;
}

export function postCard(post) {
  const title = h("h2", { class: "card__title" }, post.title);
  const link = h(
    "a",
    { class: "card__link", href: `#/posts/${post.id}` },
    title,
    // The excerpt when there was a question, the opening of the post when
    // there wasn't. A result that shows *why* it is a result is worth more
    // than the first 280 characters of it.
    post.excerpt
      ? highlighted(post.excerpt, post.content)
      : h("p", { class: "card__preview" }, preview(post.content))
  );

  // Hand this title to the transition on the way out, so it becomes the
  // heading of the post screen rather than being replaced by it. Set at the
  // moment of the click: only one element may carry the name at a time.
  //
  // The card also stays visibly pressed from here until the post lands. The
  // post screen deliberately holds the feed on screen for a quarter of a
  // second rather than flashing a skeleton at a wait that usually isn't one
  // (SKELETON_AFTER in views/post.js) — and a screen that holds still after a
  // tap has to say that it heard the tap, or holding still reads as ignoring
  // it. :active can't do this: it ends when the finger lifts, which is the
  // instant the waiting starts. Nothing removes the class, because the swap
  // removes the card.
  link.addEventListener("click", () => {
    nameForMorph(title);
    link.closest(".card")?.classList.add("card--opening");
  });

  // Coming back the other way, the card the reader left from takes the name
  // so the journey reverses instead of just fading.
  if (claimReturn(post.id)) nameForMorph(title);

  // How long this will take. Written "4 min" and read out "4 min read": the
  // short form is what the row has space for on a phone, and the word is what
  // stops it being a bare number in a list of other numbers to anybody
  // listening rather than looking.
  const mins = h(
    "span",
    { class: "card__mins" },
    `${readingMinutes(post.content)} min`,
    h("span", { class: "visually-hidden" }, " read")
  );

  const read = hasRead(post.id);

  const meta = h(
    "div",
    { class: "card__meta" },
    avatar(post.user.username, "sm"),
    h(
      "a",
      {
        class: "card__author",
        href: `#/u/${encodeURIComponent(post.user.username)}`,
        title: `Everything by ${post.user.username}`,
      },
      post.user.username
    ),
    h("time", { datetime: post.created_at }, relativeTime(post.created_at)),
    mins,
    // The dimmed title says this to anybody looking at it and to nobody
    // listening — which is the opposite of the warmth hairline, where the vote
    // button beside it was already saying the same thing out loud. There is no
    // second channel carrying this one, so it needs its own.
    read ? h("span", { class: "visually-hidden" }, "Already read") : null,
    post.published ? null : h("span", { class: "tag" }, "Draft")
  );

  return h(
    "article",
    {
      class: "card" + (isWarm(post) ? " card--warm" : "") + (read ? " card--read" : ""),
    },
    voteControl(post),
    h("div", { class: "card__body" }, link, meta)
  );
}
