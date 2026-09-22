// @ts-check
// Feed (#/) — public. A stream of post cards, newest first, with a debounced
// title search (driven from the header) and infinite scroll. Coming back from a
// post restores the list and scroll position from a short-lived cache.

import { api } from "../api.js";
import { h, skeletonCards } from "../dom.js";
import { toast } from "../toast.js";
import { leavingScrollY, mountView } from "../view.js";
import { postCard } from "../components/card.js";
import {
  get,
  isMine,
  cacheFeed,
  readFeedCache,
  viewerKey,
  setKnownPosts,
} from "../store.js";
import { isNewSince, lastVisit, sinceLabel, spellCount } from "../reading.js";
import { onLeavingScreen, previousScreen } from "../router.js";
import { forgetReturn } from "../transitions.js";
import { IS_DEMO } from "../config.js";
import { demoNote } from "../demo/strip.js";
import { installBlock, installButton, installHowTo } from "../install.js";

const PAGE_SIZE = 10;

// How often the feed asks whether anything has arrived, while it is on screen
// and the tab is being looked at.
//
// **Not a WebSocket, and the arithmetic is the argument.** This feed receives a
// few posts a day. A socket would hold a connection open per reader for hours
// in order to deliver a handful of messages, push async concerns into an
// otherwise synchronous SQLAlchemy codebase, and — the part that settles it —
// could only ever be demonstrated on somebody's own machine, because the
// published build has no server at all. Forty-five seconds of a request that
// answers with one number is the right shape for the load, and being able to
// say why is worth more than being able to say "real-time".
//
// The request is one page of one post with `?since=`, so the envelope's
// `total` is the whole answer; the item is only there because a page has to
// have a shape. Paused while the tab is hidden, because a feed nobody is
// looking at is not waiting for news.
const POLL_MS = 45000;
const FIRST_SKELETONS = 5;
// How long a re-order gets to answer before the reader is shown a loading
// state, when there is already a list on screen worth holding.
//
// The same number and the same argument as views/post.js: under about a fifth
// of a second a change reads as instant, and a skeleton that appears and is
// gone again inside that window is not feedback, it is a flinch. A local API
// or the in-browser demo answers a re-order in well under this, so the list
// simply changes; a slow connection still gets its skeletons, a quarter of a
// second late, which is the point at which they start being reassuring rather
// than noisy.
const SKELETON_AFTER = 250;
// How far below the fold the sentinel still counts as "coming up" — the feed
// starts fetching the next page this far before you reach the end of this one.
const PREFETCH_MARGIN = 700;

// Only one feed instance should own the observer + hashchange listener at a time.
let activeTeardown = null;

// A quiet line of type above the feed, for people who haven't signed in — the
// app otherwise opens on skeletons with nothing saying what it is.
//
// Borrowed from Linear's changelog pages and the empty states in Things 3:
// set the sentence in the reading face, say one true thing, and stop. No hero
// image, no gradient headline, no call to action shouting at a reader who is
// already reading. It sits in the flow at the top of the list, so scrolling
// past it is all it takes to be rid of it, and it's gone entirely once you're
// signed in — at which point you know what this is.
//
// In demo mode it also carries the demo notice, so a visitor gets one block of
// explanation rather than two stacked banners.
function masthead() {
  return h(
    "header",
    { class: "masthead" },
    h("h1", { class: "masthead__title" }, "A small public common."),
    h(
      "p",
      { class: "masthead__line" },
      "Anyone can read what's here. You need an account to post or to upvote."
    ),
    IS_DEMO ? demoNote() : null,
    // It installs, too — and this is the recruiter-facing surface, the one
    // block of type a first-timer actually reads. One more line in the same
    // voice, and *nothing at all* in the two states where saying it would be a
    // lie: already an app, or a browser that cannot install one. No banner, no
    // bar across the top, no second colour — the amber is spent on a vote, on
    // warmth, and on where you are, and this is none of the three.
    installBlock(
      (state) => [
        h(
          "p",
          { class: "masthead__install-line" },
          "It installs, too — it works on a plane."
        ),
        state === "prompt" ? installButton() : installHowTo(),
      ],
      { class: "masthead__install" }
    ),
    // The one place a first-time visitor is already reading a block of type
    // about what this is, so it is the one place to offer the longer answer.
    h(
      "p",
      { class: "masthead__more" },
      h("a", { href: "#/colophon" }, "How this was made")
    )
  );
}

