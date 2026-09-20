# 0001 — Vanilla JS with JSDoc types, not TypeScript

**Status:** accepted · 2026-09-14 · amended 2026-09-20 (see *The trigger fired*)

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

## The trigger fired, and we are not acting on it (2026-09-20)

The line count is **8,165**, against a trigger written at 3,000. Nearly three
times over. This section exists because an ADR with a trigger that quietly
fired and was ignored is worse than an ADR with no trigger at all: the next
person to read it can run the command above, and what they find should be a
decision rather than a silence.

**The decision: stay on JSDoc. No TypeScript, no build step.**

The reasoning, and it is not "we didn't get round to it":

- **3,000 was a guess at a cost, not a measurement of one.** What it was really
  asking was *when does passing untyped objects around start to hurt*. Six
  features have landed since — comments, replies, notifications, the shelf, the
  colophon, a service worker — and `tsc --noEmit` has been green through all of
  them, in CI, on every push. The number went up; the pain the number was
  standing in for did not arrive.
- **The second trigger is the one that measures the real thing, and it has not
  fired.** "The JSDoc casts start outnumbering the code they're annotating in
  any one file" is a direct reading of whether the annotations have become the
  work. The densest file in the tree is `store.js` at eighteen JSDoc tags
  across 300 lines. That is documentation, not ceremony.
- **A third of the count is not the kind of code the trigger meant.**
  `js/demo/backend.js` was already excluded, but `sw.js`, the type definitions
  themselves and several hundred lines of explanatory comment are all in the
  8,165. The app did not get harder to hold in your head; it got more
  thoroughly written down.
- **What a migration would actually cost is still the thing this ADR was
  written about.** A bundler puts a `dist/` between the source somebody reads
  and the thing that runs, and "open `index.html` and it runs" stops being
  true. That was the argument in 2026-09-14 and nothing since has weakened it.

**What changes.** The 3,000-line trigger is **retired**, because a threshold
that has been crossed and consciously declined is no longer a threshold — it is
a number someone will have to explain again in six months. The other two stand,
and they are the ones that were measuring the right thing all along:

- **A second person** starts contributing regularly.
- The JSDoc casts start outnumbering the code they're annotating in any one
  file.

To those, one replacement for the line count that is about difficulty rather
than about size:

- **`tsc --noEmit` stops being able to describe something the app actually
  does**, and the workaround is a cast that asserts what the code is pointedly
  not assuming. One of those is a bad afternoon; a habit of them means the
  types have stopped helping and a real type system is owed.

If any of those fire, this file is superseded rather than edited — same as
before.
