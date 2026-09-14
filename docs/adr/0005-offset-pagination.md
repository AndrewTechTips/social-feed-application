# 0005 — Offset pagination, and when to switch to keyset

**Status:** accepted · 2026-09-14

## What was decided

`LIMIT … OFFSET …`, with an envelope that carries `total`, `pages`,
`has_next` and `has_prev`. The feed, a profile and a comment thread all use the
same shape.

## Why

It is the pagination that matches the UI. The envelope's `total` is what draws
"3 posts" on a profile and what tells the infinite scroll it has reached the
end; a cursor has no equivalent, so the UI would have to lose the count or the
API would have to compute it separately anyway.

It also matches the data. The feed is ordered by `created_at DESC` with the
composite index `(published, created_at)` behind it, so the planner walks the
index backwards and the offset is a cheap skip over already-located rows, not a
scan.

## What it cost

Offset pagination has two well-known problems and this API has both:

**It degrades with depth.** `OFFSET 10000` makes the database walk and discard
ten thousand index entries before returning anything. At the sizes this app
will ever see — a demo with fourteen posts — that is free. At a hundred
thousand rows and a reader who keeps scrolling, it is not.

**It skips and repeats rows under writes.** If someone posts while you are
reading page 1, the row that was last on page 1 shifts to page 2 and you see it
twice; if a post is deleted, a row slides up and you never see it. The infinite
scroll makes this visible as a duplicated card, not as a broken page.

Neither is worth fixing now, and saying "we'll fix it if it matters" without
saying what "matters" means is how known problems become forgotten ones.

## When to change our minds

Switch to keyset (cursor) pagination when either is true:

- the feed passes roughly **50,000 posts**, or a deep-page query shows up as
  slow in the request log; or
- writes become frequent enough that the skip-and-repeat behaviour is visible
  to readers — in practice, several posts a minute.

The change is: order by `(created_at, id)`, take `?after=<created_at>,<id>`
instead of `?page=`, and return `next_cursor` instead of `page`/`pages`. The
`total` goes, or becomes a separate cheap estimate from `pg_class.reltuples`.
`page_of_posts()` in `routers/post.py` is the one function that has to change,
which is why the feed and profiles were made to share it.
