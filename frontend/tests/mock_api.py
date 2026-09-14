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
  POST /__seed   {count, author?}       create N published posts
  POST /__fail_next {method, path, status, detail?}
                                        force the next matching request to fail
  GET  /__state                         the whole store, for assertions about
                                        rows with no public read path — a
                                        cascade being the obvious one
"""

from __future__ import annotations

import argparse
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


def now_iso(offset_seconds: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


class State:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.users: dict[str, dict] = {}  # email -> {id, email, password, created_at}
        self.tokens: dict[str, str] = {}  # token -> email
        self.posts: dict[int, dict] = {}  # id -> post row
        self.votes: set[tuple[str, int]] = set()  # (email, post_id)
        self.comments: dict[int, dict] = {}  # id -> comment row
        self.next_user_id = 1
        self.next_post_id = 1
        self.next_comment_id = 1
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
        self.tokens[tok] = email
        return tok

    def email_for(self, token: str | None) -> str | None:
        return self.tokens.get(token or "")

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

    def post_out(self, row: dict) -> dict:
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
    def comment_out(self, row: dict) -> dict:
        author = row["author_email"]
        return {
            "id": row["id"],
            "content": row["content"],
            "created_at": row["created_at"],
            "post_id": row["post_id"],
            "user_id": self.users[author]["id"],
            "user": self.public_user(author),
        }

    def add_comment(self, post_id: int, author_email: str, content: str) -> dict:
        row = {
            "id": self.next_comment_id,
            "post_id": post_id,
            "author_email": author_email,
            "content": content,
            # offset by the id so created_at ordering is stable and distinct,
            # the same trick add_post uses
            "created_at": now_iso(offset_seconds=self.next_comment_id),
        }
        self.comments[row["id"]] = row
        self.next_comment_id += 1
        return row

    def comments_on(self, post_id: int) -> list[dict]:
        """Oldest first — a thread is read top to bottom."""
        rows = [r for r in self.comments.values() if r["post_id"] == post_id]
        rows.sort(key=lambda r: (r["created_at"], r["id"]))
        return rows

    def drop_comments_on_post(self, post_id: int) -> None:
        """ON DELETE CASCADE, by hand. The real schema does this in Postgres;
        here it has to be remembered, which is exactly why there's a test for
        it on both sides."""
        for cid in [c["id"] for c in self.comments.values() if c["post_id"] == post_id]:
            del self.comments[cid]


ST = State()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # — plumbing ---------------------------------------------------------------
    def log_message(self, *args) -> None:  # keep the test console quiet
        pass

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header(
            "Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        )
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def _send(self, status: int, payload) -> None:
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        if body:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", 0) or 0)
        return self.rfile.read(n) if n else b""

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
        query = parse_qs(urlparse(self.path).query)

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

        m = re.match(r"^/users/([^/]+)/posts$", path)
        if m and method == "GET":
            return self._user_posts(m.group(1), query)
        m = re.match(r"^/users/([^/]+)$", path)
        if m and method == "GET":
            return self._profile(m.group(1))
        if path == "/login" and method == "POST":
            return self._login(self._form())
        if path == "/posts/" and method == "GET":
            return self._list_posts(query)
        if path == "/posts/" and method == "POST":
            return self._create_post(self._json())
        if path == "/vote/" and method == "POST":
            return self._vote(self._json())

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
        self._send(200, {"access_token": ST.issue_token(email), "token_type": "bearer"})

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
        if len(search) > 100:  # matches max_length on the real endpoint
            return self._send(
                422,
                {"detail": [{"loc": ["query", "search"], "msg": "too long",
                             "type": "value_error"}]},
            )
        viewer = ST.email_for(self._token())

        rows = [
            r
            for r in ST.posts.values()
            if search in r["title"]
            and self._may_see(r, viewer)
            and (only_author is None or r["author_email"] == only_author)
        ]
        rows.sort(
            key=lambda r: (r["created_at"], r["id"]), reverse=True
        )  # newest first
        total = len(rows)
        pages = (total + page_size - 1) // page_size if total else 0
        start = (page - 1) * page_size
        items = [ST.post_out(r) for r in rows[start : start + page_size]]
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

    def _get_post(self, pid: int) -> None:
        row = ST.posts.get(pid)
        if not row or not self._may_see(row, ST.email_for(self._token())):
            # Someone else's draft is 404, not 403 — a 403 would confirm it exists.
            return self._send(404, {"detail": f"Post with id: {pid} was not found"})
        self._send(200, ST.post_out(row))

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
        self._send(201, ST.post_out(row))

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
        self._send(200, ST.post_out(row))

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
        ST.drop_comments_on_post(pid)
        self._send(204, None)

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

        rows = ST.comments_on(pid)
        total = len(rows)
        pages = (total + page_size - 1) // page_size if total else 0
        start = (page - 1) * page_size
        self._send(
            200,
            {
                "items": [ST.comment_out(r) for r in rows[start : start + page_size]],
                "total": total,
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
        row = ST.add_comment(pid, email, content)
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
        del ST.comments[cid]
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
