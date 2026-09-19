// The conversation under a post.
//
// Everything here runs twice — once against mock_api.py, once against the
// in-browser demo adapter — because a feature that only works on one of them is
// a feature the published site doesn't have. That has been the recurring gap in
// this project (draft visibility, then usernames), so comments arrive with the
// mirror already checked rather than checked later.

const { test, expect, usernameFor } = require("./support/fixtures");

const password = "hunter2pw";
const uniqueEmail = (tag) =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@commons.test`;

async function register(page, email) {
  await page.goto("/#/register");
  await page.getByLabel("Username").fill(usernameFor(email));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/#\/$/);
}

async function signOut(page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
}

/** Write a post and stay on it. Returns its id. */
async function writePost(page, title, { draft = false } = {}) {
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Body").fill("Something to talk about.");
  if (draft) {
    await page.getByText("Publish now").click();
    await expect(page.getByText("Save as a draft")).toBeVisible();
  }
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  return page.url().match(/#\/posts\/(\d+)$/)[1];
}

async function say(page, words) {
  await page.getByLabel("Add a comment").fill(words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
}

const comments = (page) => page.locator(".comment");
const commentText = (page) => page.locator(".comment__text");

// A comment is on screen before the request that saves it has answered, so
// anything that goes on to inspect what the *store* holds has to wait for the
// optimistic row to stop being provisional first.
const settled = (page) =>
  expect(page.locator(".comment--pending")).toHaveCount(0);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
test("a post nobody has said anything about says so", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");
  await page.goto("/#/posts/1");

  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
  await expect(page.getByText("Nothing said about this one yet.")).toBeVisible();
  await expect(comments(page)).toHaveCount(0);
});

test("comments read oldest first, whoever wrote them", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");

  const first = uniqueEmail("first");
  await register(page, first);
  await page.goto("/#/posts/1");
  await say(page, "Said this first.");
  await expect(page.getByText("Said this first.")).toBeVisible();

  await signOut(page);
  await register(page, uniqueEmail("second"));
  await page.goto("/#/posts/1");
  await say(page, "And this second.");

  await expect(commentText(page)).toHaveText(["Said this first.", "And this second."]);
  // The count sits next to the heading rather than in it, so the heading keeps
  // its name for screen readers and for getByRole.
  await expect(page.locator(".comments__count")).toHaveText("2");
});

test("a comment carries its author's username, never an address", async ({
  page,
  api,
}) => {
  await api.seed(1, "ada@commons.test");
  const email = uniqueEmail("writer");
  await register(page, email);
  await page.goto("/#/posts/1");
  await say(page, "Hello from here.");

  const row = comments(page).first();
  await expect(row.locator(".comment__author")).toHaveText(usernameFor(email));
  await expect(row).not.toContainText("@");
});

test("signed out there's no composer, just a way in", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");
  await page.goto("/#/posts/1");

  await expect(page.getByLabel("Add a comment")).toHaveCount(0);
  await expect(page.locator(".composer__prompt").getByRole("link", { name: "Sign in" }))
    .toBeVisible();
});

// ---------------------------------------------------------------------------
// Writing — the optimistic append and its rollback
// ---------------------------------------------------------------------------
test("a new comment is on screen before the server has answered", async ({
  page,
  api,
}) => {
  await api.seed(1, "ada@commons.test");
  await register(page, uniqueEmail("quick"));
  await page.goto("/#/posts/1");
  await expect(page.getByText("Nothing said about this one yet.")).toBeVisible();

  await say(page, "Straight away, please.");

  // The demo adapter answers in ~150ms; this has to be visible inside that.
  await expect(comments(page).first()).toContainText("Straight away, please.");
  // and the box is empty again, so a second thought can go straight in
  await expect(page.getByLabel("Add a comment")).toHaveValue("");
  // once it lands it stops being provisional
  await expect(comments(page).first()).not.toHaveClass(/comment--pending/);
});

test("a comment that doesn't post gives you your words back", async ({
  page,
  api,
}) => {
  await api.seed(1, "ada@commons.test");
  await register(page, uniqueEmail("unlucky"));
  await page.goto("/#/posts/1");
  await expect(page.getByText("Nothing said about this one yet.")).toBeVisible();

  await api.failNext({ method: "POST", path: "^/posts/\\d+/comments$", status: 500 });
  await say(page, "This one is doomed.");

  await expect(page.getByText("That comment didn't post. Try again?")).toBeVisible();
  await expect(comments(page)).toHaveCount(0);
  await expect(page.getByText("Nothing said about this one yet.")).toBeVisible();
  // The words are the part that can't be recovered from the reader's side.
  await expect(page.getByLabel("Add a comment")).toHaveValue("This one is doomed.");
});

test("an empty comment doesn't go anywhere", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");
  await register(page, uniqueEmail("blank"));
  await page.goto("/#/posts/1");
  await expect(page.getByText("Nothing said about this one yet.")).toBeVisible();

  await say(page, "   ");
  await expect(comments(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------
test("you can remove your own comment, and it asks once", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");
  await register(page, uniqueEmail("author"));
  await page.goto("/#/posts/1");
  await say(page, "On reflection, no.");
  await expect(comments(page)).toHaveCount(1);

  const remove = page.getByRole("button", { name: "Remove your comment" });
  await remove.click();
  await expect(comments(page)).toHaveCount(1); // one click is not enough
  await expect(
    page.getByRole("button", { name: "Confirm removing your comment" })
  ).toHaveText("Sure?");

  await page.getByRole("button", { name: "Confirm removing your comment" }).click();
  await expect(comments(page)).toHaveCount(0);
  await expect(page.getByText("Nothing said about this one yet.")).toBeVisible();
});

test("there's nothing to remove on somebody else's comment", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");

  await register(page, uniqueEmail("them"));
  await page.goto("/#/posts/1");
  await say(page, "Theirs, not yours.");
  await expect(comments(page)).toHaveCount(1);
  await settled(page);

  await signOut(page);
  await register(page, uniqueEmail("you"));
  await page.goto("/#/posts/1");

  await expect(comments(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove your comment" })).toHaveCount(0);
});

test("the author of a post can't remove comments on it either", async ({
  page,
  api,
}) => {
  const mine = uniqueEmail("host");
  await register(page, mine);
  const postId = await writePost(page, "Open floor");

  await signOut(page);
  await register(page, uniqueEmail("guest"));
  await page.goto(`/#/posts/${postId}`);
  await say(page, "A guest says this.");
  await expect(comments(page)).toHaveCount(1);
  await settled(page);

  await signOut(page);
  await page.goto("/#/login");
  await page.getByLabel("Email").fill(mine);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);

  await page.goto(`/#/posts/${postId}`);
  await expect(comments(page)).toHaveCount(1);
  // Owning the room is not owning what was said in it.
  await expect(page.getByRole("button", { name: "Remove your comment" })).toHaveCount(0);
  // and the post's own Delete is still there, which is the control this one
  // is deliberately not
  await expect(page.locator(".detail__actions").getByRole("button", { name: "Delete" }))
    .toBeVisible();
});

