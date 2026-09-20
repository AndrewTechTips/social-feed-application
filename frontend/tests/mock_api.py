#!/usr/bin/env python3
"""
A stand-in for the Social Feed API, faithful to the frozen contract in the
frontend brief. Standard library only — no Postgres, no pip installs — so the
Playwright end-to-end suite is hermetic and fast.

It is NOT the real backend. Use the real one (uvicorn + Postgres, see the repo
README) for the final manual pass. This mock exists so `npm test` can run
anywhere.

Run:  python3 frontend/tests/mock_api.py [--port 8000]

Test-only helpers (prefixed __ so they can't be mistaken for the real API):
  POST /__reset                         wipe all state
  POST /__seed   {count, author?, votes?}  create N published posts
  POST /__fail_next {method, path, status, detail?}
                                        force the next matching request to fail
  GET  /__state                         the whole store, for assertions about
                                        rows with no public read path — a
                                        cascade being the obvious one
  POST /__expire_access                 age every outstanding access token out
                                        of validity, which is how a spec gets
                                        to watch the refresh flow recover from
                                        an expiry without waiting fifteen
                                        minutes for one

Auth is the two-token flow the real backend runs: a short access token in the
response body, and a refresh token in an httpOnly, SameSite=Lax cookie scoped
to /auth. The cookie is a real one — this is an HTTP server, so the browser
stores it, withholds it from every content route, and keeps it away from
JavaScript exactly as it would in production. That is most of the reason this
mock is worth having alongside the in-browser demo adapter, which has no
origin to hang a cookie on.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# Mirrors schemas.USERNAME_RE in the real backend. Three implementations of one
# rule is two too many, but the alternative is a mock that accepts what the API
# refuses — which is how a suite certifies a bug.
USERNAME_RE = re.compile(r"^[a-z][a-z0-9_-]{2,19}$")
RESERVED_USERNAMES = {"me", "admin", "api", "root", "commons"}
# Mirrors schemas.COMMENT_MAX.
COMMENT_MAX = 2000
LOCK = threading.Lock()

# Mirrors settings.access_token_expire_minutes. Short on purpose in both
# places: the whole design assumes a token that runs out is unremarkable.
ACCESS_TTL_SECONDS = 15 * 60
# Mirrors oauth2.ROTATION_GRACE: how long the secret a rotation just replaced
# stays acceptable, so that two tabs reloading together don't look like a
# replay and revoke the session.
ROTATION_GRACE = timedelta(seconds=15)
# Mirrors API_PREFIX in backend/app/config.py. Every route below is written
# without it and _route strips it off on the way in, so this file reads against
# backend/app/routers/ rather than against a decorated copy of it.
API_PREFIX = "/api/v1"

REFRESH_COOKIE = "commons_refresh"
REFRESH_COOKIE_PATH = f"{API_PREFIX}/auth"
CSRF_HEADER = "X-CSRF-Token"


def now() -> datetime:
    return datetime.now(timezone.utc)


def _excerpt(content: str) -> str:
    """Mirrors _excerpt in backend/app/routers/notification.py: cut on a word,
    marked with an ellipsis, so a line reads as abbreviated rather than broken."""
    text = " ".join(content.split())
    if len(text) <= State.EXCERPT_CHARS:
        return text
    cut = text[: State.EXCERPT_CHARS].rsplit(" ", 1)[0]
    return f"{cut or text[: State.EXCERPT_CHARS]}…"


def now_iso(offset_seconds: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


# — ranking ------------------------------------------------------------------
# Mirrors VOTE_GRAVITY / COMMENT_GRAVITY in backend/app/routers/post.py. See
# docs/adr/0008-a-ranking-with-two-gravities.md for how they were chosen.
VOTE_GRAVITY = 0.5
COMMENT_GRAVITY = 0.25
SORTS = ("new", "warm", "discussed")


def decayed(count: int, created_at: str, gravity: float) -> float:
    age = datetime.now(timezone.utc) - datetime.fromisoformat(created_at)
    hours = max(0.0, age.total_seconds() / 3600.0)
    return count / ((hours + 2) ** gravity)


# — search -------------------------------------------------------------------
# The real backend hands this to Postgres: a generated tsvector over title
# (weight A) and body (weight B), a GIN index, websearch_to_tsquery, and
# ts_rank for the ordering. None of that exists in the standard library, so
# what follows is a deliberate approximation with the same observable
# behaviour: words not substrings, AND across terms, stop words ignored, a
# title hit worth more than a body hit, and punctuation treated as text.
#
# The one thing it is *not* is a Porter stemmer. STEM_SUFFIXES is a crude
# suffix strip that agrees with Postgres on the cases a search box actually
# sees — repair/repairing/repaired/repairs collapsing together — and is
# internally consistent everywhere else, which is what keeps the same
# Playwright specs passing against both.
#
# Verbatim from Postgres 18's share/tsearch_data/english.stop, so a query of
# only stop words parses to nothing here exactly as it does there.
STOP_WORDS = frozenset(
    """
    i me my myself we our ours ourselves you your yours yourself yourselves he
    him his himself she her hers herself it its itself they them their theirs
    themselves what which who whom this that these those am is are was were be
    been being have has had having do does did doing a an the and but if or
    because as until while of at by for with about against between into through
    during before after above below to from up down in out on off over under
    again further then once here there when where why how all any both each few
    more most other some such no nor not only own same so than too very s t can
    will just don should now
    """.split()
)

# Order matters: the longest suffix that applies wins, and the bare "e" comes
# last so "kettle" and "kettles" both land on "kettl" — which is exactly what
# Postgres does, and the case that showed this list was one entry short.
STEM_SUFFIXES = ("ies", "ing", "ed", "es", "s", "e")
WORD_RE = re.compile(r"[a-z0-9]+")

# ts_rank's default weights: a word in the title counts for 1.0, the same word
# in the body for 0.4.
TITLE_WEIGHT = 1.0
BODY_WEIGHT = 0.4


def stem(word: str) -> str:
    for suffix in STEM_SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            base = word[: -len(suffix)]
            return base + "i" if suffix == "ies" else base
    return word


def lexemes(value: str) -> set[str]:
    """The words of a piece of text, as the index would keep them."""
    return {
        stem(w) for w in WORD_RE.findall((value or "").lower()) if w not in STOP_WORDS
    }


def search_terms(search: str) -> list[str]:
    """What the caller actually asked for. Empty when they asked nothing —
    an empty box, punctuation only, or nothing but stop words."""
    return [
        stem(w)
        for w in WORD_RE.findall((search or "").lower())
        if w not in STOP_WORDS
    ]


# The markers ts_headline is configured with in backend/app/routers/post.py.
# Control characters rather than HTML, and the note there says why at length.
HEADLINE_START = "\x02"
HEADLINE_STOP = "\x03"
HEADLINE_WORDS = 30
HEADLINE_LEAD = 8  # words of run-up before the first match


def headline(content: str, terms: list[str]) -> str:
    """A stand-in for ts_headline: the part of a post that answers the search,
    with the matching words marked.

    An approximation like the rest of the search in this file — Postgres finds
    the best *fragment* by a cover density it would take a day to reproduce,
    and this centres a fixed window on the first match. What it gets right is
    the two things a caller can see: the words marked are the stemmed matches,
    and nothing about the result is markup.
    """
    tokens = (content or "").split()
    hits = [
        i
        for i, tok in enumerate(tokens)
        if (found := WORD_RE.findall(tok.lower())) and stem(found[0]) in terms
    ]
    # No match in the body — the search hit the title. Postgres falls back to
    # the opening of the document, so this does too.
    start = max(0, hits[0] - HEADLINE_LEAD) if hits else 0
    window = tokens[start : start + HEADLINE_WORDS]

    def mark(tok: str) -> str:
        found = WORD_RE.search(tok.lower())
        if not found or stem(found.group(0)) not in terms:
            return tok
        a, b = found.span()
        return tok[:a] + HEADLINE_START + tok[a:b] + HEADLINE_STOP + tok[b:]

    return " ".join(mark(t) for t in window)


def search_rank(row: dict, terms: list[str]) -> float | None:
    """How well one post answers a search, or None if it doesn't.

    Every term has to appear somewhere — bare words are ANDed, the way
    websearch_to_tsquery joins them.
    """
    title = lexemes(row["title"])
    body = lexemes(row["content"])
    score = 0.0
    for term in terms:
        if term in title:
            score += TITLE_WEIGHT
        elif term in body:
            score += BODY_WEIGHT
        else:
            return None
    return score


class State:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.users: dict[str, dict] = {}  # email -> {id, email, password, created_at}
        # Access tokens, with an expiry, because "it expired mid-session and
        # the app quietly recovered" is a thing the suite has to be able to
        # provoke. token -> (email, expires_at)
        self.tokens: dict[str, tuple[str, datetime]] = {}
        # Refresh sessions, keyed by family id — the same shape as the real
        # backend's refresh_sessions table, so rotation, the grace window and
        # reuse detection all behave the same way here.
        # family -> {"email", "secret", "previous", "rotated_at", "csrf",
        #            "revoked"}
        self.sessions: dict[str, dict] = {}
        self.posts: dict[int, dict] = {}  # id -> post row
        self.votes: set[tuple[str, int]] = set()  # (email, post_id)
        # The shelf. A list rather than a set because a shelf has an order and
        # a tally doesn't — most recently saved first, which is what the real
        # `ix_saves_user_id_created_at` hands back without a sort.
        self.saves: list[tuple[str, int]] = []  # (email, post_id), newest first
        self.comments: dict[int, dict] = {}  # id -> comment row
        # id -> {user_email, actor_email, comment_id, kind, created_at, read_at}
        self.notifications: dict[int, dict] = {}
        self.next_user_id = 1
        self.next_post_id = 1
        self.next_comment_id = 1
        self.next_notification_id = 1
        self.fail_next: list[dict] = []

    # — users / auth ------------------------------------------------------------
    def create_user(self, email: str, password: str, username: str) -> dict:
        user = {
            "id": self.next_user_id,
            "username": username,
            "email": email,
            "password": password,
            "created_at": now_iso(),
        }
        self.users[email] = user
        self.next_user_id += 1
        return user

    def user_by_username(self, username: str) -> dict | None:
        folded = (username or "").lower()
        for user in self.users.values():
            if user["username"] == folded:
                return user
        return None

    def issue_token(self, email: str) -> str:
        tok = secrets.token_urlsafe(24)
        self.tokens[tok] = (email, now() + timedelta(seconds=ACCESS_TTL_SECONDS))
        return tok

    def email_for(self, token: str | None) -> str | None:
        found = self.tokens.get(token or "")
        if not found:
            return None
        email, expires_at = found
        return email if expires_at > now() else None

    def expire_access_tokens(self) -> None:
        """Age every outstanding access token. The refresh cookies are left
        alone, which is precisely the state a client should recover from
        without anybody seeing a sign-in form."""
        past = now() - timedelta(seconds=1)
        self.tokens = {tok: (email, past) for tok, (email, _) in self.tokens.items()}

    # — refresh sessions ----------------------------------------------------------
    def open_session(self, email: str) -> tuple[str, str]:
        family = secrets.token_hex(16)
        self.sessions[family] = {
            "email": email,
            "secret": "",
            "previous": None,
            "rotated_at": now(),
            # Issued once and handed back unchanged on every refresh, exactly
            # as the real backend does: two tabs each hold their own copy, and
            # rotating it would let the one whose response lands second store a
            # value the server had already replaced.
            "csrf": secrets.token_urlsafe(32),
            "revoked": False,
        }
        return f"{family}.{self.rotate_in_place(family)}", self.sessions[family]["csrf"]

    def rotate_in_place(self, family: str) -> str:
        row = self.sessions[family]
        row["previous"] = row["secret"] or None
        row["rotated_at"] = now()
        row["secret"] = secrets.token_urlsafe(32)
        return row["secret"]

    def rotate(
        self, raw: str | None, csrf: str | None
    ) -> tuple[str, str, str] | str:
        """Mirrors oauth2.rotate_refresh_session.

        Returns (email, cookie, csrf) on success, or one of two strings on
        failure — "dead" when the cookie itself is no good and should be
        expired, "forged" when the cookie is fine and the CSRF token isn't, in
        which case nothing is touched. The caller answers both with the same
        401 and the same body; the difference is a header a cross-site page
        can't see. See the note on oauth2.RefreshRejected.
        """
        family, _, secret = (raw or "").partition(".")
        if not family or not secret:
            return "dead"
        row = self.sessions.get(family)
        if row is None or row["revoked"]:
            return "dead"
        if not secrets.compare_digest(row["secret"], secret):
            # The grace window: two tabs reloading together both send what the
            # cookie jar held a moment ago, and that is not a replay.
            graced = (
                row["previous"]
                and secrets.compare_digest(row["previous"], secret)
                and now() - row["rotated_at"] <= ROTATION_GRACE
            )
            if not graced:
                # A live family, an old secret, no window left to explain it:
                # the cookie was copied. End the session rather than guess
                # which holder is the thief.
                row["revoked"] = True
                return "dead"
        if not csrf or not secrets.compare_digest(row["csrf"], csrf):
            return "forged"
        return row["email"], f"{family}.{self.rotate_in_place(family)}", row["csrf"]

    def close_all_sessions(self, email: str) -> int:
        """Mirrors oauth2.close_all_refresh_sessions. Revoked, not dropped —
        a revoked family is what lets a cookie presented later be answered
        with "that session is over" rather than "no such session"."""
        count = 0
        for row in self.sessions.values():
            if row["email"] == email and not row["revoked"]:
                row["revoked"] = True
                count += 1
        return count

    def delete_user(self, email: str) -> None:
        """Mirrors what the real backend gets from ON DELETE CASCADE.

        Written out by hand here because a dict has no foreign keys, which is
        exactly why it is worth checking the list against models.py rather than
        against memory: posts, the comments under them, the comments left
        elsewhere, votes, sessions and tokens. Six, and the easy one to forget
        is the fourth — a comment that points away from you, under somebody
        else's post.
        """
        mine = [pid for pid, row in self.posts.items() if row["author_email"] == email]
        for pid in mine:
            self.posts.pop(pid, None)
        self.comments = {
            cid: row
            for cid, row in self.comments.items()
            if row["author_email"] != email and row["post_id"] not in mine
        }
        # And the replies to what just went, which is the second step of a
        # cascade the database would have walked on its own.
        while True:
            orphans = [
                cid
                for cid, row in self.comments.items()
                if row.get("parent_id") and row["parent_id"] not in self.comments
            ]
            if not orphans:
                break
            for cid in orphans:
                self.comments.pop(cid, None)
        self.votes = {(e, pid) for (e, pid) in self.votes if e != email and pid not in mine}
        # Both directions of the `saves` cascade: this person's shelf, and
        # everyone else's saves of the posts that just went with them.
        self.saves = [
            (e, pid) for (e, pid) in self.saves if e != email and pid not in mine
        ]
        self.sessions = {
            fam: row for fam, row in self.sessions.items() if row["email"] != email
        }
        self.tokens = {
            tok: pair for tok, pair in self.tokens.items() if pair[0] != email
        }
        # Both ways round — what was said to you, and what you said to anyone —
        # and then anything left pointing at a comment that has just gone. In
        # the real schema all three are one line of ON DELETE CASCADE each; here
        # they are three predicates, which is why the rule is stated rather than
        # the removals listed.
        self.drop_notifications(email=email)
        self.notifications = {
            nid: row
            for nid, row in self.notifications.items()
            if row["comment_id"] in self.comments
        }
        self.users.pop(email, None)

    def close_session(self, raw: str | None, csrf: str | None) -> None:
        family, _, secret = (raw or "").partition(".")
        row = self.sessions.get(family)
        if not row or row["revoked"]:
            return
        known = [row["secret"]] + ([row["previous"]] if row["previous"] else [])
        if not any(secrets.compare_digest(k, secret) for k in known):
            return
        if not csrf or not secrets.compare_digest(row["csrf"], csrf):
            return
        row["revoked"] = True

    # — posts ---------------------------------------------------------------------
    def public_user(self, email: str) -> dict:
        """UserOut: the username is the public identity, and the email stays
        with the account it belongs to."""
        u = self.users[email]
        return {
            "id": u["id"],
            "username": u["username"],
            "created_at": u["created_at"],
        }

    def post_out(
        self, row: dict, viewer: str | None = None, terms: list[str] | None = None
    ) -> dict:
        """One post in the shape PostOut describes.

        `viewer` decides `voted` and `saved` and nothing else. The count is the room's and
        the flag is the reader's: the same row answers differently for two
        people, which is why neither is stored on it.

        `terms` decides `excerpt`, and for the same reason: it is an answer to
        a question, so without one there is nothing to answer.
        """
        author = row["author_email"]
        return {
            "id": row["id"],
            "title": row["title"],
            "content": row["content"],
            "published": row["published"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "user_id": self.users[author]["id"],
            "user": self.public_user(author),
            "votes": sum(1 for (_e, pid) in self.votes if pid == row["id"]),
            # False for a reader who isn't signed in, which is the truthful
            # answer rather than a missing one.
            "voted": viewer is not None and (viewer, row["id"]) in self.votes,
            # Same terms as `voted`: a fact about the pair, false rather than
            # missing for a reader who isn't signed in.
            "saved": viewer is not None and (viewer, row["id"]) in self.saves,
            # Only when somebody asked a question; see headline() above.
            "excerpt": headline(row["content"], terms) if terms else None,
        }

    def add_post(
        self, author_email: str, title: str, content: str, published: bool
    ) -> dict:
        ts = now_iso(
            offset_seconds=self.next_post_id
        )  # keep created_at ordering stable
        row = {
            "id": self.next_post_id,
            "title": title,
            "content": content,
            "published": published,
            "author_email": author_email,
            "created_at": ts,
            "updated_at": ts,
        }
        self.posts[row["id"]] = row
        self.next_post_id += 1
        return row

    # — comments ------------------------------------------------------------------
    def comment_out(self, row: dict, with_replies: bool = False) -> dict:
        """One comment. `with_replies` is what makes it a conversation rather
        than a message — mirrors CommentOut vs ReplyOut in schemas.py, where the
        one-level rule lives: a reply has no replies of its own."""
        author = row["author_email"]
        out = {
            "id": row["id"],
            "content": row["content"],
            "created_at": row["created_at"],
            "post_id": row["post_id"],
            "user_id": self.users[author]["id"],
            "user": self.public_user(author),
            "parent_id": row.get("parent_id"),
        }
        if with_replies:
            out["replies"] = [self.comment_out(r) for r in self.replies_to(row["id"])]
        return out

    def replies_to(self, comment_id: int) -> list[dict]:
        rows = [r for r in self.comments.values() if r.get("parent_id") == comment_id]
        rows.sort(key=lambda r: (r["created_at"], r["id"]))
        return rows

    # — notifications ------------------------------------------------------
    # Mirrors backend/app/routers/notification.py::notify and the cascades
    # declared on models.Notification. One comment, at most one notification;
    # a reply addresses whoever it answers, a top-level comment addresses the
    # post's author, and talking to yourself is not an event. Votes make none.
    EXCERPT_CHARS = 140

    def notify(self, comment: dict, actor_email: str) -> None:
        if comment.get("parent_id") is not None:
            parent = self.comments.get(comment["parent_id"])
            if parent is None:
                return
            recipient = parent["author_email"]
            kind = "reply"
        else:
            post = self.posts.get(comment["post_id"])
            if post is None:
                return
            recipient = post["author_email"]
            kind = "comment"

        if recipient == actor_email:
            return

        nid = self.next_notification_id
        self.notifications[nid] = {
            "id": nid,
            "user_email": recipient,
            "actor_email": actor_email,
            "comment_id": comment["id"],
            "kind": kind,
            "created_at": now_iso(offset_seconds=nid),
            "read_at": None,
        }
        self.next_notification_id += 1

    def drop_notifications(self, *, comment_ids=None, email=None) -> None:
        """The three cascades, by hand. A dict has no foreign keys, which is
        why the list is worth reading against models.py rather than memory."""
        self.notifications = {
            nid: row
            for nid, row in self.notifications.items()
            if not (comment_ids is not None and row["comment_id"] in comment_ids)
            and not (
                email is not None
                and email in (row["user_email"], row["actor_email"])
            )
        }

    def add_comment(
        self,
        post_id: int,
        author_email: str,
        content: str,
        parent_id: int | None = None,
    ) -> dict:
        row = {
            "id": self.next_comment_id,
            "post_id": post_id,
            "author_email": author_email,
            "content": content,
            "parent_id": parent_id,
            # offset by the id so created_at ordering is stable and distinct,
            # the same trick add_post uses
            "created_at": now_iso(offset_seconds=self.next_comment_id),
        }
        self.comments[row["id"]] = row
        self.next_comment_id += 1
        return row

    def comments_on(self, post_id: int, top_level_only: bool = False) -> list[dict]:
        """Oldest first — a thread is read top to bottom."""
        rows = [
            r
            for r in self.comments.values()
            if r["post_id"] == post_id
            and not (top_level_only and r.get("parent_id") is not None)
        ]
        rows.sort(key=lambda r: (r["created_at"], r["id"]))
        return rows

    def drop_replies_to(self, comment_id: int) -> None:
        """What the ON DELETE CASCADE on comments.parent_id does."""
        gone = [r["id"] for r in self.replies_to(comment_id)]
        for rid in gone:
            self.comments.pop(rid, None)
        # And the notifications about them, which cascade from comments.id.
        self.drop_notifications(comment_ids=set(gone))

    def drop_comments_on_post(self, post_id: int) -> None:
        """ON DELETE CASCADE, by hand. The real schema does this in Postgres;
        here it has to be remembered, which is exactly why there's a test for
        it on both sides."""
        gone = [c["id"] for c in self.comments.values() if c["post_id"] == post_id]
        for cid in gone:
            del self.comments[cid]
        self.drop_notifications(comment_ids=set(gone))


ST = State()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # — plumbing ---------------------------------------------------------------
    def log_message(self, *args) -> None:  # keep the test console quiet
        pass

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        # Echoed, never a wildcard, and credentials only where there is an
        # origin to grant them to. `Access-Control-Allow-Origin: *` alongside
        # `Allow-Credentials: true` is a combination the fetch spec refuses
        # outright, so a wildcard here would break the browser rather than
        # merely being lax — and the real backend's CORS config has the same
        # property for the same reason. curl and friends send no Origin and
        # need none of this.
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")
        if origin:
            self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header(
            "Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        )
        self.send_header(
            "Access-Control-Allow-Headers",
            f"Authorization, Content-Type, {CSRF_HEADER}, If-None-Match",
        )
        # Without this the browser keeps the validator to itself and
        # `res.headers.get("ETag")` is null — the conditional request then
        # silently never happens and everything goes on working. Mirrors
        # expose_headers in backend/app/main.py.
        self.send_header("Access-Control-Expose-Headers", "ETag")

    def _send_conditional(self, payload) -> None:
        """A 200 with an ETag, or a 304 if the caller already has this one.

        Mirrors the ETagRoute on backend/app/routers/post.py — see
        backend/app/etag.py, including the note on what it does not save. The
        hash need not agree with the backend's: a validator is opaque, and a
        client only ever compares one to the one the same server gave it.
        """
        body = json.dumps(payload).encode()
        tag = f'W/"{hashlib.blake2b(body, digest_size=16).hexdigest()}"'
        offered = [
            v.strip()
            for v in self.headers.get("If-None-Match", "").split(",")
            if v.strip()
        ]

        if "*" in offered or tag in offered:
            self.send_response(304)
            self._cors()
            self.send_header("ETag", tag)
            # This endpoint answers differently depending on who is asking.
            self.send_header("Vary", "Authorization")
            self.end_headers()
            return

        self.send_response(200)
        self._cors()
        self.send_header("ETag", tag)
        self.send_header("Vary", "Authorization")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send(self, status: int, payload, cookie: str | None = None) -> None:
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        if body:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    # — the refresh cookie ---------------------------------------------------
    # Written by hand rather than with http.cookies, because the flags are the
    # part that matters and SimpleCookie's spelling of SameSite has changed
    # between Python versions. Same flags as the real backend sets, in the same
    # order, so the two are diffable by eye.
    #
    # No Secure: the suite runs over http, and a Secure cookie would be dropped
    # by the browser without a word — which is a very long afternoon.
    @staticmethod
    def _refresh_cookie(token: str) -> str:
        return (
            f"{REFRESH_COOKIE}={token}; Path={REFRESH_COOKIE_PATH}; "
            f"Max-Age={14 * 24 * 60 * 60}; HttpOnly; SameSite=Lax"
        )

    @staticmethod
    def _cleared_cookie() -> str:
        return f"{REFRESH_COOKIE}=; Path={REFRESH_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax"

    def _cookie(self, name: str) -> str | None:
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
        return None

    def _token_body(self, access_token: str, csrf_token: str) -> dict:
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "expires_in": ACCESS_TTL_SECONDS,
            "csrf_token": csrf_token,
        }

    def _body(self) -> bytes:
        """The request body, read exactly once per request by ``_route``.

        It has to be read *unconditionally*, even by handlers that don't want
        it, and that is not a style preference. This server speaks HTTP/1.1, so
        connections are reused: bytes left unread sit in the socket and the
        next request parsed off that connection starts in the middle of them.

        That is not hypothetical. ``/__fail_next`` used to answer before any
        handler touched the body, so forcing a failure on a request that had
        one — a login, a post, a comment — left the form data in the pipe and
        the *following* request on that connection came back as a parse error
        with no CORS headers on it. Which the browser reports as "blocked by
        CORS policy", and which sends you looking in entirely the wrong place.
        """
        return self._read_body

    def _json(self) -> dict:
        raw = self._body()
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            return {}

    def _form(self) -> dict:
        return {k: v[0] for k, v in parse_qs(self._body().decode()).items()}

    def _token(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        return auth[7:] if auth.startswith("Bearer ") else None

    def _require_auth(self) -> str | None:
        email = ST.email_for(self._token())
        if not email:
            self._send(401, {"detail": "Could not validate credentials"})
            return None
        return email

    def _may_see(self, row: dict, viewer: str | None) -> bool:
        """Published posts are public; a draft belongs to its author.

        Mirrors visible_to() in backend/app/routers/post.py. If the two ever
        disagree, this mock stops being worth having.
        """
        return row["published"] or row["author_email"] == viewer

    def _maybe_forced_failure(self, method: str, path: str) -> bool:
        for i, rule in enumerate(ST.fail_next):
            if rule["method"] == method and re.search(rule["path"], path):
                ST.fail_next.pop(i)
                self._send(
                    rule["status"], {"detail": rule.get("detail", "Forced failure")}
                )
                return True
        return False

    # — verbs ----------------------------------------------------------------------
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        with LOCK:
            self._route("GET")

    def do_POST(self) -> None:
        with LOCK:
            self._route("POST")

    def do_PUT(self) -> None:
        with LOCK:
            self._route("PUT")

    def do_PATCH(self) -> None:
        with LOCK:
            self._route("PATCH")

    def do_DELETE(self) -> None:
        with LOCK:
            self._route("DELETE")

    # — the routing table --------------------------------------------------------
    def _route(self, method: str) -> None:
        path = urlparse(self.path).path
        if path.startswith(API_PREFIX):
            path = path[len(API_PREFIX) :] or "/"
        query = parse_qs(urlparse(self.path).query)

        # Before anything can answer, and before anything can decline to. See
        # the note on _body().
        length = int(self.headers.get("Content-Length", 0) or 0)
        self._read_body = self.rfile.read(length) if length else b""

        if self._maybe_forced_failure(method, path):
            return

        if path == "/":
            return self._send(200, {"service": "commons-mock-api"})
        if path == "/healthz":
            return self._send(200, {"status": "ok"})

        # test-only helpers
        if path == "/__reset" and method == "POST":
            ST.reset()
            return self._send(200, {"ok": True})
        if path == "/__seed" and method == "POST":
            return self._seed(self._json())
        if path == "/__state" and method == "GET":
            # The demo adapter's equivalent is its localStorage blob, which a
            # spec reads straight out of the page. Same shape, same purpose:
            # after a post is deleted its comments have no URL left to ask
            # about, and "did the cascade run" needs some way to be answered.
            return self._send(
                200,
                {
                    "posts": list(ST.posts.values()),
                    "comments": list(ST.comments.values()),
                    "votes": [list(v) for v in ST.votes],
                },
            )
        if path == "/__expire_access" and method == "POST":
            ST.expire_access_tokens()
            return self._send(200, {"ok": True})
        if path == "/__fail_next" and method == "POST":
            rule = self._json()
            ST.fail_next.append(
                {
                    "method": rule.get("method", "GET"),
                    "path": rule.get("path", "/"),
                    "status": int(rule.get("status", 500)),
                    "detail": rule.get("detail", "Forced failure"),
                }
            )
            return self._send(200, {"ok": True})

        if path == "/users/" and method == "POST":
            return self._register(self._json())
        if path == "/users/me" and method == "GET":
            return self._me()
        if path == "/users/me" and method == "PATCH":
            return self._update_me(self._json())
        if path == "/users/me" and method == "DELETE":
            return self._delete_me()

        m = re.match(r"^/users/([^/]+)/posts$", path)
        if m and method == "GET":
            return self._user_posts(m.group(1), query)
        m = re.match(r"^/users/([^/]+)$", path)
        if m and method == "GET":
            return self._profile(m.group(1))
        if path == "/login" and method == "POST":
            return self._login(self._form())
        if path == "/auth/refresh" and method == "POST":
            return self._refresh()
        if path == "/notifications/" and method == "GET":
            return self._list_notifications(query)
        if path == "/notifications/read" and method == "POST":
            return self._mark_notifications_read()
        if path == "/auth/logout" and method == "POST":
            return self._logout()
        if path == "/auth/logout-all" and method == "POST":
            return self._logout_everywhere()
        if path == "/posts/" and method == "GET":
            return self._list_posts(query)
        if path == "/posts/" and method == "POST":
            return self._create_post(self._json())
        if path == "/vote/" and method == "POST":
            return self._vote(self._json())

        if path == "/shelf" and method == "GET":
            return self._get_shelf(query)

        m = re.match(r"^/posts/(\d+)/save$", path)
        if m:
            pid = int(m.group(1))
            if method == "PUT":
                return self._save_post(pid)
            if method == "DELETE":
                return self._unsave_post(pid)

        m = re.match(r"^/posts/(\d+)/comments$", path)
        if m:
            pid = int(m.group(1))
            if method == "GET":
                return self._list_comments(pid, query)
            if method == "POST":
                return self._create_comment(pid, self._json())

        m = re.match(r"^/comments/(\d+)$", path)
        if m and method == "DELETE":
            return self._delete_comment(int(m.group(1)))

        m = re.match(r"^/posts/(\d+)$", path)
        if m:
            pid = int(m.group(1))
            if method == "GET":
                return self._get_post(pid)
            if method == "PUT":
                return self._update_post(pid, self._json(), partial=False)
            if method == "PATCH":
                return self._update_post(pid, self._json(), partial=True)
            if method == "DELETE":
                return self._delete_post(pid)

        self._send(404, {"detail": "Not Found"})

    # — endpoint implementations ----------------------------------------------
    def _register(self, data: dict) -> None:
        email = (data.get("email") or "").strip()
        password = data.get("password") or ""
        username = (data.get("username") or "").strip().lower()
        errors = []
        if not USERNAME_RE.match(username) or username in RESERVED_USERNAMES:
            errors.append(
                {
                    "loc": ["body", "username"],
                    "msg": "3–20 characters: letters, digits, - and _, starting with a letter",
                    "type": "value_error",
                }
            )
        if not EMAIL_RE.match(email):
            errors.append(
                {
                    "loc": ["body", "email"],
                    "msg": "value is not a valid email address",
                    "type": "value_error",
                }
            )
        if len(password) < 8:
            errors.append(
                {
                    "loc": ["body", "password"],
                    "msg": "String should have at least 8 characters",
                    "type": "string_too_short",
                }
            )
        elif len(password.encode()) > 72:
            errors.append(
                {
                    "loc": ["body", "password"],
                    "msg": "password must be at most 72 bytes long",
                    "type": "value_error",
                }
            )
        if errors:
            return self._send(422, {"detail": errors})
        # Username and email collide independently; say which one did.
        if ST.user_by_username(username):
            return self._send(409, {"detail": "That username is taken"})
        if email in ST.users:
            return self._send(
                409, {"detail": "An account with this email already exists"}
            )
        user = ST.create_user(email, password, username)
        self._send(201, ST.public_user(email))

    def _me(self) -> None:
        """Who the caller is.

        Login takes an email and returns a token, which says nothing about the
        person. The frontend needs a name and an id to work out which posts are
        its own — see the note in backend/app/routers/user.py."""
        email = self._require_auth()
        if not email:
            return
        user = ST.users[email]
        self._send(
            200,
            {
                "id": user["id"],
                "username": user["username"],
                "email": user["email"],
                "created_at": user["created_at"],
            },
        )

    def _update_me(self, data: dict) -> None:
        """Change the name everybody else sees. Only the username.

        Nothing else moves, and here that is structural rather than a promise:
        every row in this mock is joined to its author by *email*, which is the
        stand-in for the real backend's user id. A rename that lost a post
        would have to be a bug in this function specifically.
        """
        email = self._require_auth()
        if not email:
            return
        wanted = (data.get("username") or "").strip().lower()
        if not USERNAME_RE.match(wanted) or wanted in RESERVED_USERNAMES:
            return self._send(
                422,
                {
                    "detail": [
                        {
                            "loc": ["body", "username"],
                            "msg": "3–20 characters: letters, digits, - and _, starting with a letter",
                            "type": "value_error",
                        }
                    ]
                },
            )
        user = ST.users[email]
        if wanted != user["username"]:
            taken = ST.user_by_username(wanted)
            if taken:
                return self._send(409, {"detail": "That username is taken"})
            user["username"] = wanted
        self._send(
            200,
            {
                "id": user["id"],
                "username": user["username"],
                "email": user["email"],
                "created_at": user["created_at"],
            },
        )

    def _delete_me(self) -> None:
        email = self._require_auth()
        if not email:
            return
        ST.delete_user(email)
        self._send(204, None, cookie=self._cleared_cookie())

    def _logout_everywhere(self) -> None:
        """Authenticated with the access token, not the cookie — which is the
        whole difference between this and /auth/logout."""
        email = self._require_auth()
        if not email:
            return
        ST.close_all_sessions(email)
        self._send(204, None, cookie=self._cleared_cookie())

    # — notifications --------------------------------------------------------
    # Mirrors backend/app/routers/notification.py. Newest first, yours only, and
    # the unread *count* is asked for through this same route with
    # `?unread=true&page_size=1` — the envelope's `total` is the answer.
    def _list_notifications(self, query: dict) -> None:
        email = self._require_auth()
        if not email:
            return
        try:
            page = int(query.get("page", ["1"])[0])
            page_size = int(query.get("page_size", ["20"])[0])
        except ValueError:
            return self._send(422, {"detail": "bad pagination"})
        if page < 1 or not (1 <= page_size <= 50):
            return self._send(422, {"detail": "bad pagination"})
        unread = query.get("unread", ["false"])[0] == "true"

        rows = [
            r
            for r in ST.notifications.values()
            if r["user_email"] == email and not (unread and r["read_at"] is not None)
        ]
        rows.sort(key=lambda r: (r["created_at"], r["id"]), reverse=True)

        total = len(rows)
        pages = max(1, -(-total // page_size))
        start = (page - 1) * page_size

        items = []
        for row in rows[start : start + page_size]:
            comment = ST.comments.get(row["comment_id"])
            if comment is None:
                # Cannot happen: the cascade takes them together. If it ever
                # does, drop the row rather than render a line pointing at
                # nothing — which is the thing the cascade exists to prevent.
                continue
            post = ST.posts.get(comment["post_id"])
            if post is None:
                continue
            items.append(
                {
                    "id": row["id"],
                    "kind": row["kind"],
                    "created_at": row["created_at"],
                    "read_at": row["read_at"],
                    "actor": ST.public_user(row["actor_email"]),
                    "post": {"id": post["id"], "title": post["title"]},
                    "excerpt": _excerpt(comment["content"]),
                    "comment_id": row["comment_id"],
                }
            )

        self._send(
            200,
            {
                "items": items,
                "total": total,
                "page": page,
                "page_size": page_size,
                "pages": pages,
                "has_next": page < pages,
                "has_prev": page > 1,
            },
        )

    def _mark_notifications_read(self) -> None:
        email = self._require_auth()
        if not email:
            return
        stamp = now_iso()
        for row in ST.notifications.values():
            if row["user_email"] == email and row["read_at"] is None:
                row["read_at"] = stamp
        self._send(204, None)

    def _profile(self, username: str) -> None:
        user = ST.user_by_username(username)
        if not user:
            return self._send(
                404, {"detail": f"There's nobody here called {username}"}
            )
        self._send(200, ST.public_user(user["email"]))

    def _user_posts(self, username: str, query: dict) -> None:
        user = ST.user_by_username(username)
        if not user:
            return self._send(
                404, {"detail": f"There's nobody here called {username}"}
            )
        # Same page shape and the same draft rule as the feed.
        self._list_posts(query, only_author=user["email"])

    def _login(self, form: dict) -> None:
        email = (form.get("username") or "").strip()
        password = form.get("password") or ""
        user = ST.users.get(email)
        if not user or user["password"] != password:
            return self._send(401, {"detail": "Invalid Credentials"})
        cookie, csrf = ST.open_session(email)
        self._send(
            200,
            self._token_body(ST.issue_token(email), csrf),
            cookie=self._refresh_cookie(cookie),
        )

    def _refresh(self) -> None:
        rotated = ST.rotate(
            self._cookie(REFRESH_COOKIE), self.headers.get(CSRF_HEADER)
        )
        if isinstance(rotated, str):
            # Cleared only when the cookie itself is no good, for the same
            # reason the real backend draws that line: what's held can only
            # fail again, and once it's gone the client can tell "signed out"
            # from "temporarily broken". A CSRF failure leaves it alone.
            return self._send(
                401,
                {"detail": "Invalid Credentials"},
                cookie=self._cleared_cookie() if rotated == "dead" else None,
            )
        email, cookie, csrf = rotated
        self._send(
            200,
            self._token_body(ST.issue_token(email), csrf),
            cookie=self._refresh_cookie(cookie),
        )

    def _logout(self) -> None:
        # Only clear what was actually sent: a cross-site form POST carries no
        # cookie, and clearing regardless would let any page sign a reader out.
        presented = self._cookie(REFRESH_COOKIE)
        ST.close_session(presented, self.headers.get(CSRF_HEADER))
        self._send(
            204, None, cookie=self._cleared_cookie() if presented else None
        )

    def _list_posts(self, query: dict, only_author: str | None = None) -> None:
        try:
            page = max(1, int(query.get("page", ["1"])[0]))
            page_size = int(query.get("page_size", ["10"])[0])
        except ValueError:
            return self._send(422, {"detail": "bad pagination"})
        if not (1 <= page_size <= 100):
            return self._send(
                422,
                {
                    "detail": [
                        {
                            "loc": ["query", "page_size"],
                            "msg": "out of range",
                            "type": "value_error",
                        }
                    ]
                },
            )
        search = query.get("search", [""])[0]

        # The window the reader arrived in. Parsed rather than string-compared:
        # this mock stamps UTC, Postgres stamps a local offset, and the anchor
        # a client hands back is whichever one it was given.
        #
        # Only on the feed. The real API declares it on GET /posts/ and nowhere
        # else, and FastAPI ignores a query parameter a route never asked for —
        # so a profile that honoured it here would be answering differently
        # from the thing this file exists to stand in for.
        sort = query.get("sort", ["new"])[0]
        if sort not in SORTS:
            return self._send(
                422,
                {
                    "detail": [
                        {
                            "loc": ["query", "sort"],
                            "msg": f"Input should be {' or '.join(repr(s) for s in SORTS)}",
                            "type": "enum",
                        }
                    ]
                },
            )

        # A window: `as_of` closes it at the top, `since` opens it at the
        # bottom. Both feed-only, for the reason given above.
        bounds: dict[str, datetime | None] = {"as_of": None, "since": None}
        for name in bounds:
            raw = query.get(name, [None])[0]
            if raw is None or only_author is not None:
                continue
            try:
                bounds[name] = datetime.fromisoformat(raw)
            except ValueError:
                return self._send(
                    422,
                    {
                        "detail": [
                            {
                                "loc": ["query", name],
                                "msg": "Input should be a valid datetime or date",
                                "type": "datetime_from_date_parsing",
                            }
                        ]
                    },
                )
        as_of, since = bounds["as_of"], bounds["since"]
        if len(search) > 100:  # matches max_length on the real endpoint
            return self._send(
                422,
                {"detail": [{"loc": ["query", "search"], "msg": "too long",
                             "type": "value_error"}]},
            )
        viewer = ST.email_for(self._token())

        terms = search_terms(search)
        visible = [
            r
            for r in ST.posts.values()
            if self._may_see(r, viewer)
            and (only_author is None or r["author_email"] == only_author)
            and (as_of is None or datetime.fromisoformat(r["created_at"]) <= as_of)
            # Exclusive: the anchor is a post the reader already has.
            and (since is None or datetime.fromisoformat(r["created_at"]) > since)
        ]

        if terms:
            # Relevance leads, recency breaks the tie — matching the ORDER BY
            # in page_of_posts(). `sort` is ignored here for the same reason it
            # is there: "the warmest, in relevance order" means nothing.
            scored = [(search_rank(r, terms), r) for r in visible]
            ranked = [(rank, r) for rank, r in scored if rank is not None]
            ranked.sort(key=lambda pair: (pair[0], pair[1]["created_at"], pair[1]["id"]),
                        reverse=True)
            rows = [r for _rank, r in ranked]
        elif sort in ("warm", "discussed"):
            if sort == "warm":
                count_of = lambda r: sum(  # noqa: E731
                    1 for (_e, pid) in ST.votes if pid == r["id"]
                )
                gravity = VOTE_GRAVITY
            else:
                count_of = lambda r: sum(  # noqa: E731
                    1 for c in ST.comments.values() if c["post_id"] == r["id"]
                )
                gravity = COMMENT_GRAVITY
            rows = sorted(
                visible,
                key=lambda r: (
                    decayed(count_of(r), r["created_at"], gravity),
                    r["created_at"],
                    r["id"],
                ),
                reverse=True,
            )
        else:
            rows = sorted(
                visible, key=lambda r: (r["created_at"], r["id"]), reverse=True
            )
        total = len(rows)
        pages = (total + page_size - 1) // page_size if total else 0
        start = (page - 1) * page_size
        items = [
            ST.post_out(r, viewer, terms) for r in rows[start : start + page_size]
        ]
        envelope = {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": pages,
            "has_next": page < pages,
            "has_prev": page > 1,
        }
        # The feed and one post are fingerprinted; a profile's page is not,
        # because in the backend it is served by the user router, which does
        # not carry the ETag route class.
        if only_author is None:
            return self._send_conditional(envelope)
        self._send(200, envelope)

    def _get_post(self, pid: int) -> None:
        viewer = ST.email_for(self._token())
        row = ST.posts.get(pid)
        if not row or not self._may_see(row, viewer):
            # Someone else's draft is 404, not 403 — a 403 would confirm it exists.
            return self._send(404, {"detail": f"Post with id: {pid} was not found"})
        self._send_conditional(ST.post_out(row, viewer))

    def _create_post(self, data: dict) -> None:
        email = self._require_auth()
        if not email:
            return
        title = data.get("title")
        content = data.get("content")
        if not isinstance(title, str) or not isinstance(content, str):
            return self._send(
                422,
                {
                    "detail": [
                        {
                            "loc": ["body"],
                            "msg": "title and content are required",
                            "type": "missing",
                        }
                    ]
                },
            )
        published = data.get("published", True)
        row = ST.add_post(email, title, content, bool(published))
        self._send(201, ST.post_out(row, email))

    def _update_post(self, pid: int, data: dict, partial: bool) -> None:
        email = self._require_auth()
        if not email:
            return
        row = ST.posts.get(pid)
        if not row:
            return self._send(404, {"detail": f"Post with id: {pid} does not exist"})
        if row["author_email"] != email:
            return self._send(
                403, {"detail": "Not authorized to perform requested action"}
            )
        if partial:
            fields = {
                k: v for k, v in data.items() if k in ("title", "content", "published")
            }
            if not fields:
                return self._send(400, {"detail": "No fields provided to update"})
        else:
            if not isinstance(data.get("title"), str) or not isinstance(
                data.get("content"), str
            ):
                return self._send(
                    422,
                    {
                        "detail": [
                            {
                                "loc": ["body"],
                                "msg": "title and content are required",
                                "type": "missing",
                            }
                        ]
                    },
                )
            fields = {
                "title": data["title"],
                "content": data["content"],
                "published": bool(data.get("published", True)),
            }
        row.update(fields)
        row["updated_at"] = now_iso()
        self._send(200, ST.post_out(row, email))

    def _delete_post(self, pid: int) -> None:
        email = self._require_auth()
        if not email:
            return
        row = ST.posts.get(pid)
        if not row:
            return self._send(404, {"detail": f"Post with id: {pid} does not exist"})
        if row["author_email"] != email:
            return self._send(
                403, {"detail": "Not authorized to perform requested action"}
            )
        del ST.posts[pid]
        ST.votes = {(e, p) for (e, p) in ST.votes if p != pid}
        # ON DELETE CASCADE on saves.post_id: a deleted post leaves nobody's
        # shelf pointing at nothing.
        ST.saves = [(e, p) for (e, p) in ST.saves if p != pid]
        ST.drop_comments_on_post(pid)
        self._send(204, None)

    # — the shelf ------------------------------------------------------------
    # Mirrors backend/app/routers/shelf.py, including the part that is easy to
    # get wrong by being helpful: **saving is idempotent, both ways**. A shelf
    # is a set, so the second press asks for the state you are already in, and
    # neither direction is ever an error.
    def _save_post(self, pid: int) -> None:
        email = self._require_auth()
        if not email:
            return
        row = ST.posts.get(pid)
        # 404, not 403, for a draft that isn't yours — the same answer reading
        # it gives, so the shelf can't be used to confirm one exists.
        if not row or not self._may_see(row, email):
            return self._send(404, {"detail": f"Post with id: {pid} was not found"})

        if (email, pid) not in ST.saves:
            ST.saves.insert(0, (email, pid))
        self._send(204, None)

    def _unsave_post(self, pid: int) -> None:
        email = self._require_auth()
        if not email:
            return
        # No 404 on this one, deliberately: the post not existing, you not
        # being able to see it, and you not having saved it all end in the same
        # place, which is that it is not on your shelf.
        ST.saves = [(e, p) for (e, p) in ST.saves if not (e == email and p == pid)]
        self._send(204, None)

    def _get_shelf(self, query: dict) -> None:
        email = self._require_auth()
        if not email:
            return
        try:
            page = max(1, int(query.get("page", ["1"])[0]))
            page_size = int(query.get("page_size", ["10"])[0])
        except ValueError:
            return self._send(422, {"detail": "bad pagination"})
        if not (1 <= page_size <= 100):
            return self._send(
                422,
                {
                    "detail": [
                        {
                            "loc": ["query", "page_size"],
                            "msg": "out of range",
                            "type": "value_error",
                        }
                    ]
                },
            )

        # Shelf order, and the visibility rule applied on read rather than
        # cleaned up on write — so a post whose author has since unpublished it
        # leaves the shelf without anything having to run.
        rows = [
            ST.posts[pid]
            for (e, pid) in ST.saves
            if e == email and pid in ST.posts and self._may_see(ST.posts[pid], email)
        ]
        total = len(rows)
        pages = (total + page_size - 1) // page_size if total else 0
        start = (page - 1) * page_size
        self._send(
            200,
            {
                "items": [
                    ST.post_out(r, email) for r in rows[start : start + page_size]
                ],
                "total": total,
                "page": page,
                "page_size": page_size,
                "pages": pages,
                "has_next": page < pages,
                "has_prev": page > 1,
            },
        )

    # — comments -------------------------------------------------------------
    # Comments inherit the post's visibility whole: a draft you can't see has
    # no comments as far as you're concerned, and you can't add one either.
    # Mirrors backend/app/routers/comment.py.
    def _visible_post(self, pid: int, viewer: str | None) -> dict | None:
        row = ST.posts.get(pid)
        if not row or not self._may_see(row, viewer):
            self._send(404, {"detail": f"Post with id: {pid} was not found"})
            return None
        return row

    def _list_comments(self, pid: int, query: dict) -> None:
        viewer = ST.email_for(self._token())
        if self._visible_post(pid, viewer) is None:
            return
        try:
            page = max(1, int(query.get("page", ["1"])[0]))
            page_size = int(query.get("page_size", ["20"])[0])
        except ValueError:
            return self._send(422, {"detail": "bad pagination"})
        if not (1 <= page_size <= 100):
            return self._send(
                422,
                {
                    "detail": [
                        {
                            "loc": ["query", "page_size"],
                            "msg": "out of range",
                            "type": "value_error",
                        }
                    ]
                },
            )

        # The page is over conversations; replies come with their parent. See
        # the long note on get_comments in backend/app/routers/comment.py.
        rows = ST.comments_on(pid, top_level_only=True)
        total = len(rows)
        total_replies = sum(
            1
            for r in ST.comments.values()
            if r["post_id"] == pid and r.get("parent_id") is not None
        )
        pages = (total + page_size - 1) // page_size if total else 0
        start = (page - 1) * page_size
        self._send(
            200,
            {
                "items": [
                    ST.comment_out(r, with_replies=True)
                    for r in rows[start : start + page_size]
                ],
                "total": total,
                "total_replies": total_replies,
                "page": page,
                "page_size": page_size,
                "pages": pages,
                "has_next": page < pages,
                "has_prev": page > 1,
            },
        )

    def _create_comment(self, pid: int, data: dict) -> None:
        email = self._require_auth()
        if not email:
            return
        if self._visible_post(pid, email) is None:
            return
        content = data.get("content")
        if not isinstance(content, str) or not content.strip():
            return self._send(
                422,
                {
                    "detail": [
                        {
                            "loc": ["body", "content"],
                            "msg": "a comment needs something in it",
                            "type": "value_error",
                        }
                    ]
                },
            )
        content = content.strip()
        if len(content) > COMMENT_MAX:
            return self._send(
                422,
                {
                    "detail": [
                        {
                            "loc": ["body", "content"],
                            "msg": f"a comment can be at most {COMMENT_MAX} characters",
                            "type": "value_error",
                        }
                    ]
                },
            )
        parent_id = data.get("parent_id")
        if parent_id is not None:
            parent = ST.comments.get(parent_id)
            if parent is None or parent["post_id"] != pid:
                return self._send(
                    404, {"detail": f"Comment with id: {parent_id} does not exist"}
                )
            if parent.get("parent_id") is not None:
                return self._send(400, {"detail": "Replies go one level deep"})

        row = ST.add_comment(pid, email, content, parent_id)
        ST.notify(row, email)
        self._send(201, ST.comment_out(row))

    def _delete_comment(self, cid: int) -> None:
        email = self._require_auth()
        if not email:
            return
        row = ST.comments.get(cid)
        if not row:
            return self._send(404, {"detail": f"Comment with id: {cid} does not exist"})
        # Yours to remove and nobody else's — the author of the post it sits on
        # doesn't get to either.
        if row["author_email"] != email:
            return self._send(
                403, {"detail": "Not authorized to perform requested action"}
            )
        # The cascade the database does, done here too.
        ST.drop_replies_to(cid)
        del ST.comments[cid]
        ST.drop_notifications(comment_ids={cid})
        self._send(204, None)

    def _vote(self, data: dict) -> None:
        email = self._require_auth()
        if not email:
            return
        pid = data.get("post_id")
        direction = data.get("dir")
        row = ST.posts.get(pid)
        if not row or not self._may_see(row, email):
            return self._send(404, {"detail": f"Post with id: {pid} does not exist"})
        key = (email, pid)
        if direction == 1:
            if key in ST.votes:
                return self._send(
                    409, {"detail": f"User has already voted on post {pid}"}
                )
            ST.votes.add(key)
            return self._send(201, {"message": "Successfully added vote"})
        else:
            if key not in ST.votes:
                return self._send(404, {"detail": "Vote does not exist"})
            ST.votes.discard(key)
            return self._send(201, {"message": "successfully deleted vote"})

    def _seed(self, data: dict) -> None:
        count = int(data.get("count", 0))
        author = (data.get("author") or "seed@commons.test").strip()
        password = data.get("password") or "seedpassword"
        # Upvotes to hang on each post created by this call. The voters are
        # synthetic addresses and no account is made for them: a vote is a
        # (voter, post) pair and the count is a tally of pairs, so inventing
        # five accounts to raise one number would be furniture.
        votes = int(data.get("votes", 0))
        if author not in ST.users:
            # Derive a username the same way the real migration derived them
            # for rows that predated the column.
            base = re.sub(r"[^a-z0-9_-]", "", author.split("@")[0].lower())
            base = base.lstrip("0123456789_-") or "person"
            username = (base[:20] + "xxx")[: max(3, min(20, len(base)))]
            suffix = 1
            while ST.user_by_username(username) or username in RESERVED_USERNAMES:
                suffix += 1
                tail = str(suffix)
                username = base[: 20 - len(tail)] + tail
            ST.create_user(author, password, username)
        created = []
        for _ in range(count):
            n = ST.next_post_id
            row = ST.add_post(
                author,
                f"Seeded post {n}",
                f"This is the body of seeded post number {n}. "
                "It exists so the feed has something to paginate through.",
                True,
            )
            for v in range(votes):
                ST.votes.add((f"voter{v + 1}@commons.test", row["id"]))
            created.append(row["id"])
        self._send(200, {"ok": True, "created": created})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"mock api on http://{args.host}:{args.port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