// The line between what arrived while you were away and what was already here
// when you left.
//
// It is the half of "four new posts" that actually does something. The count
// is a fact you read once; this is where that fact *is* on the page, so a
// reader who comes back after a week can see the edge of the unfamiliar
// instead of having to work out where they stopped. Drawn from --hairline's
// neighbours rather than from the accent: it is a place, not a value, and the
// amber is spent on votes and warmth.
const bookmark = () => h("p", { class: "bookmark" }, "Where you left off");

// How the feed is ordered. Links rather than buttons, because each one is a
// real address: it can be shared, and Back undoes it.
//
// `new` has no query of its own — the plain feed is the default, and a URL that
// spelled out the thing that happens anyway is a URL that dates badly.
const SORTS = [
  ["new", "Newest", "#/"],
  ["warm", "Warmest", "#/?sort=warm"],
  ["discussed", "Discussed", "#/?sort=discussed"],
];

/**
 * @param {string} current
 *
 * The mark moves when the list does, and not a moment before.
 *
 * It was tempting to move it on the press instead — the re-order now holds the
 * old list for as long as the fetch takes (see `reordering` below), so for that
 * moment the bar is still marked on the option you pressed it *from*, which
 * looks like a control that did not hear you. Saying "heard you" early is what
 * .card--opening does on a card, and it is the right answer there.
 *
 * It is the wrong answer here, and tests/sort.spec.js says why in as many
 * words: two orderings of the same posts have the same number of cards, so the
 * marked option is the *only* thing that distinguishes the new list from the
 * old one. Move it early and it stops being a fact about what is on screen and
 * becomes a promise about what is coming — which is exactly the kind of claim
 * this app doesn't make anywhere else. The press is not silent without it:
 * .sortbar__option:active answers the finger, and the list itself is the
 * answer to the press.
 */
function sortbar(current) {
  const bar = h(
    "nav",
    { class: "sortbar", "aria-label": "Order the feed" },
    SORTS.map(([value, label, href]) =>
      h(
        "a",
        {
          class: "sortbar__option",
          href,
          "aria-current": value === current ? "page" : null,
        },
        label
      )
    )
  );
  // Stamped on the press, because afterwards there is no way to tell. See
  // takeOrderPress. Modified clicks are the browser's to answer — ⌘-click
  // opens the order in another tab and this page never re-renders — so they
  // leave no stamp behind to be read by whatever renders next.
  bar.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = /** @type {Element} */ (event.target);
    if (target.closest(".sortbar__option")) orderPressedAt = Date.now();
  });
  return bar;
}

/**
 * Did this render come from a press on the bar above the list?
 *
 * The options are ordinary links — that is deliberate, each order is a real
 * address — so by the time the feed is rendering again there is nothing left
 * to say who asked for it. And two presses that arrive here looking identical
 * mean opposite things about where the page should end up:
 *
 *   · Pressing Warmest is a re-order. The reader is still looking at the bar
 *     they pressed, a finger's width from it, and the page must not move under
 *     them — not to the top, and not to wherever they happened to be the last
 *     time they left that order.
 *   · Pressing the brand from the feed means "give me a fresh feed", and a
 *     fresh feed starts at the top. It reaches renderFeed as the same screen
 *     with the same search term too (main.js drops the cache, then navigates),
 *     so nothing about the address tells the two apart.
 *
 * Only the bar stamps, so only the bar holds its place.
 *
 * Read once at the top of a render and cleared by the reading: the mount it
 * belongs to can be a fetch away (see `reordering`), and a stamp still
 * standing by then would answer for whatever came next instead. The window is
 * the one in view.js and for the same reason — a press nobody followed with a
 * render is not this render's press.
 */
let orderPressedAt = 0;
const ORDER_PRESS_WINDOW = 1000;

function takeOrderPress() {
  const pressed = Date.now() - orderPressedAt < ORDER_PRESS_WINDOW;
  orderPressedAt = 0;
  return pressed;
}

const SORT_VALUES = SORTS.map(([value]) => value);

