// @ts-check
// Feed (#/) — public. A stream of post cards, newest first, with a debounced
// title search (driven from the header) and infinite scroll. Coming back from a
// post restores the list and scroll position from a short-lived cache.

import { api } from "../api.js";
import { h, mountView, skeletonCards, postCard } from "../ui.js";
import { get, cacheFeed, readFeedCache, viewerKey, setKnownPosts } from "../store.js";
import { forgetReturn } from "../transitions.js";
import { IS_DEMO } from "../config.js";
import { demoNote } from "../demo/strip.js";

const PAGE_SIZE = 10;
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
    IS_DEMO ? demoNote() : null
  );
}

export function renderFeed({ query, isStale }) {
  const search = (query.get("search") || "").trim();
  const key = search.toLowerCase();

  const list = h("div", { class: "feed__list" });
  const status = h("p", { class: "feed__status", hidden: true });
  const sentinel = h("div", { class: "feed__sentinel", "aria-hidden": "true" });
  // Not while searching: at that point the reader is looking for something
  // specific and an introduction is in the way.
  const showMasthead = !get("session") && !search;

  const root = h(
    "section",
    { class: "feed", "aria-label": search ? `Posts matching ${search}` : "Latest posts" },
    showMasthead ? masthead() : null,
    list,
    status,
    sentinel
  );

  const items = [];
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

  function renderTail() {
    if (total === 0) {
      setStatus(
        search
          ? `Nothing matches "${search}".`
          : "Nothing here yet. Be the first to say something.",
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
      const data = await api.get(`/posts/?${qs}`, { signal: controller.signal });
      if (isStale()) return;

      ({ page, pages, has_next: hasNext, total } = data);
      viewer = viewerKey();
      if (initial) {
        list.replaceChildren();
        items.length = 0;
      }

      const frag = document.createDocumentFragment();
      data.items.forEach((post) => {
        items.push(post);
        frag.append(postCard(post));
      });
      list.append(frag);
      setKnownPosts(items);
      renderTail();
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
    removeEventListener("hashchange", teardown);
    if (observer) observer.disconnect();
    if (controller) controller.abort();
    if (items.length) {
      cacheFeed({ key, viewer, items: items.slice(), page, pages, hasNext, total, scrollY: window.scrollY });
    }
  }

  if (activeTeardown) activeTeardown(); // clean up a feed instance we're replacing
  activeTeardown = teardown;
  addEventListener("hashchange", teardown);

  const cached = readFeedCache(key);
  if (cached) {
    ({ page, pages, hasNext, total, viewer } = cached);
    cached.items.forEach((post) => {
      items.push(post);
      list.append(postCard(post));
    });
    setKnownPosts(items);
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
