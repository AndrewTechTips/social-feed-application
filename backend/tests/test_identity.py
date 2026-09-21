"""Usernames, profiles, and knowing who you are.

The rule underneath all of it: the username is what everyone can see, the email
is a credential and stays with the account it belongs to. Before this, a post
carried its author's address and GET /users/{id} handed out the rest to anyone
who could count.
"""

import os
import pathlib
import re

import pytest

from backend.app import schemas


def signup(client, username, email="someone@example.com", password="password1234"):
    return client.post(
        "/users/",
        json={"username": username, "email": email, "password": password},
    )


# ---------------------------------------------------------------------------
# The rule
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "username, ok",
    [
        ("maren", True),
        ("ada", True),  # exactly three
        ("a" * 20, True),  # exactly twenty
        ("has_underscore", True),
        ("has-hyphen", True),
        ("mixOfCase", True),  # accepted, folded to lower case
        ("ab", False),  # too short
        ("a" * 21, False),  # too long
        ("1abc", False),  # starts with a digit
        ("_abc", False),  # starts with punctuation
        ("has space", False),
        ("has.dot", False),
        ("zoë", False),  # letters outside a-z
        ("", False),
        ("me", False),  # reserved: it would shadow /users/me
        ("admin", False),
    ],
)
def test_username_rules(client, username, ok):
    res = signup(client, username, email=f"{abs(hash(username))}@example.com")
    assert res.status_code == (201 if ok else 422), res.json()


def test_a_username_is_stored_folded(client):
    res = signup(client, "MixOfCase", email="folded@example.com")
    assert res.status_code == 201
    assert res.json()["username"] == "mixofcase"


def test_usernames_are_case_insensitively_unique(client):
    assert signup(client, "maren", email="one@example.com").status_code == 201
    # Same name in different clothes is the same name.
    clash = signup(client, "MAREN", email="two@example.com")
    assert clash.status_code == 409
    assert "username" in clash.json()["detail"].lower()


def test_username_and_email_collide_separately(client, test_user):
    """Being told "that didn't work" when only one field is the problem is a
    miserable way to fill in a form."""
    same_name = signup(client, test_user["username"], email="brand-new@example.com")
    assert same_name.status_code == 409
    assert "username" in same_name.json()["detail"].lower()

    same_email = signup(client, "brandnewname", email=test_user["email"])
    assert same_email.status_code == 409
    assert "email" in same_email.json()["detail"].lower()


# ---------------------------------------------------------------------------
# The email stops leaving the account it belongs to
# ---------------------------------------------------------------------------
def test_a_post_names_its_author_without_an_address(client, test_posts):
    body = client.get("/posts/").json()
    for item in body["items"]:
        assert item["user"]["username"]
        assert "email" not in item["user"]


def test_a_profile_is_public_and_addressless(client, test_user):
    res = client.get(f"/users/{test_user['username']}")
    assert res.status_code == 200

    user = schemas.UserOut(**res.json())
    assert user.username == test_user["username"]
    assert "email" not in res.json()


def test_profiles_are_found_case_insensitively(client, test_user):
    assert client.get(f"/users/{test_user['username'].upper()}").status_code == 200


def test_an_unknown_name_is_a_404(client):
    assert client.get("/users/nobodyhere").status_code == 404


# ---------------------------------------------------------------------------
# Who am I? — the thing a token alone doesn't tell you
# ---------------------------------------------------------------------------
def test_me_tells_a_signed_in_caller_who_they_are(authorized_client, test_user):
    res = authorized_client.get("/users/me")
    assert res.status_code == 200

    me = schemas.MeOut(**res.json())
    assert me.id == test_user["id"]
    assert me.username == test_user["username"]
    # Your own address, on the one endpoint where the caller owns it.
    assert me.email == test_user["email"]


def test_me_needs_a_token(client):
    assert client.get("/users/me").status_code == 401


def test_me_is_not_a_username(client, test_user):
    """'me' can't be registered, so it can never be a person's profile — the
    route would shadow it either way, and relying on route order alone is one
    reshuffle away from a bug."""
    assert signup(client, "me", email="me@example.com").status_code == 422


# ---------------------------------------------------------------------------
# Everything by one person
# ---------------------------------------------------------------------------
def test_a_profile_lists_only_that_persons_posts(client, test_posts, test_user):
    res = client.get(f"/users/{test_user['username']}/posts")
    assert res.status_code == 200

    page = schemas.PostPage.model_validate(res.json())
    mine = [p for p in test_posts if p.user_id == test_user["id"]]
    assert page.total == len(mine)
    assert {p.id for p in page.items} == {p.id for p in mine}
    assert all(p.user.username == test_user["username"] for p in page.items)


