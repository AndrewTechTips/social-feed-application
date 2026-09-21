# 0012 — Notification preferences are a view filter, kept on the client

**Status:** accepted · 2026-09-21

## What was decided

The two notification switches on `#/settings` — *Replies to you* and
*Comments on your posts* — are **a filter over what this browser shows and
counts**, not a instruction to the server about what to record.

- The rows are created either way. Switching a kind off hides it; switching it
  back on reveals everything that arrived meanwhile.
- The preference lives in `localStorage` under `commons.notify`, with the
  browser's other business, and only the difference from the default is
  stored.
- `/api/v1/notifications/` gains no `kind` parameter.

The count and the list are filtered by the same function —
[`wanted()` in `notify.js`](../../frontend/js/notify.js) — so the number in the
header and the rows on the screen cannot disagree.

## Why

**It is a preference about reading, not about recording.** Somebody who turns
comments off for a fortnight and turns them back on should find out what they
missed. The alternative — the server declines to write the row — means the
fortnight is gone, and the setting has quietly become destructive in a way its
label does not admit. Nothing else in this app throws away a record to
implement a display choice.

**A server-side filter would be the same thing, further away.** The rows would
still exist; the query would just not return them. That buys an exact count
(see the cost below) at the price of a preferences table, an endpoint
parameter, and a round trip before the reader can be told anything — for a
setting whose whole meaning is local to one browser. The account already has a
shelf on the server because a shelf *is* the reader's data and follows them
between machines. Which kinds of line you like to be shown is not that.

**The client can already tell them apart.** Every row carries `kind`, stored
rather than derived, because `models.Notification` decided a record should not
recompute itself from other rows. That decision is what makes this one cheap.

## What it costs

**The count is no longer free, for the reader who filters.** The unread count
has always been the envelope's `total` for a one-row page — one request, one
number. The server cannot count only the kinds this browser wants, so when a
kind is switched off the same single request asks for a page of rows instead
and the matching ones are counted here.

Same round trip, larger body, and only for the reader who asked for it:
everybody who has never opened settings still gets the one-row ask unchanged.
That asymmetry is deliberate and is the reason this was worth doing at all.

**It is capped at fifty.** `COUNT_CAP` matches the endpoint's own `page_size`
ceiling. A reader with more than fifty unread has a number they are no longer
reading, and walking every page on a forty-five second timer to refine
"lots" into "lots" would be spending somebody's battery on nothing.

**The empty list has to explain itself.** A screen that said "Nothing yet"
while the server held rows would be blaming an empty inbox for a setting the
reader chose. `views/notifications.js` says which switch emptied it and where
to find it, which is one more branch than an unfiltered list needs.

**Two places now decide what counts.** The header's number and the list's rows
are different code paths over the same rule, which is why the rule is one
exported function and not two `if`s. `notifyprefs.spec.js` asserts they agree.

## When to change our minds

- **If notification volume ever justifies it** — many kinds, or counts that
  routinely pass the cap — the honest answer is a `kind` parameter on the list
  endpoint, and this ADR is superseded rather than amended. The client-side
  filter would come out entirely; a filter in two places is worse than either.
- **If a preference ever has to follow the reader between devices**, it stops
  being a view filter and becomes account data, with a table and a migration.
  That is a different feature and should be argued on its own.
- **If the server learns to suppress rows**, note that it is a different
  product decision, not an optimisation of this one: it makes the setting
  destructive, and the label would have to say so.
