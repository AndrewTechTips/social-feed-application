// Somebody addressed you.
//
// The backend suite pins down which events make a row. This pins down the part
// a person actually meets: a count in the header that is right, a list that
// says something useful, and a badge that goes out when you have looked — and
// stays out.
//
// Both projects, because a notification is a data feature and the published
// demo has to have it too.

const AxeBuilder = require("@axe-core/playwright").default;
const {
  test,
  expect,
  CARD,
  settled,
  signOutViaMenu,
  accountButton,
  openAccountMenu,
} = require("./support/fixtures");

const ADA = "ada@commons.test";
const BEA = "bea@commons.test";

// The unread signal moved when the header did, and there is no lamp any more.
// A dot on the avatar says *that* something is waiting; the account button's
// own accessible name says how many, in words; the menu row says it again with
// a number on it. js/components/accountmenu.js has the argument for splitting
// it that way — a count behind a closed door is not a count.
//
// These assert the first two, because those are what the header states without
// being asked. accountmenu.spec.js covers the row.
const dot = (page) => page.locator(".accmenu__dot");
const menuRow = (page) => page.locator(".accmenu__row[href='#/notifications']");

/** What the header is saying about unread notifications, if anything. */
const says = (page, tail) =>
  expect(accountButton(page)).toHaveAttribute(
    "aria-label",
    new RegExp(`^Your account, [a-z0-9_-]+${tail}$`)
  );

const notices = (page) => page.locator(".notice");

/**
 * Seed two people and a post by Ada, then sign in as whoever is asked for.
 *
 * Everything is seeded before signing in: in demo mode the page is handed a
 * snapshot of the backend when the session is installed, so anything created
 * afterwards through the fixture exists on the Node side and nowhere the app
 * can see it.
 */
async function room(page, api, as = ADA) {
  await api.seed(1, ADA);
  await api.register(BEA, "seedpassword", "bea");
  await api.signIn(page, as, "seedpassword");
}

/**
 * Sign out, then sign in as somebody else **through the form**.
 *
 * Not `api.signIn`. In demo mode that re-seeds the page from a snapshot taken
 * on the Node side, which never saw anything done through the interface — so
 * the shortcut would quietly throw away the comment the test just made, which
 * is the entire thing being tested. The form goes through the app, which goes
 * through the adapter the page is actually running.
 */
async function switchTo(page, email) {
  await signOutViaMenu(page);
  await expect(page.locator(".account")).toContainText("Sign in");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("seedpassword");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
}

/** Say something on the first post, through the interface, as whoever is signed in. */
async function comment(page, words) {
  // By hash, and only if we are not already there. `page.goto("/")` while the
  // URL is already `#/` is a *reload*, and in demo mode a reload re-runs the
  // init script that installs the Node-side snapshot — which never saw
  // anything done through the interface. One redundant navigation and the
  // comment this test just made is gone.
  if (!/#\/$/.test(page.url())) await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.getByLabel("Add a comment").fill(words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment").last()).toContainText(words);
}

// ── the count ──────────────────────────────────────────────────────────────
test("a comment on your post lights the dot", async ({ page, api }) => {
  await room(page, api, BEA);
  await comment(page, "I walked past it too");

  // Ada is the one who was addressed, so sign in as her and look.
  await switchTo(page, ADA);

  await expect(dot(page)).toBeVisible();
  await says(page, ", one unread");
  // And in full, on the row it is about.
  await openAccountMenu(page);
  await expect(menuRow(page)).toHaveAttribute(
    "aria-label",
    "Notifications, one unread"
  );
  await expect(menuRow(page).locator(".accmenu__count")).toHaveText("1");
});

test("nothing you did to yourself counts", async ({ page, api }) => {
  await room(page, api, ADA);
  await comment(page, "Talking to myself");
  await page.goto("/#/");

  await expect(dot(page)).toBeHidden();
  await says(page, "");
  await openAccountMenu(page);
  await expect(menuRow(page)).toHaveAttribute("aria-label", "Notifications");
});

test("a vote lights nothing", async ({ page, api }) => {
  // Not an oversight: a vote is a number moving, and this app's design refuses
  // to turn that into a notification.
  await room(page, api, BEA);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);
  await page.locator(`${CARD} .vote`).first().click();
  await expect(page.locator(`${CARD} .vote`).first()).toContainText("1");

  await switchTo(page, ADA);
  await expect(page.locator(CARD)).toHaveCount(1);

  await expect(dot(page)).toBeHidden();
  await says(page, "");
});

