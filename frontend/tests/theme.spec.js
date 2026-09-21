// The theme, in three states.
//
// The gap this closes is small to describe and was permanent: the bootstrap in
// index.html follows `prefers-color-scheme` while `commons.theme` is absent,
// and the header toggle writes a concrete value — so the first press pinned
// the reader for ever and there was no way back. A laptop that goes dark at
// sunset stopped taking Commons with it because of one press months earlier.
//
// Two things make that worth a file of its own rather than a line in
// settings.spec.js. The state lives in three places that must never disagree —
// storage, the radios on `#/settings`, and the toggle in the header — and the
// interesting half of "System" is not what it does when you choose it but what
// it does an hour later when the machine changes its mind.
//
// `page.emulateMedia({ colorScheme })` is what stands in for the machine, and
// it does fire `change` on a live `matchMedia` list, which is what the app
// listens to. (The desktop app's own browser pane changes `matches` *without*
// dispatching, so this cannot be checked by hand there — only here.)

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled, accountButton } = require("./support/fixtures");

const ACCOUNT = { email: "ada@commons.test", password: "seedpassword" };

const radio = (page, value) =>
  page.locator(`input[name="commons-theme"][value="${value}"]`);
const toggle = (page) =>
  page.getByRole("button", { name: /switch to (light|dark) theme/i });
// Scoped to the theme's own fieldset. `.choice` and `.choice__step` were
// unique when this was the only radio group on the screen; the reading
// controls added two more, and a selector that was precise by accident is a
// selector that starts matching the wrong thing the moment the screen grows.
const themeGroup = (page) => page.locator('.choice:has(input[name="commons-theme"])');

/** What the three places currently say, which is the only thing worth asserting. */
const state = (page) =>
  page.evaluate(async () => {
    const a = await import("/js/actions.js");
    const checked = [...document.querySelectorAll('input[name="commons-theme"]')].find(
      (r) => r.checked
    );
    return {
      choice: a.themeChoice(),
      painted: a.currentTheme(),
      stored: localStorage.getItem("commons.theme"),
      radio: checked ? checked.value : null,
    };
  });

async function onSettings(page, api) {
  await api.seed(1, ACCOUNT.email);
  await api.signIn(page, ACCOUNT.email, ACCOUNT.password);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
}

// ── the default ────────────────────────────────────────────────────────────

test("a reader who has never chosen is following their machine", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);

  // Nothing stored, and that *is* the representation of "system" — see the
  // note in actions.js for why this is the absence of a key rather than the
  // string "system".
  expect(await state(page)).toEqual({
    choice: "system",
    painted: "dark",
    stored: null,
    radio: "system",
  });
});

test("the light machine gets the light theme, unasked", async ({ page, api }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await onSettings(page, api);

  const s = await state(page);
  expect(s.painted).toBe("light");
  expect(s.stored).toBeNull();
});

// ── the round trip the toggle could not make ──────────────────────────────

test("System, then pinned, then System again", async ({ page, api }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  expect((await state(page)).choice).toBe("system");

  await radio(page, "light").click();
  expect(await state(page)).toEqual({
    choice: "light",
    painted: "light",
    stored: "light",
    radio: "light",
  });

  // The whole point. Before this there was no control anywhere in the app
  // that could put the key back to absent.
  await radio(page, "system").click();
  expect(await state(page)).toEqual({
    choice: "system",
    painted: "dark",
    stored: null,
    radio: "system",
  });
});

test("the header toggle moves you off System, and says which way", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  expect((await state(page)).choice).toBe("system");

  await toggle(page).click();

  // No branch in the code does this — the toggle writes a concrete value and
  // a concrete value is not System. Asserted because it is the behaviour the
  // plan asked for, not because it was implemented.
  const s = await state(page);
  expect(s.choice).toBe("light");
  expect(s.stored).toBe("light");
});

// ── the three places never disagree ───────────────────────────────────────

test("pressing the toggle moves the radio, with the screen open", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);

  await radio(page, "dark").click();
  await expect(radio(page, "dark")).toBeChecked();

  await toggle(page).click();
  // Same event, both directions: the radios redraw from themeChoice() rather
  // than assuming they were what changed it.
  await expect(radio(page, "light")).toBeChecked();
  await expect(radio(page, "dark")).not.toBeChecked();
});

test("choosing a theme repaints the header's toggle", async ({ page, api }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);

  await radio(page, "light").click();
  // The button offers the *other* theme, so a light page offers dark.
  await expect(toggle(page)).toHaveAttribute("aria-label", "Switch to dark theme");

  await radio(page, "dark").click();
  await expect(toggle(page)).toHaveAttribute("aria-label", "Switch to light theme");
});

test("the palette can still change it, and the radio follows", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  await radio(page, "dark").click();

  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette__input").fill("theme");
  await page.keyboard.press("Enter");

  await expect(radio(page, "light")).toBeChecked();
  expect((await state(page)).stored).toBe("light");
});

// ── what System means an hour later ───────────────────────────────────────

