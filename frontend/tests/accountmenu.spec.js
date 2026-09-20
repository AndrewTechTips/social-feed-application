// The account menu — the header's one door.
//
// Six controls became three, and everything that used to be a button in the
// header is now behind an avatar. That trade is only worth making if the door
// is as good as the buttons were, so this is the file that holds it to it:
// where the panel lands, what the keyboard can do, what closes it, and what a
// screen reader is told.
//
// These tests drive the menu by hand rather than through the openAccountMenu
// helper in fixtures.js, on purpose. Twenty other specs use that helper to get
// past the menu on the way to their own subject; this one *is* the subject,
// and a helper that hides the interaction would be hiding the thing under test.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const ACCOUNT = { email: "ada@commons.test", password: "seedpassword" };

const trigger = (page) => page.getByRole("button", { name: /^Your account/ });
const panel = (page) => page.getByRole("menu");
const item = (page, name) => page.getByRole("menuitem", { name });

async function signedIn(page, api, { posts = 2 } = {}) {
  await api.seed(posts, ACCOUNT.email);
  await api.signIn(page, ACCOUNT.email, ACCOUNT.password);
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
}

// ── the header it reclaims ─────────────────────────────────────────────────

test("signed in, the header is three controls and the rest is behind the avatar", async ({
  page,
  api,
}) => {
  await signedIn(page, api);

  // What is left on the surface: a one-press action, a one-press action, and
  // the door. The rule the menu is built on, asserted rather than described.
  await expect(page.getByRole("link", { name: "Write a post" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /switch to (light|dark) theme/i })
  ).toBeVisible();
  await expect(trigger(page)).toBeVisible();

  // And what is not: the four that used to be here in their own right.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
  // Direct children of the cluster: the menu's own rows are descendants of
  // .account too, and a looser selector would find those and prove nothing.
  await expect(page.locator(".account > a[href='#/shelf']")).toHaveCount(0);
  await expect(page.locator(".account > a[href='#/notifications']")).toHaveCount(0);

  // The menu is closed until it is asked for — a popover that renders open is
  // a panel, and this one covers the feed.
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
});

test("signed out there is no menu, and the way in is still a link", async ({
  page,
  api,
}) => {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();

  await expect(trigger(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});

// ── the door itself ────────────────────────────────────────────────────────

test("it opens onto every destination the header used to carry", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await trigger(page).click();

  await expect(panel(page)).toBeVisible();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");

  // Including the one the whole plan is about: settings had exactly one link
  // to it in the entire app, on a screen you had to already know to visit.
  await expect(item(page, /Settings/)).toHaveAttribute("href", "#/settings");
  await expect(item(page, /Your shelf/)).toHaveAttribute("href", "#/shelf");
  await expect(item(page, /Notifications/)).toHaveAttribute("href", "#/notifications");
  await expect(item(page, "Sign out")).toBeVisible();
  // And your own name, pointing where anyone else's byline points.
  await expect(page.locator(".accmenu__who")).toHaveAttribute("href", "#/u/ada");
});

test("choosing settings gets you there, and shuts the menu behind you", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await trigger(page).click();
  await item(page, /Settings/).click();

  await expect(page).toHaveURL(/#\/settings$/);
  // Light dismiss does not fire for a press *inside* the panel, so without the
  // handler that closes on a choice the reader arrives at the new screen with
  // the old menu still hanging over it.
  await expect(panel(page)).toBeHidden();
});

test("a route change from anywhere else takes the menu with it", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();

  // Not a click on a row — the command palette, which knows nothing about the
  // menu and would otherwise leave it floating over a screen it does not
  // belong to.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.locator(".palette__input").fill("feed");
  await page.keyboard.press("Enter");

  await expect(panel(page)).toBeHidden();
});

test("signing out from the menu signs you out", async ({ page, api }) => {
  await signedIn(page, api);
  await trigger(page).click();
  await item(page, "Sign out").click();

  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);
});

// ── closing ────────────────────────────────────────────────────────────────

test("a press outside closes it", async ({ page, api }) => {
  await signedIn(page, api);
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();

  await page.locator(".brand").click({ trial: false, force: true });
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
});

test("pressing the trigger again closes it rather than reopening it", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();

  // The classic bug in a hand-rolled menu: the outside-click rule closes it on
  // pointerdown and the trigger's own handler opens it straight back up, so
  // the menu cannot be shut with the control that opened it. `popovertarget`
  // is the browser doing that bookkeeping — this is the assertion that says so.
  await trigger(page).click();
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
});