test("a signed-out visitor has nothing to be notified about", async ({ page, api }) => {
  await api.seed(1, ADA);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);

  // No account, so no account button — and with it no dot and no menu.
  await expect(accountButton(page)).toHaveCount(0);
  await expect(dot(page)).toHaveCount(0);
});

// ── the list ───────────────────────────────────────────────────────────────
test("the line says who, what they said, and where", async ({ page, api }) => {
  await room(page, api, BEA);
  await comment(page, "I walked past it a hundred times");

  await switchTo(page, ADA);
  await page.goto("/#/notifications");

  await expect(notices(page)).toHaveCount(1);
  const row = notices(page).first();
  await expect(row.locator(".notice__who")).toContainText("bea");
  await expect(row.locator(".notice__who")).toContainText("commented on your post");
  // The excerpt is the point of the line: "somebody commented" tells you
  // nothing you can decide anything with.
  await expect(row.locator(".notice__said")).toHaveText(
    "I walked past it a hundred times"
  );
});

test("the whole line is the link, and it goes to the post", async ({ page, api }) => {
  await room(page, api, BEA);
  await comment(page, "Answering here");

  await switchTo(page, ADA);
  await page.goto("/#/notifications");
  await expect(notices(page)).toHaveCount(1);

  await notices(page).first().locator(".notice__link").click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);
  await expect(page.locator(".detail__title")).toBeVisible();
});

test("a reply says it is a reply", async ({ page, api }) => {
  await room(page, api, ADA);
  await comment(page, "The opening line");

  await switchTo(page, BEA);
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".comment").first()).toBeVisible();
  await page.locator(".comment__reply").first().click();
  const form = page.locator(".composer--reply");
  await form.locator("textarea").fill("Answering you directly");
  await form.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.locator(".comment--reply")).toHaveCount(1);

  await switchTo(page, ADA);
  await page.goto("/#/notifications");

  await expect(notices(page).first().locator(".notice__who")).toContainText(
    "replied to you"
  );
});

// ── looking at them puts the dot out ───────────────────────────────────────
test("opening the list clears the count, and it stays clear", async ({ page, api }) => {
  await room(page, api, BEA);
  await comment(page, "Something to answer");

  await switchTo(page, ADA);
  await expect(dot(page)).toBeVisible();
  await says(page, ", one unread");

  await page.goto("/#/notifications");
  await expect(notices(page)).toHaveCount(1);
  await expect(dot(page)).toBeHidden();
  await says(page, "");

  // Marked on the server, not only in this tab. A badge that comes back the
  // next time you look is a badge people stop believing.
  //
  // Proved by a round trip rather than a reload. `api.signIn` installs its
  // identity with `addInitScript`, which runs on *every* document load — so a
  // reload after switching user through the form re-plants the first user's
  // CSRF token and the refresh fails. That is a limitation of the fixture, not
  // of the app; leaving and coming back re-asks the server either way, which is
  // what this is actually about.
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await expect(dot(page)).toBeHidden();
  await says(page, "");

  await page.goto("/#/notifications");
  await expect(notices(page)).toHaveCount(1);
  await expect(page.locator(".notice--unread")).toHaveCount(0);
  await expect(dot(page)).toBeHidden();
  await says(page, "");
});

test("something new after looking counts again", async ({ page, api }) => {
  await room(page, api, BEA);
  await comment(page, "The first thing");

  await switchTo(page, ADA);
  await page.goto("/#/notifications");
  await expect(dot(page)).toBeHidden();
  await says(page, "");

  // Bea says something else while Ada is signed in elsewhere. The read ones
  // stay read; only the new one counts.
  await switchTo(page, BEA);
  await comment(page, "And another thing");

  await switchTo(page, ADA);

  await expect(dot(page)).toBeVisible();
  await says(page, ", one unread");
  await page.goto("/#/notifications");
  await expect(notices(page)).toHaveCount(2);
  await expect(notices(page).locator(".notice--unread")).toHaveCount(0);
});