export function renderFeed({ query, isStale }) {
  const search = (query.get("search") || "").trim();
  // Anything else is the default rather than an error: a hand-edited URL
  // shouldn't be able to put the feed in a state it can't draw.
  const asked = query.get("sort") || "new";
  const sort = SORT_VALUES.includes(asked) ? asked : "new";
  // The cache is a snapshot of one list, and two orderings of the same posts
  // are two lists.
  const key = `${sort}:${search.toLowerCase()}`;

  const list = h("div", { class: "feed__list" });
  // A live region, and it has to be one because of what it is used for below.
  //
  // Infinite scroll is a visual idiom: ten more cards slide under the last one
  // and a sighted reader simply sees them. Someone listening gets nothing —
  // the list silently grew while their cursor stayed where it was, and the
  // only way to find out is to keep pressing down and hope. `polite` so it
  // waits for a gap rather than interrupting whatever is being read, and
  // `aria-atomic` so the whole sentence is spoken rather than whichever words
  // happen to have changed since last time.
  const status = h("p", {
    class: "feed__status",
    hidden: true,
    "aria-live": "polite",
    "aria-atomic": "true",
  });
  const sentinel = h("div", { class: "feed__sentinel", "aria-hidden": "true" });
  // Not while searching: at that point the reader is looking for something
  // specific and an introduction is in the way.
  const showMasthead = !get("session") && !search;
  // Same rule, same reason — plus a second one. "New since Tuesday" is a
  // statement about the feed, and a set of search results is not the feed.
  const since = h("p", { class: "feed__since", hidden: true });
  // A button, because pressing it does something to this page rather than
  // going somewhere. aria-live so a reader who is not looking at the top of
  // the feed is told rather than expected to notice.
  const pill = h("button", {
    class: "feed__new",
    type: "button",
    hidden: true,
    "aria-live": "polite",
  });
  // Only on the chronological feed. The count and the rule below it say "what
  // arrived while you were away, and where that run ends" — and the run only
  // *is* a run if the list is in time order. On a ranking the boundary would
  // be drawn somewhere in the middle of nothing.
  const tellsYouWhatsNew = !search && sort === "new" && lastVisit() !== null;
  // What the post screen calls this list when it offers the next one in it.
  // Named as a place, the same way the Back link names one.
  const listName = search ? "these results" : "the feed";

  const root = h(
    "section",
    {
      class: "feed",
      "aria-label": search ? `Posts matching ${search}` : "Latest posts",
    },
    showMasthead ? masthead() : null,
    since,
    // Directly above the list it orders, and gone while searching: relevance
    // leads there, so all three would be the same list under different names.
    search ? null : sortbar(sort),
    pill,
    list,
    status,
    sentinel
  );

  const items = [];
  // How many posts arrived since the reader's last visit, and whether we have
  // seen the far edge of them yet. Both are computed while items are appended
  // rather than afterwards, because the feed is in chronological order — so
  // "new" is a prefix of it, and finding where that prefix ends is the same
  // walk as drawing the cards.
  let newCount = 0,
    boundaryFound = false;
  // The moment this feed was fetched at, sent back on every page after the
  // first so they are all served out of the same feed.
  //
  // Offset pagination counts from the top, so a post written between one page
  // and the next pushes every later page down by one and hands the reader a
  // card they have already read. ADR 0005 knew that and judged it not worth
  // paying for; what changed is that the app is about to start *inserting*
  // rows into a feed while it is being read, which turns a rare race into one
  // duplicate per insertion.
  //
  // The newest post's own timestamp rather than the browser's clock: it comes
  // from the server, so there is no skew to get wrong, and by construction
  // every post already on screen is inside the window.
  //
  // Not while searching, and not on a ranking. Both order by something other
  // than time, so the first item is not the newest and an anchor taken from it
  // would exclude posts that belong in the window. A ranking is unstable under
  // pagination anyway — a vote reorders it — and the control that will insert
  // rows into a feed only ever inserts into the newest one.
  let anchor = null;
  const anchored = !search && sort === "new";
  // What the poll compares against. It starts at the anchor and moves as new
  // posts are pulled in — while `anchor` never moves, because it is the window
  // the *pages below* are counted in. Letting one value do both jobs would mean
  // that taking the new posts renumbered every page after it, which is the
  // thing the window exists to prevent.
  let newestSeen = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let poller = null;
  // How many have arrived while the reader has been here, waiting to be asked
  // for. Not the same as `newCount` below, which is about the visit before
  // this one.
  let arrived = 0;
  let page = 0,
    pages = 1,
    hasNext = true,
    total = null;
  let loading = false,
    controller = null,
    observer = null,
    errorBox = null;
  // Who these items were fetched for. Recorded here rather than read back at
  // teardown, because teardown can run after a sign-out has already changed
  // the answer — see the note in store.js.
  let viewer = viewerKey();

  function setStatus(text, pad) {
    status.textContent = text || "";
    status.hidden = !text;
    status.classList.toggle("feed__status--pad", !!pad);
  }

  /**
   * Draw a run of posts, keeping the "since your last visit" bookkeeping as we
   * go. Both the network path and the cache-restore path come through here, so
   * coming back from a post can't lose the bookmark the feed was wearing when
   * you left it.
   *
   * @param {Node} target the list, or a fragment about to be appended to it
   * @param {import("../types.js").Post[]} posts
   */
  function appendPosts(target, posts) {
    posts.forEach((post) => {
      items.push(post);
      if (tellsYouWhatsNew && !boundaryFound) {
        if (isNewSince(post)) {
          // Your own posts are new to the feed and not to you, so they don't
          // count — but they are still inside the new run, and the boundary
          // has to stay where time put it or the line would be drawn through
          // the middle of what arrived while you were away.
          if (!isMine(post)) newCount++;
        } else {
          boundaryFound = true;
          if (newCount > 0) target.appendChild(bookmark());
        }
      }
      target.appendChild(postCard(post));
    });
  }

  /**
   * Deliberately does not count down as you read. It is a statement about what
   * arrived, not a list of chores: the feedback for having read one of them is
   * the card going quiet, which is on the card where the reader is looking.
   */
  function renderSince() {
    const at = lastVisit();
    if (!tellsYouWhatsNew || at === null || newCount === 0) {
      since.hidden = true;
      return;
    }
    // The count is exact once the boundary is on screen, or once there is
    // nothing left to fetch. Before that all we honestly know is a floor —
    // every post loaded so far is new and the next page may hold more.
    const exact = boundaryFound || !hasNext;
    const spelled = spellCount(newCount);
    since.textContent =
      (exact ? spelled : `At least ${spelled.toLowerCase()}`) +
      (newCount === 1 ? " new post since " : " new posts since ") +
      sinceLabel(at) +
      ".";
    since.hidden = false;
  }

  function renderTail() {
    renderSince();
    if (total === 0) {
      // Two different emptinesses, and neither is a shrug.
      //
      // A search that found nothing is not a dead end, it is a query that was
      // too narrow — so say the thing that makes the next attempt better
      // rather than only reporting the failure. And an empty room is an
      // invitation, but only to somebody who can accept it: offering "be the
      // first to say something" to a visitor with no account is an invitation
      // to a door they will find locked.
      setStatus(
        search
          ? `Nothing matches "${search}". It searches titles and bodies, so try one word rather than several.`
          : get("session")
            ? "Nothing here yet. Be the first to say something."
            : "Nothing here yet. Sign in and you could be the first to say something.",
        true
      );
    } else if (!hasNext) {
      setStatus("That's everything for now.");
    } else {
      setStatus("");
    }
  }

  function showError() {
    list.querySelectorAll(".card--skeleton").forEach((n) => n.remove());
    setStatus("");
    if (errorBox) return;
    const retry = () => {
      errorBox.remove();
      errorBox = null;
      load(page === 0);
    };
    errorBox = h(
      "div",
      { class: "feed__error" },
      h("p", {}, page === 0 ? "The feed didn't load." : "Couldn't load more."),
      h(
        "button",
        { class: "btn btn--ghost", type: "button", onclick: retry },
        "Try again"
      )
    );
    root.append(errorBox);
  }

  async function load(initial) {
    if (loading || (!initial && !hasNext)) return;
    loading = true;
    let landed = false;
    if (controller) controller.abort();
    controller = new AbortController();
    const wantPage = page + 1;

    if (initial) list.replaceChildren(skeletonCards(FIRST_SKELETONS));

    try {
      const qs = new URLSearchParams({
        page: String(wantPage),
        page_size: String(PAGE_SIZE),
      });
      if (search) qs.set("search", search);
      if (sort !== "new") qs.set("sort", sort);
      // URLSearchParams encodes the `+` in the timestamp's offset, which a
      // bare string concatenation would hand over as a space and the API would
      // answer with a 422.
      if (anchor) qs.set("as_of", anchor);
      const data = await api.get(`/posts/?${qs}`, { signal: controller.signal });
      if (isStale()) return;

      ({ page, pages, has_next: hasNext, total } = data);
      viewer = viewerKey();
      if (initial) {
        // Page one *is* the window, so it is asked for unanchored and then
        // defines the anchor for everything after it.
        anchor = anchored && data.items.length ? data.items[0].created_at : null;
        newestSeen = anchor;
        list.replaceChildren();
        items.length = 0;
        // The walk starts over with the list, or a refetch would go on
        // counting from where the last one stopped and the bookmark would be
        // drawn twice.
        newCount = 0;
        boundaryFound = false;
      }

      const frag = document.createDocumentFragment();
      appendPosts(frag, data.items);
      list.append(frag);
      setKnownPosts(items, listName);
      renderTail();
      // Say how many arrived, for anyone who can't see them arrive.
      //
      // After renderTail and only into the gap it leaves, which is the order
      // that matters: reaching the end of a list is more worth hearing than
      // the length of the last page, so "that's everything for now" wins and
      // this fills the silence when there is more to come.
      //
      // Not on the first page either — that one *is* the screen, and the
      // screen announces itself through the heading and the focus move.
      // Counting the only posts there are would be counting from nothing.
      if (!initial && data.items.length && status.hidden) {
        setStatus(
          `${data.items.length} more ${data.items.length === 1 ? "post" : "posts"}.`
        );
      }
      // Only once there is something to compare against.
      if (initial) startPolling();
      landed = true;
    } catch (err) {
      if (err.name === "AbortError" || isStale()) return;
      showError();
    } finally {
      loading = false;
      // Only after a page that actually landed. Re-arming on the error path
      // would turn a failing endpoint into a request loop behind a "Try again"
      // button nobody pressed.
      if (landed && hasNext && !isStale()) rearm();
    }
  }

  // — what has arrived since you got here ------------------------------------

  function paintPill() {
    pill.hidden = arrived === 0;
    if (arrived === 0) return;
    pill.textContent =
      arrived === 1 ? "One new post" : `${spellCount(arrived)} new posts`;
  }

  /** One page of one, for the number in the envelope. */
  async function askWhatsNew() {
    if (!newestSeen || loading || isStale()) return;
    if (document.visibilityState !== "visible") return;
    try {
      const qs = new URLSearchParams({
        page: "1",
        page_size: "1",
        since: newestSeen,
      });
      const data = await api.get(`/posts/?${qs}`);
      if (isStale()) return;
      arrived = data.total || 0;
      paintPill();
    } catch (err) {
      // A poll that fails is a poll. The reader asked for nothing and is owed
      // no explanation; the next one is forty-five seconds away.
    }
  }

  /**
   * Put what arrived at the top, where it belongs, and leave the window alone.
   *
   * The new rows go *above* the paginated set rather than into it: the pages
   * below were counted in a feed that stops at `anchor`, and moving that would
   * renumber every one of them. So `anchor` stays where it is and only
   * `newestSeen` moves — see the note where they are declared.
   */
  async function takeWhatsNew() {
    if (!newestSeen) return;
    pill.disabled = true;
    try {
      const qs = new URLSearchParams({
        page: "1",
        page_size: String(Math.min(arrived, 50)),
        since: newestSeen,
      });
      const data = await api.get(`/posts/?${qs}`);
      if (isStale()) return;
      if (data.items.length) {
        const frag = document.createDocumentFragment();
        // Newest first from the API, and they go above a list that is also
        // newest first — so they are prepended in the order they arrived in.
        data.items.forEach((post) => frag.append(postCard(post)));
        list.prepend(frag);
        // In front of the run this visit already had, so the palette and the
        // post screen's "read on" see the list the reader is looking at.
        items.unshift(...data.items);
        setKnownPosts(items, listName);
        newestSeen = data.items[0].created_at;
      }
      arrived = 0;
      paintPill();
      // The reader pressed a control at the top of the feed; taking them to
      // what they pressed it for is the whole of what they asked for.
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      if (!isStale()) toast("Couldn't fetch those. Try again?");
    } finally {
      pill.disabled = false;
    }
  }

  pill.addEventListener("click", takeWhatsNew);

  function startPolling() {
    if (poller || !anchored) return;
    poller = setInterval(askWhatsNew, POLL_MS);
    // A tab coming back to the front is the moment a reader most wants to know,
    // and the one time waiting out the rest of an interval would be silly.
    addEventListener("visibilitychange", askWhatsNew);
  }

  function setupObserver() {
    observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && load(false),
      { rootMargin: `${PREFETCH_MARGIN}px 0px` }
    );
    observer.observe(sentinel);
  }

  /**
   * Start the sentinel's observation over, once a page has landed.
   *
   * An IntersectionObserver reports *changes*, and it decides what counts as a
   * change by comparing against the last state it reported. That baseline is
   * set early — often while the first request is still in flight and the page
   * is nothing but skeletons — and two things then go wrong, both seen in the
   * wild:
   *
   *   · The first report says "in view", because at that moment it is. The
   *     load it asks for is declined by the guard at the top of load(), since
   *     the first page is already loading. On a tall screen the sentinel never
   *     leaves the margin afterwards, so nothing ever changes, nothing is ever
   *     reported again, and the feed stops at one page.
   *
   *   · The sentinel leaves the margin and comes back inside a single frame —
   *     which is exactly what a fast render followed by a scroll looks like.
   *     Blink never observes the state in between, so it has nothing to report,
   *     and the scroll that should have loaded the next page loads nothing.
   *
   * In both cases the feed stops paginating and there is nothing the reader can
   * do about it — on a tall screen there isn't even any scrolling left to try.
   * Re-observing forces a fresh initial notification against the layout as it
   * stands now: it re-bases the comparison, and it asks again in case the
   * sentinel is still in reach.
   */
  function rearm() {
    if (!observer) return;
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  }

  let torn = false;
  function teardown() {
    if (torn) return;
    torn = true;
    if (activeTeardown === teardown) activeTeardown = null;
    stopLeaving();
    removeEventListener("visibilitychange", askWhatsNew);
    if (poller) clearInterval(poller);
    poller = null;
    if (observer) observer.disconnect();
    if (controller) controller.abort();
    if (items.length) {
      cacheFeed({
        key,
        viewer,
        items: items.slice(),
        page,
        pages,
        hasNext,
        total,
        anchor,
        scrollY: leavingScrollY(),
      });
    }
  }

  // Asked before the instance we are replacing has had its say, and that
  // ordering is load-bearing.
  //
  // A feed writes its list and its scroll position into the cache as it leaves,
  // and the teardown that does it runs on the next line. For every ordinary
  // journey that is harmless, because the outgoing screen and the incoming one
  // are different lists under different keys — leaving `#/` to draw
  // `#/?sort=warm` writes `new:` and reads `warm:`.
  //
  // There is exactly one case where they are the same key: the feed being
  // redrawn as itself, which is what the brand does. Read after, and the answer
  // is always yes — the entry found is the one deposited a line earlier, by the
  // very screen being replaced. "Give me a fresh feed" would restore the list
  // it was asked to throw away, and dropFeedCache() could not prevent it
  // because the write happens after the drop.
  //
  // So the question is asked first: what was stored for this key *before* this
  // render began. The teardown still deposits its snapshot, which is still the
  // right thing to have there for whoever comes back next.
  const cached = readFeedCache(key);

  if (activeTeardown) activeTeardown(); // clean up a feed instance we're replacing
  activeTeardown = teardown;
  const stopLeaving = onLeavingScreen(teardown);

  // Where the reader was a moment ago, and what they were asking for there.
  const from = previousScreen() || "";
  const wasSearching =
    new URLSearchParams(from.split("?")[1] || "").get("search")?.trim() || "";

  /**
   * Is this the same screen still, showing a different answer?
   *
   * Pressing Warmest is not going anywhere. The header does not change, the
   * masthead does not change, the bar you pressed does not change — the list
   * under it does, and that is the whole of it. But it arrives here as a
   * hashchange like any other, so it used to be served like any other: the
   * page-level view transition faded and raised every pixel of the screen, and
   * the whole `.feed` section was rebuilt underneath it. Both are sentences
   * about having gone somewhere, and nobody went anywhere.
   *
   * The route is what settles it, not the DOM. `.feed` is also worn by the
   * profile and by the notifications screen — both of which *are* journeys and
   * must keep their transition — so asking "is a .feed on screen?" would
   * quietly answer yes for two screens this must not touch. Asking where the
   * reader came from cannot: only the feed's own address matches, with or
   * without a query on it.
   */
  const sameScreen = /^#\/(\?.*)?$/.test(from);

  /**
   * ...and is it the same posts, only in a different order?
   *
   * This is the narrower question, and it is the one that decides whether the
   * list already on screen can be left there while the new one is fetched —
   * which is what replaces the five skeleton cards that used to flash for a
   * sixth of a second every time somebody pressed Warmest.
   *
   * It has to be narrower, because a held list is a *live* list: it is still
   * clickable, still keyboard-reachable, still what `knownPosts` describes. On
   * a re-order that is honest — the same posts are in both lists, so a card
   * pressed during the wait opens a post that genuinely is in the list, and
   * "More from the feed" at the bottom of it is true.
   *
   * On a search it is not. Type "kettle" and the posts that answer it are a
   * different set; holding the previous ones would leave the reader looking at,
   * and able to open, results that do not match what they just typed — and the
   * post they landed on would offer to walk them through a list they had
   * already left. So a search change keeps its skeletons, which are the honest
   * thing to show when the answer genuinely isn't known yet. It still loses the
   * page-level transition, because it is still the same screen.
   */
  const reordering = sameScreen && wasSearching === search;

  /**
   * ...and did the reader ask for it from the bar, where they can see it?
   *
   * This is what decides whether the page moves. A re-order is the one swap
   * where the reader's position is still theirs — they have not gone anywhere,
   * so neither should the page — and it used to be the swap that moved them
   * furthest, in whichever direction happened to be wrong:
   *
   *   · Up, on an order this visit hasn't seen. mountView's default is the top,
   *     because that is where an arrival goes, and the bar sits far enough down
   *     a phone's masthead that reaching it means scrolling — so pressing
   *     Warmest threw the reader three or four hundred pixels up the page and
   *     left the bar they had just pressed off-screen above them.
   *   · Down, on an order they had been on before, which has a cache entry with
   *     a scroll position in it. That position is where they were when they
   *     *left* that order, possibly minutes and a post screen ago. Restoring it
   *     is exactly right coming back from a post and exactly wrong here.
   *
   * The press is the other half because `reordering` alone is also true of the
   * brand's "fresh feed" — see takeOrderPress. Called unconditionally so the
   * stamp is always spent, whether or not this render is the one it belongs to.
   */
  const pressedTheBar = takeOrderPress();
  const holdingPlace = reordering && pressedTheBar;

  /**
   * Put this screen on the page, once.
   *
   * There are three callers and two of them race — the timer that gives up
   * waiting, and the fetch that lands — so the guard is the point. `isStale`
   * is the other half: while the screen is being held back the reader can
   * leave, and mounting then would paint this list over whatever they went to.
   *
   * @param {{ restoreScroll?: number }} [options]
   */
  let shown = false;
  function show(options = {}) {
    if (shown || isStale()) return;
    shown = true;
    // "none", not false: false is still an arrival and still animates. See
    // mountView.
    mountView(root, {
      ...options,
      // Overriding whatever the caller asked for, including the cache's
      // remembered position: on a re-order the reader's own position is newer
      // than both, and it is the only one that is still about them.
      restoreScroll: holdingPlace ? "keep" : options.restoreScroll,
      transition: sameScreen ? "none" : true,
    });
    // After the mount, always. The sentinel has to be in the document for the
    // observer to have anything to say about it.
    setupObserver();
  }

  if (cached) {
    // The anchor comes back with the rest of it: without it, the next page
    // fetched after a cache restore would be counted from a feed that had
    // moved on since.
    ({ page, pages, hasNext, total, viewer, anchor } = cached);
    appendPosts(list, cached.items);
    setKnownPosts(items, listName);
    renderTail();
    show({ restoreScroll: cached.scrollY });
  } else if (reordering) {
    // The screen this is replacing is this screen, holding the same posts.
    // Build the new one out of sight and leave the old one where it is until
    // there is something to put in its place — see the note on `reordering`.
    //
    // `list` is not in the document yet, so the skeletons load() puts in it
    // cost a few nodes nobody sees. They are still worth putting there: if the
    // answer is slow, the timer below mounts what exists at that moment, and
    // what exists is a screen already wearing its loading state.
    const late = setTimeout(() => show(), SKELETON_AFTER);
    load(true).finally(() => {
      clearTimeout(late);
      show();
    });
  } else {
    show();
    load(true);
  }

  // Any return-morph still pending by now belongs to a post that isn't on this
  // page — a stale name would animate a title in from nothing.
  forgetReturn();
}
