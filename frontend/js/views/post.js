// Post detail (#/posts/:id) — public. Full content, byline with timestamps
// ("edited" when it's been changed), the vote control, and Edit / Delete when
// the post is yours. Delete asks first, inline — never window.confirm.

import { api } from "../api.js";
import { h, icon, mountView, avatar, relativeTime, fullTime, wasEdited, voteControl, toast } from "../ui.js";
import { isMine, dropFeedCache } from "../store.js";
import { nameForMorph, morphingBackTo } from "../transitions.js";
import { navigate } from "../router.js";

const backLink = () =>
  h("a", { class: "back", href: "#/" }, icon("chevron-left", 15), "Back to the feed");

const sk = (style) => h("span", { class: "sk", style: { display: "block", ...style } });

function loadingSkeleton() {
  return h("section", { class: "detail" },
    backLink(),
    sk({ width: "62%", height: "30px", marginBottom: "20px" }),
    sk({ width: "40%", height: "14px", marginBottom: "28px" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line" }),
    h("span", { class: "sk sk--line sk--short" }));
}

export async function renderPost({ params, isStale }) {
  const id = params.id;
  mountView(loadingSkeleton());

  let post;
  try {
    post = await api.get(`/posts/${encodeURIComponent(id)}`);
  } catch (err) {
    if (isStale()) return;
    const gone = err.status === 404;
    mountView(h("section", { class: "detail" },
      backLink(),
      h("h1", { class: "detail__title" }, gone ? "That post is gone." : "That didn't load."),
      h("p", { style: { color: "var(--text-dim)" } },
        gone ? "It may have been deleted." : "Try again in a moment.")));
    return;
  }
  if (isStale()) return;

  const mine = isMine(post);

  const timeBits = [
    h("time", { datetime: post.created_at, title: fullTime(post.created_at) },
      relativeTime(post.created_at)),
  ];
  if (wasEdited(post)) {
    // No separator dot: the tag is already a chip, and space does the job.
    timeBits.push(
      h("span", { class: "tag", title: "Last edited " + fullTime(post.updated_at) }, "edited"));
  }

  const byline = h("div", { class: "detail__byline" },
    avatar(post.user.email, "lg"),
    h("div", { class: "stack" },
      h("span", { class: "name", title: post.user.email }, post.user.email.split("@")[0]),
      h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px" } }, timeBits)));

  const actions = h("div", { class: "detail__actions" });

  // The other end of the morph: whatever title the reader tapped arrives here.
  const title = h("h1", { class: "detail__title" }, post.title);
  nameForMorph(title);
  // And on the way back out, the card for this post takes the name so the
  // journey reverses rather than fading.
  morphingBackTo(post.id);

  const root = h("section", { class: "detail" },
    backLink(),
    title,
    byline,
    h("div", { class: "detail__row" }, voteControl(post, { inline: true })),
    h("div", { class: "detail__content" }, post.content),
    mine ? actions : null);

  if (mine) mountActions();
  mountView(root);

  // — owner actions -----------------------------------------------------------
  function mountActions() {
    const deleteBtn = h("button",
      { class: "btn btn--quiet danger", type: "button", onclick: askDelete }, "Delete");
    actions.replaceChildren(
      h("a", { class: "btn btn--ghost", href: `#/posts/${post.id}/edit` }, "Edit"),
      deleteBtn);

    function askDelete() {
      const yes = h("button", { class: "btn btn--danger", type: "button" }, "Delete");
      const no = h("button", { class: "btn btn--quiet", type: "button", onclick: cancel }, "Keep it");
      const box = h("div",
        { class: "confirm", role: "alertdialog", "aria-label": "Confirm delete", tabindex: "-1" },
        h("p", { class: "confirm__text" }, "Delete this post? There's no undo."),
        no, yes);

      const onKey = (e) => e.key === "Escape" && cancel();
      function cancel() {
        mountActions();
        deleteBtn.focus();
      }
      yes.addEventListener("click", async () => {
        yes.disabled = no.disabled = true;
        yes.textContent = "Just a sec…";
        try {
          await api.del(`/posts/${post.id}`);
          dropFeedCache();
          toast("Post deleted.");
          navigate("/");
        } catch (err) {
          if (err.status === 403 || err.status === 401) {
            mountActions();
          } else {
            yes.disabled = no.disabled = false;
            yes.textContent = "Delete";
            toast("That didn't go through. Try again?");
          }
        }
      });
      box.addEventListener("keydown", onKey);
      actions.replaceChildren(box);
      box.focus();
    }
  }
}
