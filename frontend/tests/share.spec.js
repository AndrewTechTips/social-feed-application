// Sharing something *into* Commons.
//
// Installed on Android, the app is in the system share sheet; pick it and the
// composer opens with what was shared already in it. The whole mechanism is a
// `method: "GET"` share target, which means the browser just navigates here
// with query parameters — so every one of these tests is a real navigation to
// a real URL, and none of it is stubbed.
//
// What cannot be driven from here is the system share sheet itself. That is
// the operating system's, and what it sends is the URL below.

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./support/fixtures");

const appDir = path.join(__dirname, "..");
const ADA = "ada@commons.test";

const manifest = () =>
  JSON.parse(fs.readFileSync(path.join(appDir, "manifest.webmanifest"), "utf8"));

/** The URL an Android share sheet sends. */
function shareUrl({ title, text, url } = {}) {
  const params = new URLSearchParams();
  if (title) params.set("title", title);
  if (text) params.set("text", text);
  if (url) params.set("url", url);
  return `/?${params.toString()}`;
}

const titleField = (page) => page.getByLabel("Title", { exact: true });
const bodyField = (page) => page.getByLabel("Body");

async function signedIn(page, api) {
  await api.seed(1, ADA);
  await api.signIn(page, ADA, "seedpassword");
}

// ── the declaration ────────────────────────────────────────────────────────
test("the manifest declares a target a static host can actually answer", () => {
  const target = manifest().share_target;
  expect(target, "no share_target in the manifest").toBeTruthy();

  // POST is the usual shape and it needs somewhere to post *to*. GitHub Pages
  // serves files; a GET target is a navigation, which is the only kind of
  // share this app could honestly claim to handle.
  expect(target.method?.toUpperCase() ?? "GET").toBe("GET");
  expect(target.enctype).toBeUndefined();

  // Relative, so it still resolves under /social-feed-application/ on Pages,
  // and inside the manifest's own scope or the browser drops the target.
  expect(target.action).toBe("./");

  // All three, because no two apps agree on which they fill.
  expect(target.params).toEqual({ title: "title", text: "text", url: "url" });
});

// ── arriving ───────────────────────────────────────────────────────────────
test("a shared page opens the composer with the title and the link in it", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await page.goto(
    shareUrl({
      title: "A bench by the water",
      text: "Worth facing something.",
      url: "https://example.com/benches",
    })
  );

  await expect(page).toHaveURL(/#\/compose$/);
  await expect(titleField(page)).toHaveValue("A bench by the water");
  // The sentence, then the link, with a blank line between them — which is how
  // somebody would have typed it.
  await expect(bodyField(page)).toHaveValue(
    "Worth facing something.\n\nhttps://example.com/benches"
  );
  await expect(page.locator(".compose__resumed-line")).toHaveText(
    "Added what you shared."
  );
});

