"""Login's failure paths.

Two things are being pinned down here: that a wrong email and a wrong password
are indistinguishable to a caller, and that the vote endpoint survives two
requests racing each other.
"""

import time

import pytest

from backend.app import models, utils


# ---------------------------------------------------------------------------
# Login must not reveal which emails have accounts
# ---------------------------------------------------------------------------
def test_unknown_email_and_wrong_password_look_identical(client, test_user):
    unknown = client.post(
        "/login", data={"username": "nobody@example.com", "password": "password1234"}
    )
    wrong = client.post(
        "/login", data={"username": test_user["email"], "password": "not-the-password"}
    )

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()


def test_unknown_email_still_pays_for_a_bcrypt_verification(
    client, test_user, monkeypatch
):
    """The fix is a dummy hash comparison on the miss path. Asserting on wall
    clock here would be flaky on a loaded CI box, so assert on the thing that
    actually costs the time: that bcrypt gets called either way."""
    calls = []

    real_checkpw = utils.bcrypt.checkpw

    def counting_checkpw(*args, **kwargs):
        calls.append(1)
        return real_checkpw(*args, **kwargs)

    monkeypatch.setattr(utils.bcrypt, "checkpw", counting_checkpw)

    client.post(
        "/login", data={"username": "nobody@example.com", "password": "password1234"}
    )
    assert len(calls) == 1, "no bcrypt work on the unknown-email path: timing oracle"

    calls.clear()
    client.post(
        "/login", data={"username": test_user["email"], "password": "wrong-password"}
    )
    assert len(calls) == 1


def test_the_placeholder_password_is_not_a_way_in(client, test_user):
    """The miss path verifies against a fixed hash. Nothing about that should
    make the value it hashes usable as a credential."""
    assert utils.verify_password_dummy() is None

    res = client.post(
        "/login",
        data={"username": test_user["email"], "password": "not-a-real-password"},
    )
    assert res.status_code == 401


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "header",
    [
        "Bearer not-a-jwt",
        "Bearer ",
        "Basic abc123",
        "token-with-no-scheme",
    ],
)
def test_unusable_authorization_headers_are_rejected(client, test_posts, header):
    client.headers = {**client.headers, "Authorization": header}
    res = client.post("/posts/", json={"title": "x", "content": "y"})
    assert res.status_code == 401


def test_a_token_signed_with_another_key_is_rejected(client):
    import jwt

    # 32+ bytes: PyJWT warns below that, and pytest.ini turns warnings into
    # errors — so a short key here would fail the test for the wrong reason.
    other_key = "b" * 64
    forged = jwt.encode({"user_id": 1, "exp": time.time() + 3600}, other_key, "HS256")
    client.headers = {**client.headers, "Authorization": f"Bearer {forged}"}
    res = client.post("/posts/", json={"title": "x", "content": "y"})
    assert res.status_code == 401


def test_an_expired_token_is_rejected(client, test_user):
    import jwt

    from backend.app import settings

    expired = jwt.encode(
        {"user_id": test_user["id"], "exp": time.time() - 1},
        settings.secret_key,
        settings.algorithm,
    )
    client.headers = {**client.headers, "Authorization": f"Bearer {expired}"}
    res = client.post("/posts/", json={"title": "x", "content": "y"})
    assert res.status_code == 401


def test_a_token_for_a_deleted_user_is_rejected(authorized_client, test_user, session):
    session.delete(session.get(models.User, test_user["id"]))
    session.commit()

    res = authorized_client.post("/posts/", json={"title": "x", "content": "y"})
    assert res.status_code == 401


# ---------------------------------------------------------------------------
# The vote race
# ---------------------------------------------------------------------------
def test_a_duplicate_vote_that_slips_past_the_check_is_still_a_409(
    authorized_client, test_posts, test_user, session, monkeypatch
):
    """Two concurrent upvotes can both find no existing vote and both try to
    insert. The composite primary key stops the second one; this asserts the
    caller gets the same 409 as a plain duplicate rather than a 500.

    Rather than actually racing two threads (flaky), this simulates the losing
    request: the row appears *after* the endpoint has looked and found nothing.
    """
    from backend.app.routers import vote as vote_router

    post_id = test_posts[3].id
    real_scalar = vote_router.Session.scalar

    def scalar_then_insert_behind_our_back(self, statement, *args, **kwargs):
        result = real_scalar(self, statement, *args, **kwargs)
        # Only interfere with the "have they already voted?" lookup, and only once.
        if result is None and "votes" in str(statement) and not state["raced"]:
            state["raced"] = True
            session.add(models.Vote(post_id=post_id, user_id=test_user["id"]))
            session.commit()
        return result

    state = {"raced": False}
    monkeypatch.setattr(
        vote_router.Session, "scalar", scalar_then_insert_behind_our_back
    )

    res = authorized_client.post("/vote/", json={"post_id": post_id, "dir": 1})
    assert state["raced"], "the race was never triggered — test no longer valid"
    assert res.status_code == 409
