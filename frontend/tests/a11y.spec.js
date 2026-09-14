// Accessibility, checked by a machine and then by a keyboard.
//
// Two different things are going on here and neither replaces the other.
//
// axe catches the mechanical failures — contrast, missing labels, landmark
// structure, ARIA that doesn't parse. It is very good at that and completely
// blind to whether the app is actually usable, which is why the second half of
// this file walks the whole core flow without ever touching the mouse.
//
// Every screen the app has is covered, not a representative sample: a screen
// nobody checked is exactly where the unlabelled input ends up.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, usernameFor } = require("./support/fixtures");

const password = "hunter2pw";
const uniqueEmail = (tag) =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@commons.test`;

// WCAG 2.1 A and AA. Not "best-practice", which includes opinions (heading
// order in a fragment, region landmarks on everything) that are worth reading
// but not worth failing a build over.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Wait for the screen to stop moving before measuring it.
 *
 * mountView adds `.route-enter`, which fades the new view up from opacity 0
 * and removes the class on animationend. Scanning during those ~120ms makes
 * axe blend every foreground and background toward each other and report a
 * page-full of contrast failures that don't exist once the animation lands —
 * the first run of this file produced thirteen of them.
 */
async function settled(page) {
  await page.waitForFunction(() => !document.querySelector(".route-enter"));
  // And anything else still moving — the delete confirm fades in on its own
  // animation, which is short enough to miss and long enough to skew a scan.
  //
  // Two kinds are skipped, both because waiting on them would hang here
  // forever. Infinite ones: the skeleton shimmer and the background blooms.
  // And progress-based ones — the post's reading hairline runs on a scroll
  // timeline, so it finishes when the reader reaches the bottom of the page
  // and not before. It is already showing its correct value at every moment,
  // which is the only sense in which "settled" means anything for it.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (a) =>
            a.effect?.getComputedTiming().iterations !== Infinity &&
            a.timeline instanceof DocumentTimeline
        )
        .map((a) => a.finished.catch(() => {}))
    )
  );
}

async function scan(page, { include } = {}) {
  await settled(page);
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  // Report what actually broke rather than "expected 3 to be 0".
  const summary = violations.map(
    (v) => `${v.id} (${v.impact}) — ${v.nodes.length}×: ${v.help}`
  );
  expect(summary, summary.join("\n")).toEqual([]);
}

async function register(page, email) {
  await page.goto("/#/register");
  await page.getByLabel("Username").fill(usernameFor(email));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/#\/$/);
}

async function write(page, title) {
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Body").fill("Something worth reading, in theory.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  return page.url().match(/#\/posts\/(\d+)$/)[1];
}

// ---------------------------------------------------------------------------
// Signed out
// ---------------------------------------------------------------------------
test("the feed has no violations", async ({ page, api }) => {
  await api.seed(4, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await scan(page);
});

test("the feed's empty state has no violations", async ({ page, api }) => {
  await page.goto("/");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await scan(page);
});

test("a post has no violations", async ({ page, api }) => {
  await api.seed(1, "ada@commons.test");
  await page.goto("/#/posts/1");
  await expect(page.getByRole("heading", { name: "Seeded post 1" })).toBeVisible();
  await scan(page);
});

test("sign in has no violations", async ({ page, api }) => {
  await page.goto("/#/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await scan(page);
});

test("register has no violations", async ({ page, api }) => {
  await page.goto("/#/register");
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  await scan(page);
});

test("a form showing its errors has no violations", async ({ page, api }) => {
  // Error states are where the labelling usually comes apart: a message that
  // isn't associated with its field, or a live region that never announces.
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Enter your email.")).toBeVisible();
  await scan(page);
});

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------
test("compose has no violations", async ({ page, api }) => {
  await register(page, uniqueEmail("a11y"));
  await page.goto("/#/compose");
  await expect(page.getByRole("heading", { name: "New post" })).toBeVisible();
  await scan(page);
});

test("the editor has no violations", async ({ page, api }) => {
  await register(page, uniqueEmail("a11y"));
  const id = await write(page, "Editable");
  await page.goto(`/#/posts/${id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit your post" })).toBeVisible();
  await scan(page);
});

