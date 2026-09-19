// @ts-check
// Feed (#/) — public. A stream of post cards, newest first, with a debounced
// title search (driven from the header) and infinite scroll. Coming back from a
// post restores the list and scroll position from a short-lived cache.

import { api } from "../api.js";
import { h, mountView, skeletonCards, postCard, toast, leavingScrollY } from "../ui.js";
import {
  get,
  isMine,
  cacheFeed,
  readFeedCache,
  viewerKey,
  setKnownPosts,
} from "../store.js";
import { isNewSince, lastVisit, sinceLabel, spellCount } from "../reading.js";
import { onLeavingScreen } from "../router.js";
import { forgetReturn } from "../transitions.js";
import { IS_DEMO } from "../config.js";
import { demoNote } from "../demo/strip.js";

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

/** @param {string} current */
function sortbar(current) {
  return h(
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
  const status = h("p", { class: "feed__status", hidden: true });
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
    { class: "feed", "aria-label": search ? `Posts matching ${search}` : "Latest posts" },
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
  let newCount = 0, boundaryFound = false;
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
  let page = 0, pages = 1, hasNext = true, total = null;
  let loading = false, controller = null, observer = null, errorBox = null;
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
    errorBox = h("div", { class: "feed__error" },
      h("p", {}, page === 0 ? "The feed didn't load." : "Couldn't load more."),
      h("button", { class: "btn btn--ghost", type: "button", onclick: retry }, "Try again"));
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
      const qs = new URLSearchParams({ page: String(wantPage), page_size: String(PAGE_SIZE) });
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
      cacheFeed({ key, viewer, items: items.slice(), page, pages, hasNext, total, anchor, scrollY: leavingScrollY() });
    }
  }

  if (activeTeardown) activeTeardown(); // clean up a feed instance we're replacing
  activeTeardown = teardown;
  const stopLeaving = onLeavingScreen(teardown);

  const cached = readFeedCache(key);
  if (cached) {
    // The anchor comes back with the rest of it: without it, the next page
    // fetched after a cache restore would be counted from a feed that had
    // moved on since.
    ({ page, pages, hasNext, total, viewer, anchor } = cached);
    appendPosts(list, cached.items);
    setKnownPosts(items, listName);
    renderTail();
    mountView(root, { restoreScroll: cached.scrollY });
    setupObserver();
  } else {
    mountView(root);
    setupObserver();
    load(true);
  }

  // Any return-morph still pending by now belongs to a post that isn't on this
  // page — a stale name would animate a title in from nothing.
  forgetReturn();
}
