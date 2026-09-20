// Installing Commons — the four states, two of which draw nothing.
//
// ── the thing this file cannot do, and says so ─────────────────────────────
// It cannot make Chrome fire `beforeinstallprompt` on its own. Chrome
// suppresses the install promotion under automation, and it stays suppressed
// with `--enable-automation` dropped, with `AutomationControlled` disabled, in
// headed mode, and in real Chrome rather than the bundled Chromium — all four
// were tried. `"onbeforeinstallprompt" in window` is true throughout; the
// event simply never comes.
//
// So the event is dispatched here instead, as closely as a test can make one:
// a cancelable Event of the right type carrying a `prompt()` and a
// `userChoice`, which is the entire surface js/install.js touches. What that
// leaves untested is Chrome's decision to fire — which is Chrome's, not ours,
// and which tests/offline.spec.js already covers from the other end by holding
// the manifest to the criteria that decision is made on.
//
// Everything downstream of the event is ours and is tested for real: the
// catch, the preventDefault, the render, the single-use discard, and the three
// states that are reached without an event at all.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const BLOCK = ".masthead__install";
const BUTTON = `${BLOCK} button`;
const HOW = ".install-how";

/**
 * Chrome's event, stubbed. `cancelable` so that preventDefault() is observable
 * — that is the mechanic worth holding this code to, because without it Chrome
 * shows its own mini-infobar and the button never gets a turn.
 *
 * `window.__promptCalls` counts the calls, which is how "the second press does
 * nothing" is asked as a question rather than asserted as a shape.
 *
 * @param {"accepted" | "dismissed"} outcome
 */
function fireScript(outcome = "accepted") {
  return `(() => {
    const ev = new Event("beforeinstallprompt", { cancelable: true });
    window.__promptCalls = 0;
    ev.prompt = () => { window.__promptCalls++; return Promise.resolve(); };
    ev.userChoice = Promise.resolve({ outcome: ${JSON.stringify(outcome)}, platform: "web" });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`;
}

/** Fire it after the app has drawn, the way Chrome does. */
const fire = (page, outcome) => page.evaluate(fireScript(outcome));

/** Open the feed with cards on it. */
async function feed(page, api) {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);
}

// ── state 4: a browser that cannot install ─────────────────────────────────
test("offers nothing at all where there is nothing to offer", async ({ page, api }) => {
  await feed(page, api);

  // Present in the document — the event can arrive at any point after the feed
  // has drawn, and it needs somewhere to appear — but not on the page.
  await expect(page.locator(BLOCK)).toHaveCount(1);
  await expect(page.locator(BLOCK)).toBeHidden();
  await expect(page.locator(BUTTON)).toHaveCount(0);
  await expect(page.locator(HOW)).toHaveCount(0);

  // And never a disabled control, anywhere, which is the failure mode this
  // whole design is arranged around.
  await expect(page.locator(`${BLOCK} [disabled]`)).toHaveCount(0);
});

test("the palette has no row for it either", async ({ page, api }) => {
  await feed(page, api);
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette")).toBeVisible();
  await expect(page.getByRole("option", { name: /install|home screen/i })).toHaveCount(
    0
  );
});

// ── state 1: the event fired ───────────────────────────────────────────────
test("catches the event, and cancels it so Chrome doesn't take the turn", async ({
  page,
  api,
}) => {
  await feed(page, api);
  // Without preventDefault this is false and Chrome shows its mini-infobar
  // instead of letting the masthead offer.
  expect(await fire(page)).toBe(true);
});

test("the offer appears when the event does, and reads like the type around it", async ({
  page,
  api,
}) => {
  await feed(page, api);
  await expect(page.locator(BLOCK)).toBeHidden();

  await fire(page);

  await expect(page.locator(BLOCK)).toBeVisible();
  await expect(page.locator(".masthead__install-line")).toHaveText(
    "It installs, too — it works on a plane."
  );
  await expect(page.locator(BUTTON)).toHaveText("Install Commons");
  // A button, not a link dressed as one: it does something, it doesn't go
  // anywhere.
  await expect(page.locator(BUTTON)).toHaveAttribute("type", "button");
});

test("the offer is there on the first paint when the event beat the feed to it", async ({
  page,
  api,
}) => {
  // The other order, and the one that actually happens on a return visit: the
  // worker is already registered, so Chrome can decide before the feed has
  // rendered. js/install.js registers its listener at module scope, which runs
  // before DOMContentLoaded — so this lands after it and before the masthead.
  await page.addInitScript(`
    addEventListener("DOMContentLoaded", () => { ${fireScript()} });
  `);
  await feed(page, api);

  // No repaint was involved: the block was built in the state it is in.
  await expect(page.locator(BUTTON)).toHaveText("Install Commons");
});

test("pressing it prompts once, and a second press does nothing", async ({
  page,
  api,
}) => {
  await feed(page, api);
  await fire(page);
  await expect(page.locator(BUTTON)).toBeVisible();

  // Both presses in one tick, which is how a button gets pressed twice in
  // practice. The stashed event is single-use and prompt() throws on a spent
  // one, so this is the race the discard-before-await is there for.
  const calls = await page.evaluate(async () => {
    const btn = /** @type {HTMLButtonElement} */ (
      document.querySelector(".masthead__install button")
    );
    btn.click();
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return window.__promptCalls;
  });
  expect(calls).toBe(1);

  // And it is gone, so there is nothing left to press a third time.
  await expect(page.locator(BUTTON)).toHaveCount(0);
  await expect(page.locator(BLOCK)).toBeHidden();
});

