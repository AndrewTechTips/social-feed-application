// Phone-specific regressions, sibling to responsive.spec.js.
//
// responsive.spec.js asks "does the layout hold at this width". This file asks
// the questions you only hit on an actual handset: the tap highlight, the iOS
// zoom-on-focus threshold, whether a tap still gives feedback once the highlight
// is gone, and whether the signed-in header and the compose form survive 320px.
//
// These run in touch-emulating contexts (isMobile + hasTouch), which is what
// puts the browser into `pointer: coarse` / `hover: none` — the two media
// queries the mobile CSS actually keys off.

const fs = require("fs");
const path = require("path");
const {
  test,
  expect,
  CARD,
  accountButton,
  openAccountMenu,
} = require("./support/fixtures");

const PHONE_WIDTHS = [320, 360, 375, 390, 414];
const STYLE_DIR = path.join(__dirname, "..", "styles");

const phone = (width, height = 780) => ({
  viewport: { width, height },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});

// Start a test on a signed-in screen without walking the sign-in flow first.
// The token has to come from whichever backend this project is running against,
// so the fixture mints it — see api.signIn in tests/support/fixtures.js. The
// credentials are the ones api.seed() creates its author with.
const signIn = (api, page, email = "ada@commons.test", password = "seedpassword") =>
  api.signIn(page, email, password);

const overflowOf = (page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );

const transparent = (color) =>
  /^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(String(color).trim());

// ── the blue tap flash ─────────────────────────────────────────────────────
test.describe("tap highlight", () => {
  test.use(phone(390));

  test("nothing tappable flashes the browser's default blue box", async ({
    page,
    api,
  }) => {
    await api.seed(3, "ada@commons.test");
    await page.goto("/");
    await expect(page.locator(CARD).first()).toBeVisible();

    // -webkit-tap-highlight-color inherits, so html is the only place that has
    // to set it — but assert on the things a finger actually lands on.
    const colors = await page.evaluate(() => {
      const read = (el) =>
        el ? getComputedStyle(el).webkitTapHighlightColor : "MISSING";
      return {
        html: read(document.documentElement),
        body: read(document.body),
        card: read(document.querySelector(".card__link")),
        vote: read(document.querySelector(".vote")),
        button: read(document.querySelector(".account .btn")),
        brand: read(document.querySelector(".brand")),
      };
    });

    for (const [where, color] of Object.entries(colors)) {
      expect(transparent(color), `${where} had a tap highlight of ${color}`).toBe(true);
    }
  });
});

