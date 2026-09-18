// @ts-check
// Compose (#/compose) and Edit (#/posts/:id/edit). New posts POST; edits PATCH
// only the fields that actually changed. Both are pessimistic — the button waits
// for the server before we move on.

import { api } from "../api.js";
import { h, mountView, toast } from "../ui.js";
import { get, isMine, dropFeedCache } from "../store.js";
import { navigate } from "../router.js";

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

  const counter = h("span", { class: "counter", "aria-live": "off" });
  const paintCounter = () => {
    const n = content.value.length;
    counter.textContent = `${n.toLocaleString()} / ${CONTENT_MAX.toLocaleString()}`;
    counter.classList.toggle("counter--over", n > CONTENT_MAX);
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

  const submit = h("button", { class: "btn btn--primary", type: "submit" },
    editing ? "Save changes" : "Post");
  const cancel = h("a",
    { class: "btn btn--quiet", href: editing ? `#/posts/${edited.id}` : "#/" }, "Cancel");

  const form = h("form", { class: "compose", novalidate: true },
    h("h1", { class: "compose__title" }, editing ? "Edit your post" : "New post"),
    h("div", { class: "compose__panel" },
      field("post-title", "Title", title, titleErr),
      field("post-content", "Body", content, contentErr),
      h("div", { class: "compose__row" }, toggle, counter),
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
        dropFeedCache();
        toast(next.published ? "Posted." : "Saved as a draft.");
        navigate(`/posts/${created.id}`);
      }
    } catch (err) {
      setPending(false);
      if (err.status === 403) navigate(`/posts/${edited.id}`);
      else if (err.status !== 401) {
        toast(err.status === 0
          ? "Can't reach the server. Try again?"
          : "That didn't go through. Try again?");
      }
    }
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
