"""Shared rate limiter, and the limits themselves.

Lives in its own module so both ``main.py`` and the routers can import it
without creating a circular import (``main`` imports the routers).

── what this limiter is and is not ───────────────────────────────────────────
It is **per-process, in-memory, and keyed on the socket address**, and each of
those three words is a limitation worth naming rather than discovering:

* *Per-process.* The counters live in this process's memory. Two workers mean
  two sets of counters, so the effective limit is the written one multiplied by
  the number of replicas — and a restart clears every counter at once.
* *In-memory.* There is no shared store, so nothing survives a deploy.
* *Keyed on the socket address.* ``get_remote_address`` reads the peer of the
  TCP connection. Behind any reverse proxy that peer is the proxy, so every
  client in the world shares one bucket and the first few requests after a
  deploy spend everyone's budget.

None of that bites here: one process, no proxy, and the limits are a brake on
automated abuse rather than a quota anybody is meant to feel. The fix, when it
does bite, is two changes and not one — ``storage_uri="redis://…"`` so the
counters are shared, **and** ``ProxyHeadersMiddleware`` (or uvicorn's
``--proxy-headers``) so the key is the real client again. Doing only the first
gives one accurate bucket for the entire internet.

── why the writes are keyed the same way ─────────────────────────────────────
A limit on an authenticated write would rather be keyed on *who* is writing
than on where from: an office behind one NAT is one key, and a person with a
token is the thing being limited. slowapi's key function is handed the raw
request, before any dependency has run, so keying on the caller would mean
decoding the bearer token a second time inside the key function and deciding
what to do when it doesn't decode. Not worth it at this size. It is written
down here so the next person doesn't have to work out that it was a choice.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

from .config import settings

# key_func decides "who" a limit is counted against — here, the client IP.
limiter = Limiter(key_func=get_remote_address, enabled=settings.rate_limit_enabled)

# ── the write limits ─────────────────────────────────────────────────────────
# Named here rather than spelled into each decorator, so that the numbers can
# be compared with each other and changed together.
#
# The shape of them: reads are never limited (the feed is the front door), the
# credential endpoints are tight because an unlimited retry budget there is a
# guessing budget, and the writes below are set where no person will ever reach
# them and a script will. They bound damage; they are not a quota.

# Writing a post is composing prose. Thirty an hour is already not a person.
CREATE_POST = "30/hour"
# Editing and deleting your own work — more room than writing, because a fussy
# author really does save the same post several times in a row.
EDIT_POST = "60/hour"
# Voting is a keyboard action (`u` in the feed), so this has to clear a fast
# reader going down a page. One a second, sustained, does.
VOTE = "60/minute"
# A comment is a sentence, not an essay, and a thread can move quickly.
CREATE_COMMENT = "20/minute"
# Removing what you wrote should never be the thing that gets you a 429.
DELETE_COMMENT = "60/minute"
# Saving to the shelf is a toggle next to a card, and a reader filling a shelf
# taps several in a row.
SHELVE = "60/minute"