for (const outcome of ["accepted", "dismissed"]) {
  test(`the control goes when the prompt resolves — ${outcome}`, async ({
    page,
    api,
  }) => {
    // Dismissed matters as much as accepted: the event is spent either way, so
    // a button left behind after a dismissal is a button that silently does
    // nothing. Chrome will fire a fresh one later if it still wants to.
    await feed(page, api);
    await fire(page, outcome);
    await page.locator(BUTTON).click();
    await expect(page.locator(BUTTON)).toHaveCount(0);
    await expect(page.locator(BLOCK)).toBeHidden();
  });
}

test("the palette offers it, and running the row prompts", async ({ page, api }) => {
  await feed(page, api);
  await fire(page);

  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette")).toBeVisible();
  const row = page.getByRole("option", { name: "Install Commons" });
  await expect(row).toHaveCount(1);
  await row.click();

  await expect.poll(() => page.evaluate(() => window.__promptCalls)).toBe(1);
});

test("the colophon offers it too", async ({ page }) => {
  await page.goto("/#/colophon");
  await expect(page.locator(".colophon__title")).toBeVisible();
  await expect(page.locator(".colophon__install")).toBeHidden();

  await fire(page);
  await expect(page.locator(".colophon__install")).toBeVisible();
  await expect(page.locator(".colophon__install button")).toHaveText("Install Commons");
});

// ── state 3: already an app ────────────────────────────────────────────────
test("nothing is offered once the app has been installed", async ({ page, api }) => {
  await feed(page, api);
  await fire(page);
  await expect(page.locator(BUTTON)).toBeVisible();

  // The real event, not a stub: this is exactly what Chrome dispatches, and it
  // is one of the two ways the app knows it is installed.
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));

  await expect(page.locator(BUTTON)).toHaveCount(0);
  await expect(page.locator(BLOCK)).toBeHidden();

  // And a later event cannot bring it back. An installed app being offered an
  // install is the one wrong answer here.
  await fire(page);
  await expect(page.locator(BLOCK)).toBeHidden();
});

test("nothing is offered in a standalone window", async ({ page, api }) => {
  // display-mode cannot be emulated: Playwright's emulateMedia has no such
  // feature and CDP's Emulation.setEmulatedMedia ignores it, both checked. So
  // the media query itself is stubbed — in the test, from outside, with no
  // hook of any kind in js/install.js, which still knows only about
  // matchMedia.
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) =>
      /display-mode:\s*standalone/.test(q)
        ? {
            ...real(q),
            matches: true,
            media: q,
            addEventListener() {},
            removeEventListener() {},
          }
        : real(q);
  });
  await feed(page, api);

  await expect(page.locator(BLOCK)).toBeHidden();
  // Not even when Chrome offers, which it will do for a window it does not
  // realise is already an app.
  await fire(page);
  await expect(page.locator(BLOCK)).toBeHidden();
  await expect(page.locator(BUTTON)).toHaveCount(0);
});

// ── state 2: iOS, where there is no event and never will be ────────────────
test.describe("on an iPhone", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("gets a sentence rather than a dead button", async ({ page, api }) => {
    await feed(page, api);

    await expect(page.locator(BLOCK)).toBeVisible();
    await expect(page.locator(BUTTON)).toHaveCount(0);

    const how = page.locator(HOW);
    await expect(how).toBeVisible();
    await expect(how.locator("summary")).toHaveText("Add it to your home screen");

    // Shut until asked. Four lines of instructions for one platform is not
    // what the masthead is for.
    await expect(how).not.toHaveAttribute("open", "");
    await expect(how.locator(".install-how__body")).toBeHidden();

    await how.locator("summary").click();
    await expect(how.locator(".install-how__body")).toContainText(
      "press Share, then Add to Home Screen"
    );
  });

  test("it opens from the keyboard, and the target is big enough for a thumb", async ({
    page,
    api,
  }) => {
    await feed(page, api);
    const summary = page.locator(`${HOW} summary`);

    const box = await summary.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);

    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".install-how__body")).toBeVisible();
  });

  test("the palette says the same thing, in one line", async ({ page, api }) => {
    await feed(page, api);
    await page.keyboard.press("Control+k");
    const row = page.getByRole("option", { name: "Add Commons to your home screen" });
    await expect(row).toHaveCount(1);
    await row.click();

    // A toast, because that is how this app answers a question in one line —
    // and because there is no prompt on iOS to open instead.
    await expect(page.locator(".toast")).toContainText("Add to Home Screen");
  });

  test("an installed iOS app is offered nothing", async ({ page, api }) => {
    // navigator.standalone predates display-mode by years and is still the only
    // thing an installed iOS web app answers to.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", {
        value: true,
        configurable: true,
      });
    });
    await feed(page, api);
    await expect(page.locator(BLOCK)).toBeHidden();
    await expect(page.locator(HOW)).toHaveCount(0);
  });
});

// ── the quality floor ──────────────────────────────────────────────────────
test("axe is clean on a masthead carrying the offer, both themes", async ({
  page,
  api,
}) => {
  await feed(page, api);
  await fire(page);
  await expect(page.locator(BUTTON)).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await settled(page);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations, `${theme} theme`).toEqual([]);
  }
});

test.describe("at 320px", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    viewport: { width: 320, height: 720 },
    hasTouch: true,
    isMobile: true,
  });

  test("the disclosure opens without pushing the page sideways", async ({
    page,
    api,
  }) => {
    // The narrowest screen anybody still uses, carrying the longest of the two
    // states: a summary and four lines of instructions.
    await feed(page, api);
    await page.locator(`${HOW} summary`).click();
    await expect(page.locator(".install-how__body")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("axe is clean with the sentence open", async ({ page, api }) => {
    await feed(page, api);
    await page.locator(`${HOW} summary`).click();
    await settled(page);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations).toEqual([]);
  });
});