// ── getting there, and finding nothing ─────────────────────────────────────
test("the palette offers it, with the count in the label", async ({ page, api }) => {
  await room(page, api, BEA);
  await comment(page, "Look at this");

  await switchTo(page, ADA);
  await expect(dot(page)).toBeVisible();
  await says(page, ", one unread");

  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette__row", { hasText: "Notifications — 1 unread" }).click();
  await expect(page).toHaveURL(/#\/notifications$/);
});

test("a signed-out visitor who types the address is sent to sign in", async ({
  page,
}) => {
  await page.goto("/#/notifications");
  await expect(page).toHaveURL(/#\/login$/);
});

test("an empty list says how one fills up", async ({ page, api }) => {
  await room(page, api, ADA);
  await page.goto("/#/notifications");

  await expect(notices(page)).toHaveCount(0);
  await expect(page.locator(".feed__status")).toHaveText(
    "Nothing yet. Say something on a post and this is where the answers land."
  );
});

// ── the shape of it ────────────────────────────────────────────────────────
test("no accessibility violations, full or empty", async ({ page, api }) => {
  await room(page, api, BEA);
  await comment(page, "Something worth reading about");

  await switchTo(page, ADA);
  await page.goto("/#/notifications");
  await expect(notices(page)).toHaveCount(1);
  await settled(page);

  const full = await new AxeBuilder({ page }).include(".notifications").analyze();
  expect(full.violations).toEqual([]);

  // And the header carrying a count, which is the piece with a colour decision
  // in it.
  await page.goto("/#/");
  await settled(page);
  const header = await new AxeBuilder({ page }).include(".site-header").analyze();
  expect(header.violations).toEqual([]);
});

test("it holds together at 320px", async ({ page, api }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await room(page, api, BEA);
  await comment(page, "A reasonably long thing to say about a wall in a city");

  await switchTo(page, ADA);
  await page.goto("/#/notifications");
  await expect(notices(page)).toHaveCount(1);

  const spills = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(spills).toBe(false);
});

// ── which ones are new ─────────────────────────────────────────────────────
test("the ones you hadn't seen are marked, and the marking waits for the list", async ({
  page,
  api,
}) => {
  // Found live rather than by reading the code. Opening the screen fires two
  // requests — fetch the list, tell the server they are seen — and sent
  // together they race *at the database*: the UPDATE can commit before the
  // SELECT runs, and then every row comes back already read and the rule down
  // the left, the only thing saying which of these are new, is drawn on none
  // of them. It went either way on successive loads.
  //
  // So the write waits for the list. This watches the order as well as the
  // outcome, because the outcome alone passes half the time on the bug.
  const order = [];
  page.on("request", (r) => {
    if (/notifications\/\?page=/.test(r.url())) order.push("list sent");
    if (/notifications\/read/.test(r.url())) order.push("read sent");
  });
  page.on("response", (r) => {
    if (/notifications\/\?page=/.test(r.request().url())) order.push("list back");
  });

  await room(page, api, BEA);
  await comment(page, "Something you have not seen yet");
  await switchTo(page, ADA);
  await page.goto("/#/notifications");
  await expect(notices(page)).toHaveCount(1);

  await expect(page.locator(".notice--unread")).toHaveCount(1);

  test.skip(order.length === 0, "no HTTP requests to observe in demo mode");
  expect(order.indexOf("list back")).toBeLessThan(order.indexOf("read sent"));
});

test("and they are not marked at all if the list never arrives", async ({
  page,
  api,
}) => {
  // The other half of waiting: they are seen once they have been shown. A list
  // that failed to load has shown nothing, so the count must survive it.
  await room(page, api, BEA);
  await comment(page, "Still unread after a failure");
  await switchTo(page, ADA);
  await expect(dot(page)).toBeVisible();
  await says(page, ", one unread");

  // Matched on the path alone — both stand-ins strip the query before testing
  // the rule — so this is queued after the poll has already been and gone,
  // which leaves the list as the next request through that path.
  await api.failNext({ method: "GET", path: "^/notifications/$", status: 500 });
  await page.goto("/#/notifications");
  await expect(page.locator(".feed__status")).toContainText("Couldn't load");

  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await expect(dot(page)).toBeVisible();
  await says(page, ", one unread");
});
