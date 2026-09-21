# 0013 — An export is one request, and arrives whole

**Status:** accepted · 2026-09-21

## What was decided

*Download your data* on `#/settings` is **one authenticated request** to
`GET /api/v1/users/me/export`, which returns everything in one document:

```
{ exported_at, account, email, posts[], comments[] }
```

It is **not paged**, it **includes unpublished posts**, and each comment
carries the title of the post it was left on. The obvious alternative — the
client assembling the file out of the public endpoints it already has — was
tried on paper and rejected.

## Why

**The public endpoints cannot answer the question.** Two gaps, and each alone
would be enough:

`GET /users/{username}/posts` hides unpublished posts from everybody but their
author, which is exactly right for a public list. An export built on it would
silently omit the draft you have not finished — the single most likely thing
somebody would notice missing, and the hardest to notice at the time.

And there is no "comments by one person" endpoint at all. Comments are reached
through the post they are on, so from the outside there is no way to find what
you said under somebody else's post. Adding
`GET /users/{username}/comments` would have been the consistent thing to
build, and it inherits the same visibility problem: it would have to hide
comments on unpublished posts, and the export would lose those too.

**Asking as yourself makes the visibility question disappear.** It is all
yours, so you may all have it. That is one branch fewer in the handler and one
fewer thing to get wrong.

**An export arrives whole or it is not an export.** Paging it means a client
that stops halfway — a dropped connection, a closed tab, a bug in a loop —
hands somebody a file that looks complete and is not. There is no `page`
parameter here for the same reason there is no `fields` one: the answer to
"give me my data" is all of it. `test_export_is_not_paged` seeds
twenty-five posts against a default page size of ten, so anything that quietly
grew a boundary fails rather than returning a plausible first page.

**It is its own shape, not the feed's.** `schemas.ExportedPost` has no
`votes`, `voted`, `saved` or `excerpt`. Every one of those is computed for a
viewer at a moment — how many people agreed, whether *you* did, which words
matched a search you just ran — and in a file they would be a number that was
true once. `voted: false` against your own post would be actively confusing.

**Each comment carries `post_title`.** Denormalised on purpose: a comment
exported as content plus a post id is a line of text and a number nobody can
resolve once the file has left the app, and being readable on its own is the
only reason anybody downloads one.

## What it costs

**An unbounded response.** On a feed this size that is a few hundred kilobytes
at the very worst. If it ever stops being true, the fix is a job that builds
the file and a link that fetches it — not a `page` parameter. The shape of the
promise does not change.

**A third implementation.** The FastAPI handler, `tests/mock_api.py` and
`js/demo/backend.js` all answer this route, because the published demo has no
server and the e2e suite runs against both. That is the standing cost of
[ADR 0004](0004-demo-mode-for-a-static-host.md) and it is paid per endpoint;
this one is small enough that all three are a few dozen lines.

**An endpoint that exists for one screen.** `/users/me/export` has exactly one
caller and no obvious second one. That is a real smell and it is accepted here
because the alternative was a general endpoint that could not answer the
question honestly — a `/users/{username}/comments` nobody asked for, plus a
paging loop in the client, plus two silent omissions.

## When to change our minds

- **If a profile ever shows somebody's comment history**, build
  `GET /users/{username}/comments` for that, public and paged, and leave this
  alone. They are different questions: one is "what has this person said in
  public", the other is "give me everything of mine". The second is not the
  first plus a filter.
- **If exports ever get large enough to time out**, the answer is a background
  job and a download link, and this endpoint becomes the thing that enqueues
  it. Still one request from the reader's point of view, still whole.
- **If the app ever grows data that is yours and is not writing** — a
  follow list, saved searches — it belongs in this document, and the test that
  should fail first is the one asserting the top-level keys.
