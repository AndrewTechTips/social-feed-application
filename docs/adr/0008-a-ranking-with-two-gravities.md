# 0008 — A ranking with two gravities

**Status:** accepted · 2026-09-19

## What was decided

`GET /posts/?sort=` takes `new`, `warm` or `discussed`. The first is newest
first and needs no defending. The other two are rankings:

```
score = count / (hours_old + 2) ** gravity
```

with **two** constants, because the two things being counted do not age at the
same rate:

| sort | counts | gravity | half-life |
| --- | --- | --- | --- |
| `warm` | votes | **0.5** | ~6 hours |
| `discussed` | comments | **0.25** | ~30 hours |

Both tie-break on `created_at DESC`. Both are ignored while searching, where
relevance leads. Neither is offered on a profile.

## Why a ranking at all

Until now the only ordering in the app was chronological, and the only live
quantity — the vote — moved a number and, at three, drew a hairline. It did not
move the post. That made the whole voting mechanic ornamental, which is a
strange thing for the app's one signal to be.

## Why not 1.8, or 1.5

Hacker News uses `(points - 1) / (age + 2) ^ 1.8`, and 1.5 was the number this
project's own upgrade plan suggested. Both are wrong here, and it is measurable
rather than a matter of taste.

Scored against the seeded feed — fourteen posts spanning eighteen days, which
is the shape this app actually has — `warm` at gravity 1.5 returns:

```
13, 11, 10, 9, 8, 7, 5, 4, 3, 2, 1, 14, 12, 6
```

That is *exactly* chronological among the posts that have votes, with the
unvoted ones swept to the end. At 1.8 it is identical. A sort that reproduces
another sort is not a sort; it is a filter wearing a sort's name.

The reason is volume. Those constants were chosen for a front page receiving
thousands of submissions a day, where a half-life of an hour or two is what
stops the top of the page from freezing. This feed receives a few posts a day.
At gravity 1.5 a post loses half its standing in seventy minutes, so age swamps
the count and nothing a reader did yesterday can still matter today.

## How 0.5 was chosen

Half-lives, for a post with the same count at different gravities:

| gravity | half-life | down to a quarter |
| --- | --- | --- |
| 0.3 | 18 h | 201 h |
| 0.4 | 9 h | 62 h |
| **0.5** | **6 h** | **30 h** |
| 0.6 | 4 h | 18 h |
| 1.0 | 2 h | 6 h |
| 1.5 | 1 h | 3 h |

Six hours is the pace that matches the feed: something posted this morning is
still in contention this evening, and something from last week is not.

It also sits exactly on the judgement that matters. Two real rows from the
seed — three votes from a day ago, and one vote from an hour ago:

| gravity | 3 votes @ 24 h | 1 vote @ 1 h | which wins |
| --- | --- | --- | --- |
| 0.4 | 0.815 | 0.644 | the three |
| **0.5** | **0.588** | **0.577** | **the three, just** |
| 0.6 | 0.425 | 0.517 | the one |

Three people agreeing yesterday is more signal than one person agreeing an hour
ago, so the three should win — and 0.5 is the last gravity at which they do. A
constant chosen at the boundary of the behaviour you want is a reason; one
chosen in the middle of a range is a preference.

And the decay still does its job: the best-liked post on the seeded feed — four
votes, two weeks old — does not reach the top at 0.5.

Incidentally 0.5 is a square root, so the whole thing reads as *votes over the
square root of its age in hours, plus two*, which is a sentence somebody can
hold in their head.

## Why comments get their own, gentler constant

At the vote's gravity, `discussed` on the seeded feed puts two posts with one
comment each above a five-comment thread, because those comments are minutes
old and the thread is a fortnight old. Nobody means that by "discussed".

| gravity | top of `discussed` |
| --- | --- |
| 0.5 | 1 comment, 6 minutes old |
| 0.3 | the 5-comment thread |
| **0.25** | **the 5-comment thread**, then the two fresh ones |
| 0.2 | the same, with the fresh ones further back |

0.25 — half the exponent, five times the half-life — is where the five-comment
thread leads while a new conversation can still climb past a stale two-comment
one.

The distinction it encodes is real: **a vote is a reaction and it stales; a
conversation is a thing you can still join.** One number would have been
tidier and would have made one of the two sorts wrong.

## What it costs

**A second outer join, on one branch.** `discussed` joins comments as well as
votes, and two outer joins multiply: a post with three votes and two comments
comes back as six rows, and a plain `count()` would call that six of each. The
counts are `count(distinct …)` for that reason, and the comments join is added
only when that sort is asked for, so every other page pays nothing. There is a
test that would have caught the fan-out.

**Two constants to keep in step across three implementations** — the API, the
in-browser demo adapter and `mock_api.py`. They are named at the top of each,
pointing here, and the end-to-end suite runs the same ordering assertions
against both stand-ins.

**A ranked page is not stable under pagination.** A vote cast while you scroll
reorders the list underneath the offsets. The `as_of` window from
[ADR 0005](0005-offset-pagination.md) is deliberately *not* applied here: it
pins a moment in time, and time is not what these are ordered by. The
chronological feed is the one that gets the window, and the one the "new posts"
control will insert into.

## When to change our minds

- **If the feed gets busy** — several posts an hour rather than a day — the
  half-lives should come down, and 1.5 stops being wrong. Re-measure against
  real data rather than moving it by feel; the script that produced the tables
  above is four lines over `seed.json`.
- **If `warm` and `newest` start agreeing** for more than a day at a time, the
  gravity is too high for the volume, whatever the number says.
- **If a third ranking appears**, stop and think before adding a third
  constant. Two is a distinction; three is a dial nobody will ever tune.