test("on System, the machine changing its mind changes the app", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  await radio(page, "system").click();
  expect((await state(page)).painted).toBe("dark");

  // Sunset. Without the matchMedia listener this is where "System" quietly
  // degraded into "whatever the system was saying when this tab loaded" —
  // the failure the setting exists to prevent, one layer further down.
  await page.emulateMedia({ colorScheme: "light" });

  await expect.poll(async () => (await state(page)).painted).toBe("light");
  const s = await state(page);
  expect(s.choice).toBe("system");
  expect(s.stored).toBeNull();
  expect(s.radio).toBe("system");
});

test("pinned, the machine changing its mind changes nothing", async ({ page, api }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  await radio(page, "dark").click();

  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(300);

  // The guard is the other half of the feature: a reader who asked for dark
  // asked for dark, and their machine is not entitled to a second opinion.
  const s = await state(page);
  expect(s.painted).toBe("dark");
  expect(s.stored).toBe("dark");
});

test("the title bar follows the machine too", async ({ page, api }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  await radio(page, "system").click();

  const colour = () =>
    page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]').getAttribute("content")
    );
  const dark = await colour();

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => (await state(page)).painted).toBe("light");

  // An installed window's title bar is painted from this. It is set from --bg
  // rather than typed, so it cannot drift from the page under it — but only
  // if something remembers to set it when the machine is what changed.
  await expect.poll(colour).not.toBe(dark);
});

// ── it survives the round trip through storage ────────────────────────────

test("System survives a reload as System, not as whatever it looked like", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await onSettings(page, api);
  await radio(page, "light").click();
  expect((await state(page)).stored).toBe("light");

  await radio(page, "system").click();
  await page.reload();
  await expect(page.locator(".data")).toBeVisible();

  // The trap this guards: "reset to system" implemented as "store whatever
  // the system currently says" looks identical right now and is pinned for
  // ever. After a reload the difference is the only thing visible.
  expect(await state(page)).toEqual({
    choice: "system",
    painted: "light",
    stored: null,
    radio: "system",
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await state(page)).painted).toBe("dark");
});

test("a pinned theme survives a reload", async ({ page, api }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await onSettings(page, api);
  await radio(page, "dark").click();

  await page.reload();
  await expect(page.locator(".data")).toBeVisible();
  expect(await state(page)).toEqual({
    choice: "dark",
    painted: "dark",
    stored: "dark",
    radio: "dark",
  });
});

// ── where it meets the data panel ─────────────────────────────────────────

test("the data panel calls System 'nothing set', because nothing is", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);

  await radio(page, "dark").click();
  await expect(page.locator('[data-row="appearance"]')).toContainText(
    "Theme, text size"
  );

  await radio(page, "system").click();
  // The reason the absence of a key was chosen over the string "system": the
  // panel that lists what this browser holds can say, truthfully, that it
  // holds nothing for a reader whose position is "I have no preference".
  await expect(page.locator('[data-row="appearance"]')).toContainText("Nothing set");
});

test("the panel's Reset and the System radio land in the same place", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  await radio(page, "light").click();

  await page.locator('[data-row="appearance"] .data__do').click();

  await expect(radio(page, "system")).toBeChecked();
  expect(await state(page)).toEqual({
    choice: "system",
    painted: "dark",
    stored: null,
    radio: "system",
  });
});

// ── the quality floor ──────────────────────────────────────────────────────

test("the group is reachable and operable by keyboard alone", async ({ page, api }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  await radio(page, "system").click();

  // A radio group is one tab stop and the arrows move within it — which is
  // the reason it is a radio group rather than three buttons with
  // aria-pressed, and is worth one assertion so it stays one.
  await radio(page, "system").focus();
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, "light")).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, "dark")).toBeChecked();
  expect((await state(page)).stored).toBe("dark");
});

test("the legend names the group without printing it twice", async ({ page, api }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);

  // The h3 above it already says "Theme". The legend stays for the accessible
  // name and comes off the screen, so the group is still announced as a group.
  await expect(themeGroup(page).locator("legend")).toHaveClass(/visually-hidden/);
  await expect(page.getByRole("group", { name: "Theme" })).toBeAttached();
});

test("axe is clean on the picker, in all three states", async ({ page, api }) => {
  await onSettings(page, api);

  for (const choice of ["system", "light", "dark"]) {
    await radio(page, choice).click();
    await settled(page);
    const { violations } = await new AxeBuilder({ page })
      .include(".settings")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
    expect(summary, `${choice}:\n${summary.join("\n")}`).toEqual([]);
  }
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("all three fit on one row without a sideways scroll", async ({ page, api }) => {
    await onSettings(page, api);

    const boxes = await themeGroup(page)
      .locator(".choice__step")
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), height: Math.round(r.height) };
        })
      );
    expect(boxes).toHaveLength(3);
    // Same row: a three-way choice that wraps reads as two choices and one
    // stray, which is how somebody misses that System is an option.
    expect(new Set(boxes.map((b) => b.top)).size).toBe(1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

// ── and the feed still works, which is what the theme is for ──────────────

test("the choice reaches every screen, not just the one it was made on", async ({
  page,
  api,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await onSettings(page, api);
  await radio(page, "light").click();

  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  expect((await state(page)).painted).toBe("light");
  await expect(accountButton(page)).toBeVisible();
});
