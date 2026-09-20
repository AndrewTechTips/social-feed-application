// @ts-check
// Profile (#/u/:username) — public. Everything one person has written.
//
// Deliberately the same list as the feed, built from the same cards: a profile
// is a feed with one author in it, not a different kind of page. What it adds
// is a heading saying whose it is, and what it drops is the search — you're
// already looking at a filter.

import { api, ApiError } from "../api.js";
import { h, skeletonCards } from "../dom.js";
import { avatar } from "../format.js";
import { leavingScrollY, mountView } from "../view.js";
import { postCard } from "../components/card.js";
import { get, setKnownPosts, cacheFeed, readFeedCache, viewerKey } from "../store.js";
import { onLeavingScreen } from "../router.js";
import { forgetReturn } from "../transitions.js";

const PAGE_SIZE = 10;
const FIRST_SKELETONS = 4;
// Mirrors the feed's, for the reason written down there.
const PREFETCH_MARGIN = 700;

// Only one profile instance should own the observer at a time — same rule as
// the feed, for the same reason.
let activeTeardown = null;

export function renderProfile({ params, isStale }) {
  const username = params.username;

  const list = h("div", { class: "feed__list" });
  const status = h("p", { class: "feed__status", hidden: true });
  const sentinel = h("div", { class: "feed__sentinel", "aria-hidden": "true" });

  const heading = h(
    "header",
    { class: "profile__head" },
    avatar(username, "lg"),
    h(
      "div",
      { class: "stack" },
      h("h1", { class: "profile__name" }, username),
      h("p", { class: "profile__count" }, " "),
      // Only on your own. This is the screen somebody is on when they are
      // thinking about themselves, which makes it the one place a link to the
      // account screen is where you would have looked for it — the header is
      // full, and the masthead that carries the colophon link is shown to
      // signed-out visitors only.
      get("session")?.username === username.toLowerCase()
        ? h(
            "p",
            { class: "profile__more" },
            h("a", { href: "#/settings" }, "Your account")
          )
        : null
    )
  );

  const root = h(
    "section",
    { class: "feed profile", "aria-label": `Posts by ${username}` },
    heading,
    list,
    status,
    sentinel
  );

  // Namespaced, because this shares the cache with the feed and with search.
  // A profile whose key collided with a set of results would restore the wrong
  // list under the right heading, which is the kind of bug that looks like a
  // caching problem and is actually a naming one.
  const key = `u/${username.toLowerCase()}`;
  let viewer = viewerKey();

  const items = [];
  let page = 0,
    pages = 1,
    hasNext = true,
    total = null;
  let loading = false,
    controller = null,
    observer = null,
    errorBox = null;

  const countLine = heading.querySelector(".profile__count");

  function setStatus(text, pad) {
    status.textContent = text || "";
    status.hidden = !text;
    status.classList.toggle("feed__status--pad", !!pad);
  }

  function renderTail() {
    if (total === 0) {
      const session = get("session");
      const mine = session?.username === username;
      // Yours says what to do with the space; somebody else's says whose
      // space it is. "Nothing here yet" on a stranger's profile reads like the
      // page failed to load, which for a moment is exactly what it looks like.
      setStatus(
        mine
          ? "You haven't written anything yet. Whatever you post will collect here."
          : `${username} hasn't posted anything yet.`,
        true
      );
    } else if (!hasNext) {
      setStatus("That's everything.");
    } else {
      setStatus("");
    }
  }

  function paintCount() {
    if (total == null) return;
    countLine.textContent = total === 1 ? "1 post" : `${total.toLocaleString()} posts`;
  }

  function showError(message) {
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
      h("p", {}, message),
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
      const data = await api.get(`/users/${encodeURIComponent(username)}/posts?${qs}`, {
        signal: controller.signal,
      });
      if (isStale()) return;

      ({ page, pages, has_next: hasNext, total } = data);
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
      setKnownPosts(items, username);
      paintCount();
      renderTail();
      landed = true;
    } catch (err) {
      if (err.name === "AbortError" || isStale()) return;
      if (err instanceof ApiError && err.status === 404) {
        // Nobody by that name — say so where the list would have been.
        heading.remove();
        list.replaceChildren();
        setStatus(`There's nobody here called ${username}.`, true);
        return;
      }
      showError("Couldn't load these posts.");
    } finally {
      loading = false;
      // Same re-arm the feed does, for the same reason and with the same
      // caveat about the error path — see the long note in views/feed.js.
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
    // Same bargain the feed makes: hold the page you were on so that coming
    // back from a post lands you where you left rather than at the top of a
    // list you have already read. No `anchor` — that is the feed's stable
    // pagination window, and a profile has no live insertions to be stable
    // against.
    if (items.length) {
      cacheFeed({
        key,
        viewer,
        items: items.slice(),
        page,
        pages,
        hasNext,
        total,
        anchor: null,
        scrollY: leavingScrollY(),
      });
    }
  }

  if (activeTeardown) activeTeardown();
  activeTeardown = teardown;
  const stopLeaving = onLeavingScreen(teardown);

  const cached = readFeedCache(key);
  if (cached) {
    ({ page, pages, hasNext, total, viewer } = cached);
    cached.items.forEach((post) => {
      items.push(post);
      list.append(postCard(post));
    });
    setKnownPosts(items, username);
    paintCount();
    renderTail();
    mountView(root, { restoreScroll: cached.scrollY });
    setupObserver();
  } else {
    mountView(root);
    setupObserver();
    load(true);
  }

  // A profile isn't the feed, so a morph waiting for a feed card has nowhere
  // to land.
  forgetReturn();
}