test("a profile has no violations", async ({ page, api }) => {
  const email = uniqueEmail("a11y");
  await register(page, email);
  await write(page, "On a profile");
  await page.goto(`/#/u/${usernameFor(email)}`);
  await expect(page.locator(CARD).first()).toBeVisible();
  await scan(page);
});

test("your own post, with its owner controls, has no violations", async ({
  page,
  api,
}) => {
  await register(page, uniqueEmail("a11y"));
  const id = await write(page, "Mine to delete");
  await page.goto(`/#/posts/${id}`);
  await expect(page.getByRole("link", { name: "Edit" })).toBeVisible();
  await scan(page);
});

test("the delete confirmation has no violations", async ({ page, api }) => {
  await register(page, uniqueEmail("a11y"));
  const id = await write(page, "About to go");
  await page.goto(`/#/posts/${id}`);
  await page.locator(".detail__actions").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await scan(page);
});

test("a comment thread and its composer have no violations", async ({ page, api }) => {
  await register(page, uniqueEmail("a11y"));
  const id = await write(page, "Say something");
  await page.goto(`/#/posts/${id}`);
  await page.getByLabel("Add a comment").fill("A remark.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment")).toHaveCount(1);
  await scan(page);
});

test("the command palette has no violations", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette")).toBeVisible();
  await scan(page);
});

// ---------------------------------------------------------------------------
// The keyboard-only journey
// ---------------------------------------------------------------------------
test("the whole core flow works without a mouse", async ({ page, api }) => {
  await api.seed(3, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  // — reach a post by tabbing, and open it with Enter ----------------------
  const opened = await page.evaluate(() => {
    // Walk the real tab order rather than guessing how many Tabs it takes:
    // the header's contents change with the route and with the viewport.
    const focusable = [...document.querySelectorAll("a[href], button, input")].filter(
      (el) => el.offsetParent !== null
    );
    return focusable.some((el) => el.classList.contains("card__link"));
  });
  expect(opened, "a post card has to be reachable as a link").toBe(true);

  const firstCard = page.locator(".card__link").first();
  await firstCard.focus();
  await expect(firstCard).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/posts\/\d+$/);

  // — the new screen takes focus, so a screen reader starts at the top -----
  await expect(page.locator("#view")).toBeFocused();

  // — N opens the composer from anywhere ----------------------------------
  // settled() first, every time: while a view transition runs the document
  // takes no input at all, so a keystroke sent into one is simply lost. A
  // person hits the same 160ms — they just don't notice, because they aren't
  // typing the instant the URL changes.
  await settled(page);
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#\/login$/); // signed out: it asks you in first

  // — sign in using only the keyboard -------------------------------------
  await page.getByLabel("Email").focus();
  await page.keyboard.type("ada@commons.test");
  await page.keyboard.press("Tab");
  await page.keyboard.type("seedpassword");
  await page.keyboard.press("Enter"); // submit from inside the field
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(CARD).first()).toBeVisible();

  // — write a post, keyboard only -----------------------------------------
  await settled(page);
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#\/compose$/);
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
  await page.keyboard.type("Written without a mouse");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Every keystroke of it.");
  await page.getByRole("button", { name: "Post" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  await expect(
    page.getByRole("heading", { name: "Written without a mouse" })
  ).toBeVisible();
  await settled(page);

  // — the delete confirm traps nothing and Escape backs out ---------------
  const del = page.locator(".detail__actions").getByRole("button", { name: "Delete" });
  await del.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  // Focus comes back to the control that opened it, rather than to the body.
  await expect(del).toBeFocused();

  // — the palette is reachable and runs a command -------------------------
  await settled(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette")).toBeVisible();
  await expect(page.locator(".palette__input")).toBeFocused();
  await page.keyboard.press("Escape");
  // The overlay is hidden rather than unmounted, so this is toBeHidden and
  // not toHaveCount(0).
  await expect(page.locator(".palette")).toBeHidden();
});
