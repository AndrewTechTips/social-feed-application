// What you are told about, whether it reaches the app icon, and how much of
// the app moves — the last three settings on `#/settings`.
//
// ── the one that needed thinking about ────────────────────────────────────
// `/notifications/` has no `kind` parameter, and the unread count has always
// been the envelope's `total` for a one-row page. Switch a kind off and that
// number is no longer the number: the server counts rows the reader has
// asked not to hear about.
//
// So the filtering is client-side, and the cost is contained rather than
// waved at — with both kinds on (everybody who has never opened settings)
// the cheap one-row ask is unchanged; with one off, the *same single
// request* comes back with a page of rows and the matching ones are counted
// here. The tests below pin both halves, because the failure mode of the
// clever version is a count that quietly disagrees with the list under it.
//
// ── and the one that is two rules in two places ───────────────────────────
// Reduced motion is a media query in base.css and an attribute selector
// beside it, because a media query and an attribute cannot share a rule. Two
// copies of six declarations is exactly the kind of thing that drifts, so
// one test here compares what the browser computes under each.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const ADA = "ada@commons.test";
const BEA = "bea@commons.test";
const PW = "seedpassword";

const sw = (page, label) => page.getByRole("checkbox", { name: label });
const prefs = (page) =>
  page.evaluate(async () => (await import("/js/notify.js")).notifyPrefs());
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

async function onSettings(page, api, { posts = 1 } = {}) {
  await api.seed(posts, ADA);
  await api.signIn(page, ADA, PW);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
}

/**
 * Bea says something on Ada's post, then Ada comes back to find it.
 *
 * Everything through the interface and in this order, for the reason
 * notifications.spec.js spells out: in demo mode the page is handed a
 * snapshot when a session is installed, so anything the fixture creates
 * afterwards exists in Node and nowhere the app can see.
 *
 * @param {"reply" | "comment"} kind
 */
async function addressAda(page, api, kind) {
  await api.seed(1, ADA);
  await api.register(BEA, PW, "bea");

  if (kind === "reply") {
    // A reply needs something of Ada's to answer, so Ada comments first.
    await api.signIn(page, ADA, PW);
    await say(page, "Ada opens the thread");
    await signInWithForm(page, BEA);
    // signInWithForm lands on the feed; the reply control is on the post.
    await expect(page.locator(CARD).first()).toBeVisible();
    await page.locator(`${CARD} .card__link`).first().click();
    await expect(page.locator(".comment").first()).toBeVisible();
    await page.locator(".comment__reply").first().click();
    const form = page.locator(".composer--reply");
    await form.locator("textarea").fill("Answering you directly");
    await form.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(page.locator(".comment--reply")).toHaveCount(1);
  } else {
    await api.signIn(page, BEA, PW);
    await say(page, "A comment on your post");
  }
  await signInWithForm(page, ADA);
}