def test_a_profile_page_paginates_like_the_feed(client, test_posts, test_user):
    first = client.get(
        f"/users/{test_user['username']}/posts", params={"page": 1, "page_size": 2}
    ).json()
    assert len(first["items"]) == 2
    assert first["pages"] == 2
    assert first["has_next"] is True
    assert first["has_prev"] is False

    second = client.get(
        f"/users/{test_user['username']}/posts", params={"page": 2, "page_size": 2}
    ).json()
    assert second["has_next"] is False
    assert {i["id"] for i in first["items"]}.isdisjoint(
        i["id"] for i in second["items"]
    )


def test_a_profile_hides_that_persons_drafts_from_everyone_else(
    anonymous_client, authorized_client, test_user, own_draft
):
    """Same rule as the feed: an unpublished post belongs to its author.

    anonymous_client rather than client, because authorized_client signs the
    latter in by mutating it — see the note on the fixture."""
    anonymous = anonymous_client.get(f"/users/{test_user['username']}/posts").json()
    assert own_draft.id not in {i["id"] for i in anonymous["items"]}

    author = authorized_client.get(f"/users/{test_user['username']}/posts").json()
    assert own_draft.id in {i["id"] for i in author["items"]}


def test_posts_for_an_unknown_name_is_a_404(client):
    assert client.get("/users/nobodyhere/posts").status_code == 404


# ---------------------------------------------------------------------------
# The backfill that gave the existing rows a name
# ---------------------------------------------------------------------------
# Exercised against a real database rather than by importing the migration and
# poking at its helper: what needed proving is that the thing survives contact
# with a table that already has people in it, and that only the migration
# itself can show. (It can't be imported here anyway — backend/alembic/ shadows
# the installed alembic package once pytest puts backend/ on sys.path.)
def test_the_backfill_copes_with_a_table_that_already_has_people_in_it():
    import subprocess
    import sys

    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    from backend.app.config import settings

    BEFORE = "889ce0d369d6"  # the revision that adds the feed indexes
    DB = f"{settings.database_name}_backfill"
    ROOT = pathlib.Path(__file__).resolve().parents[2]

    def connect(dbname):
        return psycopg2.connect(
            host=settings.database_hostname,
            port=settings.database_port,
            user=settings.database_username,
            password=settings.database_password,
            dbname=dbname,
        )

    def alembic(target):
        env = {**os.environ, "DATABASE_NAME": DB}
        done = subprocess.run(
            # `sys.executable -m alembic`, not the bare `alembic` script.
            #
            # The script is only on PATH when the virtualenv has been
            # activated, so `python -m pytest` from an unactivated checkout —
            # which is how this is usually run by hand — failed here with
            # FileNotFoundError and nothing to do with the migration. Going
            # through the interpreter already running the test uses the same
            # environment the test was collected in, activated or not.
            #
            # The shadowing noted above does not reach this: it happens
            # because pytest puts `backend/` on sys.path, and this subprocess
            # starts from ROOT, where `alembic` is the installed package and
            # `backend.alembic` is the migrations directory.
            [
                sys.executable,
                "-m",
                "alembic",
                "-c",
                "backend/alembic.ini",
                "upgrade",
                target,
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        assert done.returncode == 0, done.stderr
        return done

    admin = connect("postgres")
    admin.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with admin.cursor() as cur:
        cur.execute(f'DROP DATABASE IF EXISTS "{DB}"')
        cur.execute(f'CREATE DATABASE "{DB}"')

    try:
        alembic(BEFORE)

        # Four addresses, three of which want to be called "alex", and one that
        # wants the name the API reserves for itself.
        people = [
            "alex@one.com",
            "Alex@two.com",
            "alex@three.com",
            "me@somewhere.com",
            "123@digits.com",  # nothing usable once the digits are stripped
            "ab@short.com",  # too short to be a username on its own
        ]
        con = connect(DB)
        with con, con.cursor() as cur:
            for email in people:
                cur.execute(
                    "INSERT INTO users (email, password) VALUES (%s, 'x')", (email,)
                )
        con.close()

        alembic("head")  # the migration under test

        con = connect(DB)
        with con, con.cursor() as cur:
            cur.execute("SELECT email, username FROM users ORDER BY id")
            rows = cur.fetchall()
        con.close()

        names = [username for _email, username in rows]
        assert len(set(names)) == len(names), f"duplicate usernames: {names}"
        assert None not in names

        legal = re.compile(r"^[a-z][a-z0-9_-]{2,19}$")
        for name in names:
            assert legal.match(name), f"{name!r} is not a legal username"

        by_email = dict(rows)
        assert by_email["alex@one.com"] == "alex"
        assert by_email["Alex@two.com"].startswith("alex")
        assert by_email["alex@three.com"].startswith("alex")
        # "me" is reserved — it would shadow GET /users/me
        assert by_email["me@somewhere.com"] != "me"
    finally:
        admin = connect("postgres")
        admin.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{DB}"')
        admin.close()