// ── the feedback that replaces it ──────────────────────────────────────────
test.describe("press feedback on touch", () => {
  test.use(phone(390));

  // Two different questions, and they need two different instruments.
  //
  // The one that is *ours*: does the app draw a press state at all, and is it
  // actually different from resting? That is CSS we wrote and can break, and
  // pressedStyle() answers it everywhere by forcing :active through CDP.
  //
  // The one that is the *browser's*: does a real held finger put Blink into
  // :active in the first place? heldTap() answers it where the platform's
  // gesture recognizer runs — which is not everywhere. See the note there.

  /**
   * Force :active on `selector` and read the settled style of `sampleSelector`.
   *
   * The wait matters. Both of these elements transition background-color over
   * --t-mid, and getComputedStyle *during* a transition returns the
   * interpolated value — at t=0 that is the colour being left, not the one
   * being arrived at. Reading immediately made a perfectly good press state
   * look identical to resting, which is a false green rather than a false red
   * and therefore the worse of the two.
   */
  async function pressedStyle(page, selector, sampleSelector = selector) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    expect(nodeId, `${selector} should be on the page`).toBeTruthy();

    const settled = () =>
      page
        .locator(sampleSelector)
        .first()
        .evaluate(async (el) => {
          await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})));
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, ink: s.color, border: s.borderColor };
        });

    const force = (on) =>
      cdp.send("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: on ? ["active"] : [],
      });

    const resting = await settled();
    await force(true);
    const pressed = await settled();
    await force(false);
    const released = await settled();
    return { resting, pressed, released };
  }

  /**
   * Hold a real tap on `selector` and report whether Blink lit :active.
   *
   * `gestureRan` is the part worth explaining. A finger produces a tap
   * *gesture*, and the gesture — not the raw touch events — is what puts Blink
   * into :active. On Linux, `Input.synthesizeTapGesture` delivers the touch and
   * pointer events faithfully and then never runs the recognizer: no
   * GestureShowPress, so no :active, and no compatibility mousedown/mouseup or
   * click either. macOS runs it and produces all of them.
   *
   * So the absence of a `click` is a reliable, behavioural signal that the
   * platform never produced a gesture at all — which means there is nothing
   * about *this app* to learn from the attempt. Detected rather than hardcoded
   * to an OS, so this starts asserting again by itself if Chromium changes.
   *
   * The sampler is stopped by the test rather than by a timer inside the page.
   * The old version gave itself a 1200ms budget starting before the tap was
   * even sent, so a slow machine could spend the budget on round trips and the
   * gesture and then sample nothing.
   */
  async function heldTap(page, selector) {
    const cdp = await page.context().newCDPSession(page);
    const box = await page.locator(selector).first().boundingBox();
    expect(box, `${selector} should be on screen`).toBeTruthy();

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      window.__tap = { sawActive: false, clicked: false };
      el.addEventListener("click", (e) => {
        e.preventDefault();
        window.__tap.clicked = true;
      });
      window.__tapSampler = setInterval(() => {
        if (el.matches(":active")) window.__tap.sawActive = true;
      }, 8);
    }, selector);

    await cdp.send("Input.synthesizeTapGesture", {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      duration: 350,
      tapCount: 1,
    });

    // The gesture's compatibility events land a frame or two after the touch
    // ends, so give them one before deciding nothing arrived.
    await page.waitForTimeout(150);
    return page.evaluate(() => {
      clearInterval(window.__tapSampler);
      return window.__tap;
    });
  }

  async function onTheFeed(page, api) {
    await api.seed(3, "ada@commons.test");
    await page.goto("/");
    await expect(page.locator(CARD).first()).toBeVisible();
  }

  test("the vote control visibly presses under a finger", async ({
    page,
    api,
  }, info) => {
    await onTheFeed(page, api);

    const { resting, pressed, released } = await pressedStyle(page, ".vote");
    expect(pressed.bg, "the press tint is the same as no tint at all").not.toBe(
      resting.bg
    );
    expect(pressed.ink, "the caret and count should darken too").not.toBe(resting.ink);
    // And it lets go again — a press state that sticks is worse than none.
    expect(released, "the press state outlived the press").toEqual(resting);

    const { sawActive, clicked } = await heldTap(page, ".vote");
    if (clicked) {
      expect(sawActive, ":active never applied while the finger was down").toBe(true);
    } else {
      info.annotations.push({
        type: "note",
        description:
          "this platform's gesture recognizer produced no tap gesture, so :active " +
          "under a real finger is not observable here — the press state itself is " +
          "asserted above",
      });
    }
  });

  test("a post card visibly presses under a finger", async ({ page, api }, info) => {
    await onTheFeed(page, api);

    // The card tints, the link inside it is what takes :active — hence the
    // separate sample target, and hence `.card:has(.card__link:active)`.
    const { resting, pressed, released } = await pressedStyle(
      page,
      ".card__link",
      CARD
    );
    expect(pressed.bg, "the card gave no sign it had been tapped").not.toBe(resting.bg);
    expect(pressed.border, "the card's edge should firm up under a finger").not.toBe(
      resting.border
    );
    expect(released, "the press state outlived the press").toEqual(resting);

    const { sawActive, clicked } = await heldTap(page, ".card__link");
    if (clicked) {
      expect(sawActive, ":active never applied while the finger was down").toBe(true);
    } else {
      info.annotations.push({
        type: "note",
        description:
          "no tap gesture on this platform; the press state itself is asserted above",
      });
    }
  });

  test("hover-only states stay behind (hover: hover)", async ({ page, api }) => {
    await api.seed(3, "ada@commons.test");
    await page.goto("/");
    await expect(page.locator(CARD).first()).toBeVisible();

    // A touch context must report no hover, otherwise the gated rules would
    // apply on a phone and stick after every tap.
    const mq = await page.evaluate(() => ({
      hoverNone: matchMedia("(hover: none)").matches,
      pointerCoarse: matchMedia("(pointer: coarse)").matches,
    }));
    expect(mq).toEqual({ hoverNone: true, pointerCoarse: true });

    // let the card entrance animation finish, or its translateY reads as a lift
    await page
      .locator(CARD)
      .first()
      .evaluate((el) =>
        Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})))
      );

    // the card's lift + blur is hover-only, so it must not be in effect here
    const card = await page
      .locator(CARD)
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          transform: s.transform,
          blur: s.backdropFilter || s.webkitBackdropFilter,
        };
      });
    expect(
      card.transform === "none" || card.transform === "matrix(1, 0, 0, 1, 0, 0)"
    ).toBe(true);
    expect(card.blur).toBe("none");
  });
});