/** Say something on the first post, as whoever is signed in. */
async function say(page, words) {
  if (!/#\/$/.test(page.url())) await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.getByLabel("Add a comment").fill(words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment").last()).toContainText(words);
}

/** Sign in through the form — see notifications.spec.js for why not api.signIn. */
async function signInWithForm(page, email) {
  const trigger = page.getByRole("button", { name: /^Your account/ });
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  }
  await page.goto("/#/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
}

// ── the switches themselves ────────────────────────────────────────────────

test("everything is on, and nothing is stored to say so", async ({ page, api }) => {
  await onSettings(page, api);

  await expect(sw(page, "Replies to you")).toBeChecked();
  await expect(sw(page, "Comments on your posts")).toBeChecked();
  await expect(sw(page, "Show the count on the app icon")).toBeChecked();
  await expect(sw(page, "Reduce motion in Commons")).not.toBeChecked();

  // The same rule the theme follows: a reader who has changed nothing has
  // nothing written down, so the data panel can say so truthfully.
  expect(await stored(page, "commons.notify")).toBeNull();
  expect(await stored(page, "commons.motion")).toBeNull();
});

test("only the difference from the default is written down", async ({ page, api }) => {
  await onSettings(page, api);

  await sw(page, "Replies to you").uncheck();
  expect(JSON.parse(await stored(page, "commons.notify"))).toEqual({ reply: false });

  await sw(page, "Replies to you").check();
  expect(await stored(page, "commons.notify")).toBeNull();
});

test("the switches survive a reload", async ({ page, api }) => {
  await onSettings(page, api);
  await sw(page, "Comments on your posts").uncheck();
  await sw(page, "Reduce motion in Commons").check();

  await page.reload();
  await expect(page.locator(".data")).toBeVisible();
  await expect(sw(page, "Comments on your posts")).not.toBeChecked();
  await expect(sw(page, "Reduce motion in Commons")).toBeChecked();
  expect(await prefs(page)).toMatchObject({ reply: true, comment: false });
});

// ── the count has to mean what the list shows ─────────────────────────────

test("a switched-off kind stops being counted", async ({ page, api }) => {
  await addressAda(page, api, "comment");

  const account = page.getByRole("button", { name: /^Your account/ });
  await expect(account).toHaveAttribute("aria-label", /one unread$/);

  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  await sw(page, "Comments on your posts").uncheck();

  // setNotifyPref re-asks immediately rather than leaving the header wrong
  // for up to forty-five seconds.
  await expect
    .poll(async () => account.getAttribute("aria-label"))
    .toBe("Your account, ada");
  await expect(page.locator(".accmenu__dot")).toBeHidden();
});

test("and the list agrees with it", async ({ page, api }) => {
  await addressAda(page, api, "comment");

  await page.goto("/#/notifications");
  await expect(page.locator(".notice")).toHaveCount(1);

  await page.goto("/#/settings");
  await sw(page, "Comments on your posts").uncheck();
  await page.goto("/#/notifications");

  // A screen showing a kind the header has been told to stop counting would
  // make one of the two numbers a lie. Both come from the same function.
  await expect(page.locator(".notice")).toHaveCount(0);
});

test("an empty list says which switch emptied it", async ({ page, api }) => {
  await addressAda(page, api, "comment");

  await page.goto("/#/settings");
  await sw(page, "Comments on your posts").uncheck();
  await page.goto("/#/notifications");

  // "Nothing yet" here would blame an empty inbox for a setting the reader
  // chose, with no hint of where to undo it.
  await expect(page.locator(".feed__status")).toContainText("turned off");
  await expect(page.locator(".feed__status")).toContainText("Settings");
});

test("the other kind still comes through", async ({ page, api }) => {
  await addressAda(page, api, "reply");

  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  await sw(page, "Comments on your posts").uncheck();

  // A reply is not a comment-on-your-post, so switching the second off must
  // leave the first alone — which is the whole point of two switches.
  const account = page.getByRole("button", { name: /^Your account/ });
  await expect
    .poll(async () => account.getAttribute("aria-label"))
    .toMatch(/one unread$/);
  await page.goto("/#/notifications");
  await expect(page.locator(".notice")).toHaveCount(1);
  await expect(page.locator(".notice__who")).toContainText("replied to you");
});

test("with both off, nothing is counted and nothing is asked for", async ({
  page,
  api,
}) => {
  await addressAda(page, api, "comment");
  await page.goto("/#/settings");
  await sw(page, "Replies to you").uncheck();
  await sw(page, "Comments on your posts").uncheck();

  const account = page.getByRole("button", { name: /^Your account/ });
  await expect
    .poll(async () => account.getAttribute("aria-label"))
    .toBe("Your account, ada");

  // refreshUnread returns before it fetches when neither kind is wanted —
  // there is no number that could come back and be used.
  const asked = [];
  page.on("request", (r) => {
    if (r.url().includes("/notifications/")) asked.push(r.url());
  });
  await page.evaluate(async () => {
    const n = await import("/js/notify.js");
    await n.refreshUnread();
  });
  expect(asked).toEqual([]);
});

// ── the badge ──────────────────────────────────────────────────────────────

test("the badge switch stops the count reaching the app icon", async ({
  page,
  api,
}) => {
  await page.addInitScript(() => {
    window.__badge = [];
    Navigator.prototype.setAppBadge = function (n) {
      window.__badge.push(n ?? 0);
      return Promise.resolve();
    };
    Navigator.prototype.clearAppBadge = function () {
      window.__badge.push(0);
      return Promise.resolve();
    };
  });
  await addressAda(page, api, "comment");
  await expect.poll(() => page.evaluate(() => window.__badge.at(-1))).toBe(1);

  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  await sw(page, "Show the count on the app icon").uncheck();

  // Zero rather than "stop calling it": the badge outlives the tab, so
  // leaving yesterday's number on the icon would be the switch doing nothing
  // in the only place it can be seen.
  await expect.poll(() => page.evaluate(() => window.__badge.at(-1))).toBe(0);
});

test("turning the badge off leaves the count in the app alone", async ({
  page,
  api,
}) => {
  await addressAda(page, api, "comment");
  await page.goto("/#/settings");
  await sw(page, "Show the count on the app icon").uncheck();

  // It is a setting about the reader's dock, not about what Commons knows.
  const account = page.getByRole("button", { name: /^Your account/ });
  await expect(account).toHaveAttribute("aria-label", /one unread$/);
});

// ── motion ─────────────────────────────────────────────────────────────────

test("the motion switch sets the attribute the stylesheet branches on", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  await sw(page, "Reduce motion in Commons").check();
  expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe(
    "reduce"
  );
  expect(await stored(page, "commons.motion")).toBe("reduce");

  await sw(page, "Reduce motion in Commons").uncheck();
  expect(
    await page.evaluate(() => document.documentElement.dataset.motion)
  ).toBeUndefined();
  expect(await stored(page, "commons.motion")).toBeNull();
});

