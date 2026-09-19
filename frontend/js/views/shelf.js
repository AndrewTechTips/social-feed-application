// @ts-check
// The shelf (#/shelf) — the posts you put aside, newest save first.
//
// A feed with your saves in it, the same way a profile is a feed with one
// author in it: same column, same cards, same infinite scroll. What it adds is
// a heading saying whose it is and where it's kept; what it drops is the
// search, because you already chose everything on it.
//
// The one real difference is where the list comes from. There is no endpoint
// behind this — js/shelf.js holds ids in localStorage — so a page here is ten
// `GET /posts/{id}` calls rather than one call for ten posts. That is the price
// of the ids-not-snapshots decision written down in js/shelf.js, and it buys a
// shelf that is never showing a title somebody has since changed or a post they
// have since deleted.

import { api, ApiError } from "../api.js";
import { h, mountView, skeletonCards, postCard } from "../ui.js";
import { setKnownPosts } from "../store.js";
import { shelfIds, dropFromShelf } from "../shelf.js";
import { onLeavingScreen } from "../router.js";
import { forgetReturn } from "../transitions.js";

const PAGE_SIZE = 10;
const PREFETCH_MARGIN = 700;

// Only one instance should own the observer at a time — same rule as the feed
// and the profile, for the same reason.
let activeTeardown = null;

export function renderShelf({ isStale }) {
  // Read once, at the top. The list can change underneath this screen — the
  // save control on a post is one hashchange away — and a page that re-read it
  // between pages would paginate through a list that had moved.
  const ids = shelfIds();

  const list = h("div", { class: "feed__list" });
  const status = h("p", { class: "feed__status", hidden: true });
  const sentinel = h("div", { class: "feed__sentinel", "aria-hidden": "true" });

  const heading = h(
    "header",
    { class: "shelf__head" },
    h("h1", { class: "shelf__title" }, "Your shelf"),
    // The privacy fact, said where somebody is looking at the thing it applies
    // to rather than only in a README they will never open.
    h("p", { class: "shelf__line" }, "Kept in this browser, and nowhere else.")
  );

  const root = h(
    "section",
    { class: "feed shelf", "aria-label": "Your shelf" },
    heading,
    list,
    status,
    sentinel
  );

  const items = [];
  let cursor = 0;
  let loading = false, controller = null, observer = null, errorBox = null;

  const moreToFetch = () => cursor < ids.length;

  function setStatus(text, pad) {
    status.textContent = text || "";
    status.hidden = !text;
    status.classList.toggle("feed__status--pad", !!pad);
  }

  function renderTail() {
    if (!items.length && !moreToFetch()) {
      setStatus("Nothing here yet. Open a post and press Save to keep it for later.", true);
    } else if (!moreToFetch()) {
      setStatus("That's everything you've saved.");
    } else {
      setStatus("");
    }
  }

  /** @param {number} rewindTo */
  function showError(rewindTo) {
    list.querySelectorAll(".card--skeleton").forEach((n) => n.remove());
    setStatus("");
    if (errorBox) return;
    const retry = () => {
      errorBox.remove();
      errorBox = null;
      cursor = rewindTo;
      load(false);
    };
    errorBox = h(
      "div",
      { class: "feed__error" },
      h("p", {}, "Some of your saved posts didn't load."),
      h("button", { class: "btn btn--ghost", type: "button", onclick: retry }, "Try again")
    );
    root.append(errorBox);
  }

  async function load(initial) {
    if (loading || !moreToFetch()) return;
    loading = true;
    let landed = false;
    if (controller) controller.abort();
    controller = new AbortController();
    const from = cursor;
    const slice = ids.slice(cursor, cursor + PAGE_SIZE);
    cursor += slice.length;

    if (initial) list.replaceChildren(skeletonCards(Math.min(slice.length, 4)));

    try {
      // All at once rather than one after another: they are independent, and a
      // shelf that fetched ten posts in series would take ten round trips to
      // draw what the feed draws in one.
      //
      // Each rejection is folded into a value so that one missing post can't
      // take the page with it — which is the whole point, because a missing
      // post is the *expected* case here. The shelf outlives what's on it.
      const settled = await Promise.all(
        // One shape either way, rather than two. A union of {post} and {error}
        // reads well and then has to be narrowed at every use; this is the
        // same information with one less thing for the reader to carry.
        slice.map((id) =>
          api
            .get(`/posts/${id}`, { signal: controller.signal })
            .then(
              (post) => ({ post, error: null, id }),
              (error) => ({ post: null, error, id })
            )
        )
      );
      if (isStale()) return;

      if (initial) {
        list.replaceChildren();
        items.length = 0;
      }

      let failed = 0;
      const frag = document.createDocumentFragment();
      for (const result of settled) {
        if (result.post) {
          items.push(result.post);
          frag.append(postCard(result.post));
          continue;
        }
        const { error, id } = result;
        if (error && error.name === "AbortError") return;
        // 404 is the ordinary ending for a saved post: it was deleted, or it
        // was a draft that has been unpublished and is no longer yours to see.
        // Dropping it is the only honest thing to do — leaving it would mean a
        // shelf that keeps offering a door to a room that isn't there.
        if (error instanceof ApiError && error.status === 404) dropFromShelf(id);
        else failed++;
      }
      list.append(frag);
      setKnownPosts(items, "your shelf");
      renderTail();
      if (failed) showError(from);
      landed = true;
    } catch (err) {
      if (err.name === "AbortError" || isStale()) return;
      showError(from);
    } finally {
      loading = false;
      // Same re-arm the feed does, for the reason written down there.
      if (landed && moreToFetch() && !isStale()) rearm();
    }
  }

  function setupObserver() {
    observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && load(false),
      { rootMargin: `${PREFETCH_MARGIN}px 0px` }
    );
    observer.observe(sentinel);
  }

  // See the note on the feed's rearm(); this list has the same observer and
  // therefore the same way of quietly stopping.
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
    if (observer) observer.disconnect();
    if (controller) controller.abort();
  }

  if (activeTeardown) activeTeardown();
  activeTeardown = teardown;
  const stopLeaving = onLeavingScreen(teardown);

  mountView(root);
  setupObserver();
  if (ids.length) load(true);
  else renderTail();

  // Not the feed, so a morph waiting for a feed card has nowhere to land.
  forgetReturn();
}
