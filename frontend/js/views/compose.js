// @ts-check
// Compose (#/compose) and Edit (#/posts/:id/edit). New posts POST; edits PATCH
// only the fields that actually changed. Both are pessimistic — the button waits
// for the server before we move on.

import { api } from "../api.js";
import { h, mountView, toast } from "../ui.js";
import { readingMinutes } from "../reading.js";
import { get, isMine, dropFeedCache } from "../store.js";
import { navigate, onLeavingScreen } from "../router.js";
import { readDraft, saveDraft, clearDraft } from "../draft.js";

const TITLE_MAX = 120;
const CONTENT_MAX = 5000;
const field = (id, label, control, err) =>
  h("div", { class: "field" }, h("label", { class: "field__label", for: id }, label), control, err);

/**
 * @param {object} spec
 * @param {"new" | "edit"} spec.mode
 * @param {import("../types.js").Post} [spec.post]  the post being edited
 */
function buildForm({ mode, post }) {
  const editing = mode === "edit";
  const start = post || { title: "", content: "", published: true };
  // Every read of `edited` below sits behind `editing`, and renderEdit is the
  // only caller that sets mode to "edit" — it loads the post first and bails
  // if it can't. The cast states that pairing once instead of asking five call
  // sites to re-check it.
  const edited = /** @type {import("../types.js").Post} */ (post);

  const title = h("input", {
    id: "post-title", class: "input title-input", type: "text",
    maxlength: String(TITLE_MAX + 20), placeholder: "A title",
    value: start.title, "aria-describedby": "title-err",
  });
  const titleErr = h("p", { class: "field__error", id: "title-err", role: "alert" });

  const content = h("textarea", {
    id: "post-content", class: "textarea",
    placeholder: "Say what you're thinking.", "aria-describedby": "content-err",
  });
  content.value = start.content;
  const contentErr = h("p", { class: "field__error", id: "content-err", role: "alert" });

  // What you have written, in the terms the card will describe it in.
  //
  // It used to be `1,234 / 5,000`, which answers a question nobody has until
  // they are near the limit — and for the whole of a normal post it is a
  // number counting up towards a wall. Words and minutes are what the writing
  // is actually made of, and `readingMinutes` is the same function the card
  // and the post screen call, so the figure here is the figure a reader will
  // be shown rather than an estimate that happens to agree.
  //
  // The character count is not gone; it appears when it starts to matter.
  const counter = h("span", { class: "counter", "aria-live": "off" });
  const limit = h("span", { class: "counter counter--limit", hidden: true });

  // Ten per cent short of the wall, which is about four hundred characters —
  // far enough ahead that there is still time to cut a paragraph rather than a
  // sentence.
  const LIMIT_NEAR = CONTENT_MAX * 0.9;

  const paintCounter = () => {
    const text = content.value;
    const n = text.length;
    const words = text.trim().split(/\s+/).filter(Boolean).length;

    counter.textContent = words
      ? `${words.toLocaleString()} ${words === 1 ? "word" : "words"}, about ${readingMinutes(text)} min`
      : "";

    limit.hidden = n < LIMIT_NEAR;
    limit.textContent = `${n.toLocaleString()} / ${CONTENT_MAX.toLocaleString()}`;
    limit.classList.toggle("counter--over", n > CONTENT_MAX);
  };
  content.addEventListener("input", paintCounter);
  paintCounter();

  const pub = h("input", { type: "checkbox", checked: start.published !== false });
  const pubText = h("span", {}, pub.checked ? "Publish now" : "Save as a draft");
  pub.addEventListener("change", () => {
    pubText.textContent = pub.checked ? "Publish now" : "Save as a draft";
  });
  const toggle = h("label", { class: "switch" },
    pub,
    h("span", { class: "switch__track" }, h("span", { class: "switch__thumb" })),
    pubText);

  // ── the draft you were part-way through ──────────────────────────────────
  // New posts only. An edit already has somewhere to keep its words, and the
  // one slot is for the thing that has nowhere else to be.
  const who = get("session")?.id ?? null;
  const restored = editing ? null : readDraft(who);
  const notice = h("div", { class: "compose__resumed", hidden: true });

  if (restored) {
    title.value = restored.title;
    content.value = restored.content;
    pub.checked = restored.published;
    pubText.textContent = pub.checked ? "Publish now" : "Save as a draft";
    paintCounter();

    const fresh = h(
      "button",
      { class: "btn btn--quiet", type: "button" },
      "Start fresh"
    );
    fresh.addEventListener("click", () => {
      clearDraft();
      title.value = "";
      content.value = "";
      paintCounter();
      notice.hidden = true;
      title.focus();
    });
    // Said plainly and without apology: something happened *for* the reader,
    // and the only question is whether they want it. role=status rather than
    // alert — it is good news about a form, not an error in one.
    notice.append(
      h("p", { class: "compose__resumed-line" }, "Picked up where you left off."),
      fresh
    );
    notice.hidden = false;
    notice.setAttribute("role", "status");
  }

  // Debounced, not per keystroke: writing to localStorage is synchronous and
  // parses JSON on the way in, and doing that inside the keydown of somebody
  // typing at speed is how a textarea starts to feel heavy. Half a second is
  // below the pause between sentences, so in practice nothing is ever more
  // than a phrase behind.
  const SAVE_AFTER = 500;
  let saveTimer = null;
  // Set the moment the post exists on the server. Without it, leaving the
  // composer after a successful post writes the draft straight back: the
  // textarea is still full, and the flush on the way out has no way of knowing
  // the words have a home now.
  let posted = false;
  const remember = () => {
    if (editing || posted) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveDraft(who, {
        title: title.value,
        content: content.value,
        published: pub.checked,
      });
    }, SAVE_AFTER);
  };
  title.addEventListener("input", remember);
  content.addEventListener("input", remember);
  pub.addEventListener("change", remember);

  // The tab going away is the case the debounce cannot cover, and it is also
  // the commonest way a draft was lost: a phone backgrounding the tab does not
  // fire unload and may never let it run again. pagehide fires while there is
  // still time, and visibilitychange covers the switch that never becomes one.
  const flush = () => {
    if (editing || posted) return;
    clearTimeout(saveTimer);
    saveDraft(who, {
      title: title.value,
      content: content.value,
      published: pub.checked,
    });
  };
  addEventListener("pagehide", flush);
  addEventListener("visibilitychange", flush);

  const submit = h("button", { class: "btn btn--primary", type: "submit" },
    editing ? "Save changes" : "Post");
  const cancel = h("a",
    { class: "btn btn--quiet", href: editing ? `#/posts/${edited.id}` : "#/" }, "Cancel");

  const form = h("form", { class: "compose", novalidate: true },
    h("h1", { class: "compose__title" }, editing ? "Edit your post" : "New post"),
    h("div", { class: "compose__panel" },
      notice,
      field("post-title", "Title", title, titleErr),
      field("post-content", "Body", content, contentErr),
      h("div", { class: "compose__row" }, toggle, counter, limit),
      h("div", { class: "compose__actions" }, cancel, submit)));

  let pending = false;
  const setPending = (on) => {
    pending = on;
    submit.disabled = on;
    cancel.setAttribute("aria-disabled", on ? "true" : "false");
    submit.textContent = on ? "Just a sec…" : editing ? "Save changes" : "Post";
  };

  function validate() {
    const t = title.value.trim();
    const c = content.value.trim();
    titleErr.textContent = !t
      ? "Give it a title."
      : t.length > TITLE_MAX
      ? `Keep the title under ${TITLE_MAX} characters.`
      : "";
    contentErr.textContent = !c
      ? "Write something first."
      : c.length > CONTENT_MAX
      ? "This is a bit long. Trim it down."
      : "";
    const bad = form.querySelector(".field__error:not(:empty)");
    if (bad) bad.previousElementSibling.focus();
    return !bad;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pending || !validate()) return;

    const next = {
      title: title.value.trim(),
      content: content.value.trim(),
      published: pub.checked,
    };
    setPending(true);
    try {
      if (editing) {
        const changed = {};
        for (const k of ["title", "content", "published"]) {
          if (next[k] !== start[k]) changed[k] = next[k];
        }
        if (!Object.keys(changed).length) {
          toast("Nothing changed.");
          return navigate(`/posts/${edited.id}`);
        }
        await api.patch(`/posts/${edited.id}`, changed);
        dropFeedCache();
        toast("Saved.");
        navigate(`/posts/${edited.id}`);
      } else {
        const created = await api.post("/posts/", next);
        // Only once the server has it. Clearing on submit would throw the
        // words away on the one path where they are most needed — the write
        // that didn't land.
        posted = true;
        clearTimeout(saveTimer);
        clearDraft();
        dropFeedCache();
        toast(next.published ? "Posted." : "Saved as a draft.");
        navigate(`/posts/${created.id}`);
      }
    } catch (err) {
      setPending(false);
      // Put it on disk now rather than waiting out the debounce or the way
      // out. A write that failed is the exact moment the words are only in a
      // textarea, and the next thing that happens might be the reader closing
      // the tab in disgust.
      flush();
      if (err.status === 403) navigate(`/posts/${edited.id}`);
      else if (err.status !== 401) {
        toast(err.status === 0
          ? "Can't reach the server. Try again?"
          : "That didn't go through. Try again?");
      }
    }
  });

  // The two window listeners outlive the form unless somebody takes them off,
  // and a second composer would then have two of each — both writing the same
  // slot, one of them from a textarea that is no longer on the page.
  onLeavingScreen(() => {
    flush();
    removeEventListener("pagehide", flush);
    removeEventListener("visibilitychange", flush);
  });

  mountView(form, { focus: title });
}

export function renderCompose() {
  if (!get("session")) return navigate("/login");
  buildForm({ mode: "new" });
}

export async function renderEdit({ params, isStale }) {
  if (!get("session")) return navigate("/login");

  // No transition into the placeholder. Nobody tapped a title to get here, so
  // there is no journey to narrate — and animating into grey bars only to have
  // to animate out of them again the moment the post lands is two pieces of
  // choreography spent on the gap between one screen and the same screen with
  // the words in it. The cross-fade mountView falls back to is enough.
  mountView(h("section", { class: "compose" },
    h("span", { class: "sk", style: { display: "block", width: "40%", height: "24px", marginBottom: "20px" } }),
    h("span", { class: "sk", style: { display: "block", height: "220px", borderRadius: "18px" } })),
    { transition: false });

  let post;
  try {
    post = await api.get(`/posts/${encodeURIComponent(params.id)}`);
  } catch (err) {
    if (isStale()) return;
    toast(err.status === 404 ? "That post is gone." : "Couldn't open that post.");
    return navigate("/");
  }
  if (isStale()) return;

  if (!isMine(post)) {
    toast("You can't edit that.");
    return navigate(`/posts/${post.id}`);
  }
  buildForm({ mode: "edit", post });
}
