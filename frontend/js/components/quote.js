// @ts-check
// Select a passage, take it with you.
//
// Borrowed from Medium, and it fits a reading app better than it fits Medium:
// the thing people do with a good paragraph is repeat it somewhere else, and
// the alternative is copying the words and then going back for the address.
//
// **A mouse only.** On a touch screen the operating system already puts Copy,
// Look Up and Share above a selection, with two drag handles either side of it,
// and a button of ours would be competing with all of that for the same forty
// pixels — and losing, because theirs can do more. So the control appears
// under `(hover: hover) and (pointer: fine)` and nowhere else. That is a rule
// in CSS rather than a branch here: the button is built either way, and the
// stylesheet decides whether it is ever seen.
//
// Wired once from main.js, and it finds the post in the DOM at the moment a
// selection happens rather than being handed one. Same arrangement as the feed
// keys, and for the same reason — a component with no lifecycle cannot leak one.

import { h } from "../dom.js";
import { toast } from "../toast.js";

const CONTENT = ".detail__content";

// Long enough that a stray double-click doesn't put a button up, short enough
// that a single memorable sentence still counts.
const MIN_LENGTH = 12;

// How long after the selection stops moving before the button appears. It
// exists for the keyboard: shift-arrow fires selectionchange on every
// keystroke, and a control that flickered in and out of the corner of your eye
// while you were still choosing the words would be worse than none.
const SETTLE_MS = 150;

export function wireQuote() {
  const button = h(
    "button",
    { class: "quote-copy", type: "button", hidden: true },
    "Copy quote"
  );

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let dragging = false;

  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    button.hidden = true;
  };

  /** The selection, if it is one worth offering to copy. */
  function usable() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (text.length < MIN_LENGTH) return null;

    const content = document.querySelector(CONTENT);
    if (!content) return null;
    // Both ends inside the post. A selection that started in the byline and
    // ended in the body is not a quote from anything.
    if (
      !content.contains(selection.anchorNode) ||
      !content.contains(selection.focusNode)
    ) {
      return null;
    }
    return { text, rect: selection.getRangeAt(0).getBoundingClientRect(), content };
  }

  function place() {
    timer = null;
    const found = usable();
    if (!found) return hide();

    // Positioned against .detail rather than the viewport, so it travels with
    // the page instead of hanging in front of it and needing a scroll listener
    // to chase.
    const host = found.content.closest(".detail");
    if (!(host instanceof HTMLElement)) return hide();

    // Moved into place in the DOM as well as on screen: the button belongs
    // after the passage it is about, so Tab reaches it from a selection made
    // with the keyboard instead of finding it at the end of the document.
    if (button.previousElementSibling !== found.content) found.content.after(button);

    const box = host.getBoundingClientRect();
    button.hidden = false;
    const x = found.rect.left + found.rect.width / 2 - box.left;
    const y = found.rect.top - box.top;
    // Clamped so a passage selected at the very top of a post doesn't put the
    // button above the page, and one selected at the edge doesn't hang off it.
    const half = button.offsetWidth / 2 + 4;
    button.style.left = `${Math.min(Math.max(x, half), box.width - half)}px`;
    button.style.top = `${Math.max(y, button.offsetHeight + 8)}px`;
  }

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(place, SETTLE_MS);
  };

  // While the mouse is down the selection is still being drawn, so there is
  // nothing to offer yet and a button under the cursor would be in the way.
  addEventListener("mousedown", (e) => {
    if (e.target === button) return;
    dragging = true;
    hide();
  });
  addEventListener("mouseup", () => {
    dragging = false;
    schedule();
  });
  document.addEventListener("selectionchange", () => {
    if (dragging) return hide();
    schedule();
  });

  button.addEventListener("click", async () => {
    const found = usable();
    if (!found) return hide();
    const title = document.querySelector(".detail__title")?.textContent || "";

    // Typographic quotes and an em dash, because this is going into somebody
    // else's writing and the app's own type would be embarrassed by "straight
    // quotes". The address is the page's own — in demo mode that includes the
    // query that makes it the demo, which is the honest thing to hand somebody.
    const quoted = `“${found.text}”\n\n— ${title}, ${location.href}`;
    try {
      await navigator.clipboard.writeText(quoted);
      toast("Quote copied.");
    } catch (e) {
      // The clipboard needs a secure context and, in some browsers, permission.
      // Say so rather than failing silently — the same answer the palette's
      // copy-link row gives.
      toast("Couldn't copy that.");
    }
    hide();
  });

  // Somewhere to live until a selection moves it next to a post.
  document.body.append(button);
}