// ---------------------------------------------------------------------------
// Drafts — a post you can't see has no conversation
// ---------------------------------------------------------------------------
test("you can comment on your own draft", async ({ page, api }) => {
  await register(page, uniqueEmail("drafter"));
  await writePost(page, "Still thinking", { draft: true });

  await say(page, "Note to self.");
  await expect(comments(page).first()).toContainText("Note to self.");
});

test("someone else's draft has no comments to read or to write", async ({
  page,
  api,
}) => {
  await register(page, uniqueEmail("drafter"));
  const draftId = await writePost(page, "Not ready", { draft: true });
  await say(page, "Private thought.");
  await expect(comments(page)).toHaveCount(1);
  await settled(page);

  await signOut(page);
  await register(page, uniqueEmail("stranger"));
  await page.goto(`/#/posts/${draftId}`);

  await expect(page.getByRole("heading", { name: "That post is gone." })).toBeVisible();
  await expect(page.locator(".comments")).toHaveCount(0);
  await expect(page.getByText("Private thought.")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------
test("deleting a post takes its comments with it", async ({ page, api }) => {
  await register(page, uniqueEmail("owner"));
  const doomed = await writePost(page, "Here today");
  await say(page, "Said on the doomed post.");
  await settled(page);

  const survivor = await writePost(page, "Here tomorrow");
  await say(page, "Said on the other one.");
  await settled(page);

  expect((await api.dump(page)).comments).toHaveLength(2);

  await page.goto(`/#/posts/${doomed}`);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByText("Post deleted.")).toBeVisible();

  const left = (await api.dump(page)).comments;
  expect(left).toHaveLength(1);
  expect(left[0].content).toBe("Said on the other one.");
  expect(String(left[0].post_id)).toBe(survivor);
});


// ---------------------------------------------------------------------------
// Replying — one level, deliberately
// ---------------------------------------------------------------------------
//
// The depth is declared in the API's schema (a ReplyOut has no replies) and
// drawn here by position: a reply is indented under what it answers and has no
// Reply control of its own. These check both halves, and the counting, which
// is the part with two numbers behind it.

const replies = (page) => page.locator(".comment--reply");

async function replyTo(page, index, words) {
  await page.locator(".comment__reply").nth(index).click();
  const form = page.locator(".composer--reply");
  await expect(form).toBeVisible();
  await form.locator("textarea").fill(words);
  await form.getByRole("button", { name: "Reply", exact: true }).click();
}

test("a reply lands under what it answers", async ({ page, api }) => {
  await register(page, uniqueEmail("reply"));
  await writePost(page, "A wall");
  await say(page, "Still standing?");
  await settled(page);

  await replyTo(page, 0, "Two winters now.");
  await settled(page);

  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page)).toHaveText(/Two winters now\./);
  // Inside the conversation it answers, not loose in the thread.
  await expect(
    page.locator(".comments__list > .comment").first().locator(".comment__replies .comment")
  ).toHaveCount(1);
  await expect(page.locator(".comments__list > .comment")).toHaveCount(1);
});

