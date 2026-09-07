// Feed (#/) — public. A stream of post cards, newest first, with a debounced
// title search (driven from the header) and infinite scroll. Coming back from a
// post restores the list and scroll position from a short-lived cache.

import { api } from "../api.js";
import { h, mountView, skeletonCards, avatar, relativeTime, voteControl } from "../ui.js";
import { cacheFeed, readFeedCache } from "../store.js";

const PAGE_SIZE = 10;
const FIRST_SKELETONS = 5;
const STAGGER = 40; // ms between card entrances
const STAGGER_CAP = 8;

// Only one feed instance should own the observer + hashchange listener at a time.
let activeTeardown = null;

const authorName = (email) => String(email || "").split("@")[0];

function preview(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > 280 ? t.slice(0, 280).trimEnd() + "…" : t;
}

export function renderFeed({ query, isStale }) {
  const search = (query.get("search") || "").trim();
  const key = search.toLowerCase();

  const list = h("div", { class: "feed__list" });
  const status = h("p", { class: "feed__status", hidden: true });
  const sentinel = h("div", { class: "feed__sentinel", "aria-hidden": "true" });
  const root = h(
    "section",
    { class: "feed", "aria-label": search ? `Posts matching ${search}` : "Latest posts" },
    list,
    status,
    sentinel
  );

  const items = [];
  let page = 0, pages = 1, hasNext = true, total = null;
  let loading = false, controller = null, observer = null, errorBox = null;

  function setStatus(text, pad) {
    status.textContent = text || "";
    status.hidden = !text;
    status.classList.toggle("feed__status--pad", !!pad);
  }

  function cardEl(post, idx) {
    const link = h("a", { class: "card__link", href: `#/posts/${post.id}` },
      h("h2", { class: "card__title" }, post.title),
      h("p", { class: "card__preview" }, preview(post.content)));

    const meta = h("div", { class: "card__meta" },
      avatar(post.user.email, "sm"),
      h("span", { class: "card__author", title: post.user.email }, authorName(post.user.email)),
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("time", { datetime: post.created_at }, relativeTime(post.created_at)),
      post.published ? null : h("span", { class: "tag" }, "Draft"));

    const card = h("article", { class: "card" },
      voteControl(post),
      h("div", { class: "card__body" }, link, meta));

    if (idx != null) {
      card.classList.add("card--in");
      card.style.setProperty("--d", Math.min(idx, STAGGER_CAP) * STAGGER + "ms");
      card.addEventListener("animationend", () => {
        card.classList.remove("card--in");
        card.style.removeProperty("--d");
        card.style.removeProperty("will-change");
      }, { once: true });
    }
    return card;
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
    if (controller) controller.abort();
    controller = new AbortController();
    const wantPage = page + 1;

    if (initial) list.replaceChildren(skeletonCards(FIRST_SKELETONS));

    try {
      const qs = new URLSearchParams({ page: wantPage, page_size: PAGE_SIZE });
      if (search) qs.set("search", search);
      const data = await api.get(`/posts/?${qs}`, { signal: controller.signal });
      if (isStale()) return;

      ({ page, pages, has_next: hasNext, total } = data);
      if (initial) {
        list.replaceChildren();
        items.length = 0;
      }

      const frag = document.createDocumentFragment();
      data.items.forEach((post, i) => {
        items.push(post);
        frag.append(cardEl(post, i));
      });
      list.append(frag);
      renderTail();
    } catch (err) {
      if (err.name === "AbortError" || isStale()) return;
      showError();
    } finally {
      loading = false;
    }
  }

  function setupObserver() {
    observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && load(false),
      { rootMargin: "700px 0px" }
    );
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
      cacheFeed({ key, items: items.slice(), page, pages, hasNext, total, scrollY: window.scrollY });
    }
  }

  if (activeTeardown) activeTeardown(); // clean up a feed instance we're replacing
  activeTeardown = teardown;
  addEventListener("hashchange", teardown);

  const cached = readFeedCache(key);
  if (cached) {
    ({ page, pages, hasNext, total } = cached);
    cached.items.forEach((post) => {
      items.push(post);
      list.append(cardEl(post, null));
    });
    renderTail();
    mountView(root, { restoreScroll: cached.scrollY });
    setupObserver();
  } else {
    mountView(root);
    setupObserver();
    load(true);
  }
}