// Two tests rather than two shares in one: the composer keeps what it is given,
// so a second share in the same tab merges with the first — which is the
// subject of its own test further down, not a thing to trip over here.
test("text alone is enough", async ({ page, api }) => {
  await signedIn(page, api);
  await page.goto(shareUrl({ text: "Something I read on the bus." }));
  await expect(page).toHaveURL(/#\/compose$/);
  await expect(titleField(page)).toHaveValue("");
  await expect(bodyField(page)).toHaveValue("Something I read on the bus.");
});

test("and so is a bare link", async ({ page, api }) => {
  await signedIn(page, api);
  await page.goto(shareUrl({ url: "https://example.com/only" }));
  await expect(page).toHaveURL(/#\/compose$/);
  await expect(titleField(page)).toHaveValue("");
  await expect(bodyField(page)).toHaveValue("https://example.com/only");
});

test("a link already inside the text is not repeated", async ({ page, api }) => {
  // Several apps put the whole thing in `text` and fill `url` with the same
  // address. Pasting it twice is the app not reading what it was handed.
  await signedIn(page, api);
  await page.goto(
    shareUrl({
      text: "Look at this: https://example.com/thing",
      url: "https://example.com/thing",
    })
  );
  await expect(page).toHaveURL(/#\/compose$/);
  await expect(bodyField(page)).toHaveValue("Look at this: https://example.com/thing");
});

test("an ordinary visit is not a share", async ({ page, api }) => {
  await signedIn(page, api);
  await page.goto("/");
  await expect(page).not.toHaveURL(/#\/compose/);
});

// ── the URL afterwards ─────────────────────────────────────────────────────
test("the share comes out of the address, and is not delivered twice", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await page.goto(shareUrl({ title: "Once", text: "Only once." }));
  await expect(titleField(page)).toHaveValue("Once");

  // Gone from the query, or Back and reload would keep re-sharing it.
  const url = new URL(page.url());
  expect(url.searchParams.get("title")).toBeNull();
  expect(url.searchParams.get("text")).toBeNull();

  // Asked of the share's own key rather than of the form. The form keeps what
  // it was given — js/draft.js saves it, and flushes again on the way out of
  // any navigation — so an empty textarea is not what "not delivered twice"
  // means. What it means is that there is no second share to deliver.
  const key = () => page.evaluate(() => sessionStorage.getItem("commons.share"));
  expect(await key()).toBeNull();
  await page.reload();
  await expect(page.locator(".compose__panel")).toBeVisible();
  expect(await key()).toBeNull();
});

test("everything else in the query survives", async ({ page, api }, testInfo) => {
  test.skip(
    testInfo.project.name !== "demo",
    "?demo=1 is the parameter worth protecting, and only one project has it"
  );
  // Stripping the whole query took the app out of demo mode on the next
  // reload, which is a stranger bug to find than it is to avoid.
  await signedIn(page, api);
  await page.goto(shareUrl({ text: "Keep the rest." }));
  await expect(page).toHaveURL(/#\/compose$/);
  expect(new URL(page.url()).searchParams.get("demo")).toBe("1");
});

// ── what it must never do ──────────────────────────────────────────────────
test("a half-written post is added to, never replaced", async ({ page, api }) => {
  await signedIn(page, api);
  await page.goto("/#/compose");
  await titleField(page).fill("Half a thought");
  await bodyField(page).fill("I started this yesterday.");
  // Past the composer's debounce, so the draft is really in storage.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("commons.draft")))
    .toContain("yesterday");

  await page.goto(shareUrl({ title: "Ignored", text: "And this arrived." }));
  await expect(page).toHaveURL(/#\/compose$/);

  // The title that was already there wins; the body gains the share.
  await expect(titleField(page)).toHaveValue("Half a thought");
  await expect(bodyField(page)).toHaveValue(
    "I started this yesterday.\n\nAnd this arrived."
  );
  // And it says both things were done, because two things were done.
  await expect(page.locator(".compose__resumed-line")).toHaveText(
    "Picked up where you left off, and added what you shared."
  );
});

test("a share that arrives while signed out is still there afterwards", async ({
  page,
  api,
}) => {
  // The composer sends you to sign in first. The share is kept under its own
  // key rather than written into the draft precisely so that it survives that
  // — a draft is stamped with who wrote it, and at this point nobody has.
  await api.seed(1, ADA);
  await page.goto(shareUrl({ title: "Held", text: "Waiting for a reader." }));
  await expect(page).toHaveURL(/#\/login$/);

  await page.getByLabel("Email").fill(ADA);
  await page.getByLabel("Password", { exact: true }).fill("seedpassword");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);

  await page.goto("/#/compose");
  await expect(titleField(page)).toHaveValue("Held");
  await expect(bodyField(page)).toHaveValue("Waiting for a reader.");
});

test("and a second trip to the composer adds nothing further", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await page.goto(shareUrl({ title: "Spent", text: "Used up." }));
  await expect(bodyField(page)).toHaveValue("Used up.");

  // Reading the share is what spends it, so coming back must not merge it in a
  // second time and leave the body saying everything twice.
  await page.goto("/#/");
  await page.goto("/#/compose");
  await expect(page.locator(".compose__panel")).toBeVisible();
  await expect(bodyField(page)).toHaveValue("Used up.");
  await expect(page.locator(".compose__resumed-line")).toHaveText(
    "Picked up where you left off."
  );
});

test("a share never goes out with the post", async ({ page, api }) => {
  // The whole point is that it lands in the composer as ordinary text the
  // reader can edit or delete — not that it is attached to anything.
  await signedIn(page, api);
  await page.goto(shareUrl({ title: "A shared thing", text: "With a body." }));
  await expect(titleField(page)).toHaveValue("A shared thing");
  await bodyField(page).fill("Rewritten entirely.");
  await page.getByRole("button", { name: "Post", exact: true }).click();

  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  await expect(page.locator(".detail__title")).toHaveText("A shared thing");
  await expect(page.locator(".detail__content")).toHaveText("Rewritten entirely.");
});