test("Escape closes it and hands focus back to the avatar", async ({ page, api }) => {
  await signedIn(page, api);
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("Tab leaves rather than being trapped", async ({ page, api }) => {
  await signedIn(page, api);
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();

  // A menu is not a dialog. Trapping focus in four links would be the app
  // refusing to let go of somebody who pressed the wrong thing.
  await expect(page.locator(".accmenu__who")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel(page)).toBeHidden();

  // And it carries on *past* the button rather than parking on it, which is
  // what the APG asks of a menu button: the keypress moves focus back to the
  // trigger and is left uncancelled, so the browser's own tab order takes it
  // from there. One key, and you are back in the page.
  const where = await page.evaluate(() => ({
    inMenu: !!document.activeElement.closest(".accmenu"),
    tag: document.activeElement.tagName,
  }));
  expect(where.inMenu, "focus never left the menu").toBe(false);
});

// ── the keyboard ───────────────────────────────────────────────────────────

test("the arrow keys walk the rows, and wrap at both ends", async ({ page, api }) => {
  await signedIn(page, api);
  await trigger(page).click();

  // The class rather than the label: "ada" is a substring of the trigger's own
  // accessible name, so a name-based check here passes whether focus made it
  // into the menu or not — which is exactly the bug this test is for.
  const focused = () => page.evaluate(() => document.activeElement.className);

  // Opening lands on the first row, so the arrows work without a Tab first —
  // which is the thing people actually try. `toggle` is queued, so this is the
  // one place worth waiting for rather than reading straight away.
  await expect(page.locator(".accmenu__who")).toBeFocused();
  expect(await focused()).toContain("accmenu__who");

  const href = () => page.evaluate(() => document.activeElement.getAttribute("href"));

  await page.keyboard.press("ArrowDown");
  expect(await href()).toBe("#/shelf");
  await page.keyboard.press("ArrowDown");
  expect(await href()).toBe("#/notifications");

  await page.keyboard.press("End");
  expect(await focused()).toContain("accmenu__row--out");
  // Past the end is the beginning: a menu you can fall off the bottom of makes
  // you count rows.
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toContain("accmenu__who");
  await page.keyboard.press("ArrowUp");
  expect(await focused()).toContain("accmenu__row--out");
  await page.keyboard.press("Home");
  expect(await focused()).toContain("accmenu__who");
});

test("it can be opened and driven without ever touching the mouse", async ({
  page,
  api,
}) => {
  await signedIn(page, api);

  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(panel(page)).toBeVisible();

  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp"); // Settings, one above Sign out
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/#\/settings$/);
});

// ── what it says ───────────────────────────────────────────────────────────

test("the unread count moves to a dot on the avatar and a number in the menu", async ({
  page,
  api,
}) => {
  // Everything through the interface, and in this order, for the reason
  // notifications.spec.js spells out: in demo mode the page is handed a
  // snapshot of the backend when a session is installed, so anything the
  // fixture creates afterwards exists in Node and nowhere the app can see it.
  await api.seed(1, ACCOUNT.email);
  await api.register("bea@commons.test", ACCOUNT.password, "bea");
  await api.signIn(page, "bea@commons.test", ACCOUNT.password);

  // Bea says something on Ada's post.
  await page.goto("/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.getByLabel("Add a comment").fill("Saying so.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment").last()).toContainText("Saying so.");

  // Ada comes back to find it — through the form, so the adapter the page is
  // running is the one that answers.
  await trigger(page).click();
  await item(page, "Sign out").click();
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(ACCOUNT.email);
  await page.getByLabel("Password", { exact: true }).fill(ACCOUNT.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);

  // The lamp used to be the one control in this header entitled to a count.
  // With it behind a closed door the signal has to survive somewhere, so the
  // avatar takes a dot — *that* there is something, not how many.
  await expect(page.locator(".accmenu__dot")).toBeVisible();
  // And the number is said in words, because a dot says nothing out loud.
  await expect(trigger(page)).toHaveAttribute("aria-label", /one unread$/);

  await trigger(page).click();
  await expect(item(page, /Notifications, one unread/)).toBeVisible();
  await expect(
    page.locator(".accmenu__row[href='#/notifications'] .accmenu__count")
  ).toHaveText("1");
});

test("with nothing waiting there is no dot and no number", async ({ page, api }) => {
  await signedIn(page, api);

  await expect(page.locator(".accmenu__dot")).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-label", "Your account, ada");

  await trigger(page).click();
  await expect(item(page, "Notifications")).toBeVisible();
  await expect(
    page.locator(".accmenu__row[href='#/notifications'] .accmenu__count")
  ).toBeHidden();
});

test("a poll landing under an open menu does not shut it", async ({ page, api }) => {
  await signedIn(page, api);
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();

  // renderAccount() runs on every store change, every shelf change and every
  // notification poll, and it used to rebuild the whole cluster — which would
  // take an open popover out of the document under the reader's cursor. This
  // is the assertion behind "built once and kept".
  await page.evaluate(() => {
    dispatchEvent(new CustomEvent("commons:shelf", { detail: 1 }));
    dispatchEvent(new CustomEvent("commons:notifications", { detail: 2 }));
  });

  await expect(panel(page)).toBeVisible();
  await expect(page.locator(".accmenu__who")).toBeFocused();
});

// ── where it lands ─────────────────────────────────────────────────────────

test("it hangs under the avatar, right edges flush, and stays on screen", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
  // It arrives with a 120ms scale(0.98) on it, and getBoundingClientRect sees
  // transforms — so measuring before the entrance has finished measures a
  // panel 2.7px narrower than the one that ends up on screen. Not a rounding
  // error to paper over with a looser bound: the wrong thing, measured.
  await settled(page);

  const { t, p, vw, vh } = await page.evaluate(() => {
    const tr = document.getElementById("account-menu-button").getBoundingClientRect();
    const pr = document.getElementById("account-menu").getBoundingClientRect();
    return {
      t: { right: tr.right, bottom: tr.bottom },
      p: { left: pr.left, right: pr.right, top: pr.top, bottom: pr.bottom },
      vw: innerWidth,
      vh: innerHeight,
    };
  });

  expect(Math.abs(p.right - t.right), "right edges are not flush").toBeLessThanOrEqual(
    1
  );
  expect(
    p.top - t.bottom,
    "the panel is not sitting under the trigger"
  ).toBeGreaterThan(0);
  expect(p.left).toBeGreaterThanOrEqual(0);
  expect(p.right).toBeLessThanOrEqual(vw);
  expect(p.bottom).toBeLessThanOrEqual(vh);
});

test("on a short screen it shrinks to fit instead of running off the bottom", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  // Well short of what the panel wants, which is the case the max-height in
  // place() exists for — a landscape phone, or a window somebody has squashed.
  // Deliberately not marginal: a height where the panel *nearly* fits proves
  // nothing either way.
  await page.setViewportSize({ width: 480, height: 240 });
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
  await settled(page);

  const fit = await page.evaluate(() => {
    const el = document.getElementById("account-menu");
    const r = el.getBoundingClientRect();
    return {
      bottom: r.bottom,
      vh: innerHeight,
      scrollable: el.scrollHeight > el.clientHeight,
    };
  });
  expect(fit.bottom).toBeLessThanOrEqual(fit.vh);
  expect(fit.scrollable, "it should be reachable by scrolling, not cut off").toBe(true);
});

test("it follows the avatar when the window is resized under it", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();

  await settled(page);
  await page.setViewportSize({ width: 700, height: 780 });
  // No scroll listener — the header is sticky, so the trigger does not move
  // when the page does — but a resize moves it, and the panel has to come too.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const t = document
          .getElementById("account-menu-button")
          .getBoundingClientRect();
        const p = document.getElementById("account-menu").getBoundingClientRect();
        return Math.round(Math.abs(p.right - t.right));
      })
    )
    .toBeLessThanOrEqual(1);
});

// ── at 320px ───────────────────────────────────────────────────────────────

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("the avatar is a full tap target and the panel fits the screen", async ({
    page,
    api,
  }) => {
    await signedIn(page, api);

    const box = await trigger(page).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);

    await trigger(page).tap();
    await expect(panel(page)).toBeVisible();

    const p = await panel(page).boundingBox();
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(320);

    // The whole reason for the change: nothing overflows sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

// ── the machine check ──────────────────────────────────────────────────────

test("axe is clean on the open menu, in both themes", async ({ page, api }) => {
  await signedIn(page, api);

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      localStorage.setItem("commons.theme", t);
    }, theme);

    if (await panel(page).isHidden()) await trigger(page).click();
    await expect(panel(page)).toBeVisible();
    await settled(page);

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const summary = violations.map(
      (v) => `${v.id} (${v.impact}) — ${v.nodes.length}×: ${v.help}`
    );
    expect(summary, `${theme} theme:\n${summary.join("\n")}`).toEqual([]);
  }
});
