// @ts-check
// What has been said to you (#/notifications).
//
// The same column and the same rules as the feed, because it is the same kind
// of screen: a list that belongs to one person, newest first, paged. What it
// drops is the search and the cards; what it adds is that arriving here marks
// everything read.
//
// ── why opening it is what marks them ────────────────────────────────────
// A badge exists to say "there is something new". A badge that goes on saying
// so after you have looked is a badge people stop believing, and the app then
// has to invent a second, louder way of getting attention. Marking on arrival
// is also the only rule that needs no interface: no button, no swipe, nothing
// to explain.
//
// It marks *everything*, not only what is on the first page. The alternative —
// scroll to clear — means the count depends on how far somebody happened to
// scroll, which is a number nobody can predict and therefore nobody trusts.

import { api, ApiError } from "../api.js";
import { h, mountView, relativeTime } from "../ui.js";
import { get } from "../store.js";
import { navigate, onLeavingScreen } from "../router.js";
import { markAllSeen, refreshUnread } from "../notify.js";

const PAGE_SIZE = 20;
const PREFETCH_MARGIN = 700;

let activeTeardown = null;

/** One line: who, what they did, a piece of what they said, and where. */
function notificationRow(row) {
  const said =
    row.kind === "reply" ? "replied to you" : "commented on your post";

  return h(
    "li",
    { class: "notice" + (row.read_at ? "" : " notice--unread") },
    h(
      "a",
      {
        class: "notice__link",
        href: `#/posts/${row.post.id}`,
        // The whole row is the target. A line with a link buried in it is a
        // line somebody has to aim at; this way the whole thing is the button,
        // which on a phone is the difference between one tap and three.
      },
      h(
        "p",
        { class: "notice__who" },
        h("strong", {}, row.actor.username),
        ` ${said}`
      ),
      // What they actually said. Without it the line is "somebody replied to
      // you", which tells you nothing you can decide anything with — the first
      // few words are what makes it worth opening or not.
      h("p", { class: "notice__said" }, row.excerpt),
      h(
        "p",
        { class: "notice__where" },
        "on ",
        h("span", { class: "notice__post" }, row.post.title),
        " ",
        h("time", { datetime: row.created_at }, relativeTime(row.created_at))
      )
    )
  );
}

export function renderNotifications({ isStale }) {
  if (!get("session")) return navigate("/login");

  const list = h("ol", { class: "notices", role: "list" });
  const status = h("p", { class: "feed__status", hidden: true });
  const sentinel = h("div", { class: "feed__sentinel", "aria-hidden": "true" });

  const root = h(
    "section",
    { class: "feed notifications", "aria-label": "Notifications" },
    h(
      "header",
      { class: "shelf__head" },
      h("h1", { class: "shelf__title" }, "Said to you"),
      h(
        "p",
        { class: "shelf__line" },
        "Replies to your comments, and comments on your posts."
      )
    ),
    list,
    status,
    sentinel
  );

  let page = 0,
    pages = 1,
    hasNext = true,
    total = null;
  let loading = false,
    controller = null,
    observer = null;

  const setStatus = (text, pad) => {
    status.textContent = text || "";
    status.hidden = !text;
    status.classList.toggle("feed__status--pad", !!pad);
  };

  function renderTail() {
    if (total === 0) {
      // An invitation rather than a shrug — and an honest one: the way to be
      // talked to is to say something first.
      setStatus("Nothing yet. Say something on a post and this is where the answers land.", true);
    } else if (!hasNext) {
      setStatus("That's everything.");
    } else {
      setStatus("");
    }
  }

  async function load(initial) {
    if (loading || (!initial && !hasNext)) return;
    loading = true;
    let landed = false;
    if (controller) controller.abort();
    controller = new AbortController();
    const wantPage = page + 1;

    try {
      const qs = new URLSearchParams({
        page: String(wantPage),
        page_size: String(PAGE_SIZE),
      });
      const data = await api.get(`/notifications/?${qs}`, {
        signal: controller.signal,
      });
      if (isStale()) return;

      ({ page, pages, has_next: hasNext, total } = data);
      if (initial) list.replaceChildren();
      const frag = document.createDocumentFragment();
      data.items.forEach((row) => frag.append(notificationRow(row)));
      list.append(frag);
      renderTail();
      landed = true;
    } catch (err) {
      if (err.name === "AbortError" || isStale()) return;
      if (err instanceof ApiError && err.status === 401) return;
      setStatus("Couldn't load these. Reload to try again.", true);
    } finally {
      loading = false;
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
  load(true);

  // The lamp goes out now rather than when the request answers: the reader is
  // looking at the list, so the badge is already wrong. The write follows, and
  // if it fails the next poll puts the number back — which is the right way
  // round, because a count that is briefly too low is a smaller lie than a
  // badge that will not go away.
  markAllSeen();
  api
    .post("/notifications/read", undefined)
    .catch(() => refreshUnread());
}