test("it is applied before the first paint, like the theme", async ({ page, api }) => {
  await onSettings(page, api);
  await sw(page, "Reduce motion in Commons").check();
  await page.reload();

  // The inline script in index.html, not a module — the aurora starts on the
  // first frame and a reader who asked for less motion should not get one
  // frame of it while JavaScript loads.
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
});

test("the attribute and the media query say the same thing", async ({ page, api }) => {
  await onSettings(page, api);

  const durations = async () =>
    page.evaluate(() => {
      const el = document.querySelector(".data__row");
      const cs = getComputedStyle(el);
      return { animation: cs.animationDuration, transition: cs.transitionDuration };
    });

  await sw(page, "Reduce motion in Commons").check();
  const viaAttribute = await durations();

  await sw(page, "Reduce motion in Commons").uncheck();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const viaMediaQuery = await durations();

  // base.css cannot put an attribute selector inside a media query, so the
  // six declarations exist twice. This is the only thing standing between
  // that and the usual fate of a duplicated block.
  expect(viaAttribute).toEqual(viaMediaQuery);
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("it turns off the view transition, which no stylesheet can reach", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await sw(page, "Reduce motion in Commons").check();

  // ::view-transition-* are not descendants of anything base.css matches, and
  // the API runs its own cross-fade regardless — so the decision is made in
  // JavaScript before the transition starts, and it has to ask this too.
  expect(
    await page.evaluate(async () => (await import("/js/transitions.js")).canMorph())
  ).toBe(false);
});

// ── where they meet the data panel ────────────────────────────────────────

test("the data panel names the settings that have been changed", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  const row = page.locator('[data-row="settings"]');
  await expect(row).toContainText("Nothing changed");

  await sw(page, "Replies to you").uncheck();
  await sw(page, "Reduce motion in Commons").check();

  // Named rather than counted: "two settings" tells a reader nothing about
  // which two, on the one screen whose job is saying what is stored.
  await expect(row).toContainText("replies off");
  await expect(row).toContainText("reduced motion");

  await row.locator(".data__do").click();
  await expect(row).toContainText("Nothing changed");
  await expect(sw(page, "Replies to you")).toBeChecked();
  await expect(sw(page, "Reduce motion in Commons")).not.toBeChecked();
  expect(await stored(page, "commons.notify")).toBeNull();
  expect(await stored(page, "commons.motion")).toBeNull();
});

// ── about ──────────────────────────────────────────────────────────────────

test("About says what this copy of Commons is doing", async ({ page, api }) => {
  await onSettings(page, api);

  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Installed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Offline" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the colophon" })).toHaveAttribute(
    "href",
    "#/colophon"
  );
  await expect(page.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();

  // No version number, and that is deliberate — there is no build step to
  // number and no artefact to point at. See the note in views/settings.js.
  await expect(page.locator(".settings")).not.toContainText("Version");
});

test("the offline line tells the truth about the worker", async ({ page, api }) => {
  await onSettings(page, api);

  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  const offline = page.locator(".settings__section", {
    has: page.getByRole("heading", { name: "Offline" }),
  });

  if (controlled) {
    await expect(offline).toContainText("cached here");
    await expect(
      offline.getByRole("button", { name: "Check for a new version" })
    ).toBeVisible();
  } else {
    // The worker claims the page on the *next* load after it installs, so a
    // first visit legitimately has none — and offering to check for a new
    // version of something that is not there would be a dead control.
    await expect(offline).toContainText("needs the network");
    await expect(
      offline.getByRole("button", { name: "Check for a new version" })
    ).toBeHidden();
  }
});

// ── the quality floor ──────────────────────────────────────────────────────

test("every switch is a real checkbox, reachable and named", async ({ page, api }) => {
  await onSettings(page, api);

  for (const label of [
    "Replies to you",
    "Comments on your posts",
    "Show the count on the app icon",
    "Reduce motion in Commons",
  ]) {
    const box = sw(page, label);
    await expect(box).toBeAttached();
    // Space, because these are checkboxes rather than buttons pretending.
    await box.focus();
    const before = await box.isChecked();
    await page.keyboard.press("Space");
    expect(await box.isChecked()).toBe(!before);
    await page.keyboard.press("Space");
  }
});

test("axe is clean on the whole screen, both themes", async ({ page, api }) => {
  await onSettings(page, api);
  await sw(page, "Replies to you").uncheck();
  await sw(page, "Reduce motion in Commons").check();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await settled(page);
    const { violations } = await new AxeBuilder({ page })
      .include(".settings")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
    expect(summary, `${theme}:\n${summary.join("\n")}`).toEqual([]);
  }
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("the switches stack and nothing spills sideways", async ({ page, api }) => {
    await onSettings(page, api);
    await expect(sw(page, "Reduce motion in Commons")).toBeAttached();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
