# 0005 — Offset pagination, and when to switch to keyset

**Status:** accepted · 2026-09-14 · amended 2026-09-19 (see *The third trigger*)

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

---

## The third trigger (2026-09-19)

The two triggers above are about *volume*: fifty thousand posts, or several
writes a minute. Both were right, and neither has happened. A third case turned
up that they don't cover, and it doesn't wait for volume at all.

**A feed that receives rows while it is being read.** The two triggers assume
the reader and the writers are strangers racing each other, which makes
skip-and-repeat a probability — at a handful of posts a day, near zero. But a
"3 new posts" control, which is the next thing this app wants, *hands the
reader rows at the top of the list they are paginating*. Every one of them
shifts every later page down by one, so the duplicate is not a probability, it
is arithmetic: one repeated card per row inserted, at any write rate, including
one post a week.

### What was done instead of keyset

`GET /posts/` takes an optional `as_of` timestamp and adds one clause:

```sql
WHERE created_at <= :as_of
```

The feed asks for page one unanchored — page one *is* the window — and sends
back the `created_at` of the newest post it got on every page after it. So the
later pages are served out of the feed as it stood when the reader arrived,
which is what an infinite scroll already means.

The anchor is the newest post's own timestamp rather than the browser's clock,
so there is no skew to get wrong and every post already on screen is inside the
window by construction. It is not sent while searching: those results are
ordered by relevance, so the first one is not the newest and an anchor taken
from it would mean nothing. It is not offered on a profile either — nothing
inserts into a profile while it is being read, and a parameter that exists to
solve a problem a route doesn't have is a parameter that will be wrong later.

### Why not keyset, now that there is a reason

Because this isn't that reason. Keyset is the answer to *depth* — `OFFSET
10000` walking ten thousand index entries — and to a feed changing under a
reader fast enough that a fixed window would itself be stale. Neither has
happened. What has changed is that one specific control inserts rows, and a
window closes that exactly.

Keeping offsets also keeps `total`, which is what draws "3 posts" on a profile
and what tells the infinite scroll it has finished, and a cursor has no
equivalent. Spending the migration now would be paying keyset's price to solve
a problem a `WHERE` clause solves.

**The original triggers stand.** Fifty thousand posts, or a deep page showing
up as slow, and this becomes keyset — at which point `as_of` goes away with the
offsets, because a cursor is already a stable window.

