# 0001 — Vanilla JS with JSDoc types, not TypeScript

**Status:** accepted · 2026-09-14

## What was decided

Keep the frontend as hand-written ES modules with no build step, and get type
checking anyway: `// @ts-check` at the top of every file, the API shapes
described once in [`js/types.js`](../../frontend/js/types.js) as JSDoc
`@typedef`s, `checkJs` and `noEmit` in `tsconfig.json`, and `tsc --noEmit` in
CI.

## Why

The honest case *for* TypeScript was real. The API response shape is consumed
in six files and was typed nowhere; the store's state shape lived in a comment;
and the two features that came next — comments and profiles — both widened that
shape, which is exactly when passing untyped objects around starts costing you.

The case against is that "no framework, no bundler, no build step — open
`index.html` and it runs" is the only unusual thing about this frontend. There
are a great many React feeds. Adding a bundler deletes that claim, puts a
`dist/` between the source and the deploy, and makes the thing a reviewer reads
no longer the thing the browser runs.

`checkJs` gets almost all of the first without giving up any of the second. The
editor autocompletes, CI fails on a type error, and the files that ship are the
files in `js/`.

## What it cost

It is not free, and pretending otherwise would be the rationalisation this
document exists to avoid:

- JSDoc casts are wordier than TypeScript's. `/** @type {HTMLInputElement} */
  (document.getElementById("search-input"))` is a lot of characters for
  something TS writes as `as HTMLInputElement`.
- `useUnknownInCatchVariables` is off. Every handler in this app branches on
  `err.name === "AbortError"` or `err.status`, and narrowing `unknown` at each
  of them would mean asserting a type the code is deliberately not assuming.
- Generics in JSDoc are awkward enough that `Page<T>` is the only one here.

Turning it on was worth it for what it found straight away: an optimistic
comment append that read `session.id` without checking the session still
existed, and a profile empty-state that called `get("session")` twice and would
have thrown between the two.

## When to change our minds

Written down so it's a plan and not a excuse:

- The frontend passes roughly **3,000 lines** of application code (`js/`,
  excluding `demo/`). The §6 audit measured ~1,400; adding comments, profiles,
  search and the typedefs took it to **2,743**, so this trigger is closer than
  it sounds and worth re-measuring after the next feature rather than after the
  next year. Count it with:

  ```bash
  find frontend/js -name '*.js' -not -path '*/demo/*' | xargs wc -l | tail -1
  ```
- **A second person** starts contributing regularly.
- The JSDoc casts start outnumbering the code they're annotating in any one
  file.

Any of those, and the right move is real TypeScript with a build step — at
which point this file should be superseded rather than edited.