// ── iOS zoom-on-focus ──────────────────────────────────────────────────────
test.describe("form controls never trip iOS zoom-on-focus", () => {
  // Anything under 16px makes mobile Safari zoom the page in on focus and never
  // zoom back out. 16px is the exact threshold, so assert on it directly.
  for (const width of PHONE_WIDTHS) {
    test(`every field is at least 16px at ${width}px`, async ({ browser, api }) => {
      await api.seed(3, "ada@commons.test");
      const context = await browser.newContext(phone(width));
      const page = await context.newPage();

      const sizes = async (label) => {
        const found = await page.evaluate(() =>
          [...document.querySelectorAll(".input, .textarea, .search__input")].map(
            (el) => ({
              id: el.id || el.className,
              fontSize: parseFloat(getComputedStyle(el).fontSize),
            })
          )
        );
        expect(found.length, `no fields found on ${label}`).toBeGreaterThan(0);
        for (const f of found) {
          expect(
            f.fontSize,
            `${label}: ${f.id} renders at ${f.fontSize}px`
          ).toBeGreaterThanOrEqual(16);
        }
      };

      await page.goto("/");
      await expect(page.locator(CARD).first()).toBeVisible();
      await sizes("the feed search");

      await page.goto("/#/login");
      await expect(page.getByLabel("Email")).toBeVisible();
      await sizes("sign in");

      await signIn(api, page);
      await page.goto("/#/compose");
      await expect(page.getByLabel("Body")).toBeVisible();
      await sizes("compose");

      await context.close();
    });
  }

  test("a phone held in landscape is still 16px, wide as it is", async ({
    browser,
    api,
  }) => {
    await api.seed(3, "ada@commons.test");
    // 844px wide — past every mobile width breakpoint, but still a phone. This
    // is the case a width-only media query silently misses.
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto("/#/login");
    await expect(page.getByLabel("Email")).toBeVisible();

    const fontSize = await page
      .getByLabel("Email")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);

    await context.close();
  });

  test("the desktop keeps its tighter control type", async ({ page, api }) => {
    await api.seed(3, "ada@commons.test");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#/login");
    await expect(page.getByLabel("Email")).toBeVisible();

    const fontSize = await page
      .getByLabel("Email")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeLessThan(16);
  });
});

// ── the signed-in header ───────────────────────────────────────────────────
test.describe("the header fits while signed in", () => {
  for (const width of PHONE_WIDTHS) {
    test(`no horizontal overflow at ${width}px when signed in`, async ({
      browser,
      api,
    }) => {
      const seeded = await api.seed(4, "ada@commons.test");
      const { created } = await seeded.json();
      const context = await browser.newContext(phone(width));
      const page = await context.newPage();
      await signIn(api, page);

      for (const route of ["/", `/#/posts/${created[0]}`, "/#/compose"]) {
        await page.goto(route);
        await page.waitForTimeout(300);
        expect(
          await overflowOf(page),
          `${route} overflowed at ${width}px`
        ).toBeLessThanOrEqual(1);
      }

      await context.close();
    });
  }

  test("every header action, the theme toggle included, stays on screen at 320px", async ({
    browser,
    api,
  }) => {
    await api.seed(3, "ada@commons.test");
    const context = await browser.newContext(phone(320));
    const page = await context.newPage();
    await signIn(api, page);
    await page.goto("/");
    await expect(page.locator(CARD).first()).toBeVisible();

    // The regression this was written for: at 320px the labelled Write / Sign
    // out buttons pushed the theme toggle clean off the right edge, where it
    // could not be tapped. Sign out is behind the account button now and the
    // row is three controls wide instead of six, so the pressure is off — but
    // the assertion is about the edge, not about the count, and it stays.
    const controls = [
      [
        "the theme toggle",
        page.getByRole("button", { name: /switch to (light|dark) theme/i }),
      ],
      ["Write a post", page.getByRole("link", { name: "Write a post" })],
      ["the account button", accountButton(page)],
    ];
    for (const [name, control] of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x, `${name} starts off the left edge`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} runs past the right edge`).toBeLessThanOrEqual(
        320
      );
      expect(box.height, `${name} is too small to tap`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${name} is too narrow to tap`).toBeGreaterThanOrEqual(44);
    }

    // The panel is positioned from JavaScript, so the narrowest screen is
    // where that arithmetic has to be checked rather than assumed.
    await openAccountMenu(page);
    const panel = await page.getByRole("menu").boundingBox();
    expect(panel.x, "the menu starts off the left edge").toBeGreaterThanOrEqual(0);
    expect(
      panel.x + panel.width,
      "the menu runs past the right edge"
    ).toBeLessThanOrEqual(320);

    await context.close();
  });
});