test("it survives a reload, which is where the optimistic row stops helping", async ({
  page,
  api,
}) => {
  await register(page, uniqueEmail("replyreload"));
  await writePost(page, "A wall");
  await say(page, "Still standing?");
  await settled(page);
  await replyTo(page, 0, "Two winters now.");
  await settled(page);

  await page.reload();
  await expect(page.locator(".detail__title")).toBeVisible();
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page)).toHaveText(/Two winters now\./);
});

test("a reply has no Reply of its own", async ({ page, api }) => {
  await register(page, uniqueEmail("onelevel"));
  await writePost(page, "A wall");
  await say(page, "Still standing?");
  await settled(page);
  await replyTo(page, 0, "Two winters now.");
  await settled(page);

  // One conversation, one reply, and exactly one control — on the conversation.
  await expect(page.locator(".comment__reply")).toHaveCount(1);
  await expect(replies(page).locator(".comment__reply")).toHaveCount(0);
});

test("the heading counts everything said, not just the conversations", async ({
  page,
  api,
}) => {
  await register(page, uniqueEmail("counting"));
  await writePost(page, "A wall");
  await say(page, "One.");
  await settled(page);
  await expect(page.locator(".comments__count")).toHaveText("1");

  await replyTo(page, 0, "Two.");
  await settled(page);
  await expect(page.locator(".comments__count")).toHaveText("2");

  await say(page, "Three.");
  await settled(page);
  await expect(page.locator(".comments__count")).toHaveText("3");

  // And the number a reload produces is the same one, which is the bit the
  // optimistic counting could get wrong.
  await page.reload();
  await expect(page.locator(".detail__title")).toBeVisible();
  await expect(page.locator(".comments__count")).toHaveText("3");
});

test("removing a conversation takes what was said back to it", async ({ page, api }) => {
  await register(page, uniqueEmail("cascade"));
  await writePost(page, "A wall");
  await say(page, "One.");
  await settled(page);
  await replyTo(page, 0, "Two.");
  await settled(page);
  await expect(page.locator(".comments__count")).toHaveText("2");

  await page.locator(".comment__remove").first().click();
  await page.locator(".comment__remove").first().click();
  await expect(comments(page)).toHaveCount(0);
  // Not "1 left" — the reply went with it, at the database and on screen.
  await expect(page.locator(".comments__count")).toHaveText("");
  await expect(page.locator(".comments__status")).toBeVisible();
});

test("only one reply box is open at a time", async ({ page, api }) => {
  await register(page, uniqueEmail("onebox"));
  await writePost(page, "A wall");
  await say(page, "One.");
  await settled(page);
  await say(page, "Two.");
  await settled(page);

  await page.locator(".comment__reply").first().click();
  await expect(page.locator(".composer--reply")).toHaveCount(1);
  await page.locator(".comment__reply").last().click();
  // Two open boxes is a question about which one you are typing in.
  await expect(page.locator(".composer--reply")).toHaveCount(1);
});

test("cancelling puts the thread back", async ({ page, api }) => {
  await register(page, uniqueEmail("cancel"));
  await writePost(page, "A wall");
  await say(page, "One.");
  await settled(page);

  await page.locator(".comment__reply").click();
  await expect(page.locator(".composer--reply")).toBeVisible();
  await page.locator(".composer--reply").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".composer--reply")).toHaveCount(0);
  await expect(page.locator(".comment__reply")).toBeVisible();
});

test("a signed-out reader is offered nothing to reply with", async ({ page, api }) => {
  await register(page, uniqueEmail("anon"));
  const id = await writePost(page, "A wall");
  await say(page, "One.");
  await settled(page);
  await signOut(page);

  await page.goto(`/#/posts/${id}`);
  await expect(comments(page)).toHaveCount(1);
  await expect(page.locator(".comment__reply")).toHaveCount(0);
});