// ── compose at the narrowest width we support ──────────────────────────────
test.describe("the compose form works at 320px", () => {
  test("you can fill it in, see every control, and post", async ({ browser, api }) => {
    await api.seed(1, "ada@commons.test");
    const context = await browser.newContext(phone(320));
    const page = await context.newPage();
    await signIn(api, page);
    await page.goto("/#/compose");

    const title = page.getByLabel("Title", { exact: true });
    const body = page.getByLabel("Body");
    const post = page.getByRole("button", { name: "Post" });
    await expect(title).toBeVisible();

    // nothing is clipped horizontally, and the body box is worth writing in
    for (const [label, locator] of [
      ["title", title],
      ["body", body],
      ["Post", post],
    ]) {
      const box = await locator.boundingBox();
      expect(box.x, `${label} starts off-screen`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${label} runs off-screen`).toBeLessThanOrEqual(320);
    }
    expect(
      (await body.boundingBox()).height,
      "the body box is too short to compose in"
    ).toBeGreaterThanOrEqual(144);
    expect(
      (await post.boundingBox()).height,
      "Post is too small to tap"
    ).toBeGreaterThanOrEqual(44);

    // the panel reads as a page on a phone, not a blurred floating dialog
    const panel = await page.locator(".compose__panel").evaluate((el) => {
      const s = getComputedStyle(el);
      return { blur: s.backdropFilter || s.webkitBackdropFilter };
    });
    expect(panel.blur, "the compose panel still carries a backdrop blur").toBe("none");

    await title.fill("Written on a small phone");
    await body.fill("Three hundred and twenty pixels wide.");
    expect(
      await overflowOf(page),
      "typing pushed the layout sideways"
    ).toBeLessThanOrEqual(1);

    await post.click();
    await expect(
      page.getByRole("heading", { name: "Written on a small phone" })
    ).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);

    await context.close();
  });

  test("the delete confirmation fits at 320px", async ({ browser, api }) => {
    const seeded = await api.seed(1, "ada@commons.test");
    const { created } = await seeded.json();
    const context = await browser.newContext(phone(320));
    const page = await context.newPage();
    await signIn(api, page);
    await page.goto(`/#/posts/${created[0]}`);

    await page.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();

    expect(await overflowOf(page)).toBeLessThanOrEqual(1);
    for (const name of ["Keep it", "Delete"]) {
      const box = await confirm.getByRole("button", { name }).boundingBox();
      expect(box.x + box.width, `${name} runs off the right edge`).toBeLessThanOrEqual(
        320
      );
      expect(box.height, `${name} is too small to tap`).toBeGreaterThanOrEqual(44);
    }

    await context.close();
  });
});

// ── source-level guards ────────────────────────────────────────────────────
test.describe("the stylesheets keep their mobile guarantees", () => {
  const css = () =>
    fs
      .readdirSync(STYLE_DIR)
      .filter((f) => f.endsWith(".css"))
      .map((f) => ({
        file: f,
        text: fs.readFileSync(path.join(STYLE_DIR, f), "utf8"),
      }));

  test("no bare 100vh — mobile browser chrome makes it lie", async () => {
    // vh is frozen at the largest viewport, so a 100vh box is taller than the
    // screen whenever the URL bar is showing, and the page jumps as it hides.
    for (const { file, text } of css()) {
      const offenders = text.match(/\b\d+vh\b/g) || [];
      expect(offenders, `${file} uses vh where it means the visible viewport`).toEqual(
        []
      );
    }
  });

  test("the tap highlight is turned off in the stylesheet, not just by accident", async () => {
    const base = css().find((c) => c.file === "base.css");
    expect(base.text).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
  });

  test("the sticky header respects the notch", async () => {
    const all = css()
      .map((c) => c.text)
      .join("\n");
    expect(
      all,
      "viewport-fit=cover paints under the status bar; the header must inset for it"
    ).toMatch(/safe-area-inset-top/);
  });
});
