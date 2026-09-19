"""Your account: changing the name on it, signing out everywhere, deleting it.

Three operations that are easy to write and easy to get subtly wrong, and the
subtle wrongness is the same in all three: something that should have moved
with you didn't. A rename that orphans your posts. A "sign out everywhere" that
signs out one browser. A delete that leaves your comments sitting under
somebody else's post with a dangling author.

So most of what's below is not about the response code. It's about what is
still true afterwards.
"""

import pytest
from sqlalchemy import select

from backend.app import models
from backend.app.oauth2 import CSRF_HEADER, REFRESH_COOKIE, create_access_token


def sign_in(client, user) -> dict:
    res = client.post(
        "/login", data={"username": user["email"], "password": user["password"]}
    )
    assert res.status_code == 200
    return res.json()


def cleared_cookie(res) -> bool:
    """Whether this response tells the browser to drop the refresh cookie.

    Checking the raw header rather than `res.cookies`: an expiry is a Set-Cookie
    with an empty value and a date in the past, and httpx parses that into an
    absence, which is indistinguishable from never having sent one.
    """
    for key, value in res.headers.raw:
        line = value.decode()
        if key.decode().lower() == "set-cookie" and line.startswith(REFRESH_COOKIE):
            return "Max-Age=0" in line or "expires=Thu, 01 Jan 1970" in line
    return False


# ---------------------------------------------------------------------------
# PATCH /users/me — the public half of an identity
# ---------------------------------------------------------------------------
def test_you_can_change_the_name_everybody_else_sees(authorized_client, test_user):
    res = authorized_client.patch("/users/me", json={"username": "ada"})

    assert res.status_code == 200
    body = res.json()
    assert body["username"] == "ada"
    # Same person, same account: only the label moved.
    assert body["id"] == test_user["id"]
    assert body["email"] == test_user["email"]


def test_the_new_name_is_the_one_the_rest_of_the_api_answers_to(
    authorized_client, test_user, test_posts
):
    authorized_client.patch("/users/me", json={"username": "ada"})

    # The profile is reachable at the new name...
    assert authorized_client.get("/users/ada").status_code == 200
    # ...and not at the old one, which is now free.
    assert authorized_client.get(f"/users/{test_user['username']}").status_code == 404


def test_a_rename_does_not_lose_your_posts(authorized_client, test_user, test_posts):
    """The point of joining on an id.

    Posts, comments and votes all point at `users.id`, which a rename does not
    touch. If any of them had been keyed by name instead, this is the test that
    would find out — the count would come back short, or the profile would 404.
    """
    before = authorized_client.get(f"/users/{test_user['username']}/posts").json()
    assert before["total"] == 3

    authorized_client.patch("/users/me", json={"username": "ada"})

    after = authorized_client.get("/users/ada/posts").json()
    assert after["total"] == before["total"]
    assert [p["id"] for p in after["items"]] == [p["id"] for p in before["items"]]
    # And the author printed on each one has moved with it, rather than each
    # post carrying a stale copy of the name it was written under.
    assert {p["user"]["username"] for p in after["items"]} == {"ada"}


def test_a_name_somebody_else_has_is_a_409(authorized_client, test_user2):
    res = authorized_client.patch(
        "/users/me", json={"username": test_user2["username"]}
    )

    assert res.status_code == 409
    assert "taken" in res.json()["detail"]


def test_keeping_your_own_name_is_not_a_collision(authorized_client, test_user):
    """Submitting the settings form without changing anything is the commonest
    thing a settings form has done to it, and it must not be an error — least
    of all "that username is taken", by you, from you."""
    res = authorized_client.patch("/users/me", json={"username": test_user["username"]})

    assert res.status_code == 200
    assert res.json()["username"] == test_user["username"]


def test_capitalising_your_own_name_is_also_not_a_collision(
    authorized_client, test_user
):
    """Names are folded before they are compared, so ANDREW is andrew — which
    means this takes the same early exit rather than trying to insert a
    duplicate and being told no."""
    res = authorized_client.patch(
        "/users/me", json={"username": test_user["username"].upper()}
    )

    assert res.status_code == 200
    assert res.json()["username"] == test_user["username"]


@pytest.mark.parametrize(
    "name",
    [
        "no",  # too short
        "9lives",  # starts with a digit, so it could be read as an id
        "has spaces",
        "Ünicode",
        "me",  # reserved: the API needs it for itself
        "admin",
        "a" * 21,  # too long
        "",
    ],
)
def test_a_name_that_breaks_the_rules_is_a_422(authorized_client, name):
    """The same rules registering applies, because it is literally the same
    function — see schemas.usable_username."""
    assert (
        authorized_client.patch("/users/me", json={"username": name}).status_code == 422
    )


def test_you_cannot_rename_anybody_but_yourself(client, test_user):
    """There is no route that takes a username, which is the design. This just
    pins down that a signed-out caller cannot rename the account either."""
    assert client.patch("/users/me", json={"username": "ada"}).status_code == 401


def test_a_rename_leaves_you_signed_in(authorized_client):
    """The access token names a user id, not a username, so it survives. If it
    hadn't, the settings screen would sign you out for using it."""
    authorized_client.patch("/users/me", json={"username": "ada"})

    me = authorized_client.get("/users/me")
    assert me.status_code == 200
    assert me.json()["username"] == "ada"


# ---------------------------------------------------------------------------
# POST /auth/logout-all — the reason the sessions are in a table
# ---------------------------------------------------------------------------
def test_signing_out_everywhere_ends_every_session(client, test_user, session):
    """Three sign-ins, three rows, one request, none left.

    Each TestClient has its own cookie jar, which is as close as this gets to
    three machines: three separate refresh families for one account.
    """
    from fastapi.testclient import TestClient
    from backend.app.config import API_PREFIX
    from backend.app.main import app

    # Based at the prefix, like the conftest's client — these stand in for two
    # more machines, and a machine that talked to the unprefixed paths would be
    # talking to nothing.
    base = f"http://testserver{API_PREFIX}"
    others = [TestClient(app, base_url=base), TestClient(app, base_url=base)]
    sign_in(client, test_user)
    for other in others:
        sign_in(other, test_user)

    live = select(models.RefreshSession).where(
        models.RefreshSession.user_id == test_user["id"],
        models.RefreshSession.revoked_at.is_(None),
    )
    assert len(session.scalars(live).all()) == 3

    token = create_access_token({"user_id": test_user["id"]})
    res = client.post("/auth/logout-all", headers={"Authorization": f"Bearer {token}"})

    assert res.status_code == 204
    session.expire_all()
    assert session.scalars(live).all() == []


def test_a_session_signed_out_everywhere_cannot_refresh(client, test_user):
    """Revoked, not deleted — so the cookie still names a row, and the row says
    the session is over. The observable effect is the one that matters: the
    other browser is signed out the next time it tries to stay signed in."""
    body = sign_in(client, test_user)
    token = create_access_token({"user_id": test_user["id"]})
    # Keep a copy. The route clears the cookie as well as revoking the session,
    # and without putting it back this would be a test of the clearing: a
    # refresh with no cookie is a 401 whether or not anything was revoked. The
    # browser being asked about here is a *different* one, which never saw the
    # Set-Cookie and is still holding a cookie that looks perfectly good.
    held = client.cookies.get(REFRESH_COOKIE)
    assert held

    client.post("/auth/logout-all", headers={"Authorization": f"Bearer {token}"})

    client.cookies.set(REFRESH_COOKIE, held)
    res = client.post("/auth/refresh", headers={CSRF_HEADER: body["csrf_token"]})
    assert res.status_code == 401


def test_signing_out_everywhere_clears_the_cookie_here_too(client, test_user):
    sign_in(client, test_user)
    token = create_access_token({"user_id": test_user["id"]})

    res = client.post("/auth/logout-all", headers={"Authorization": f"Bearer {token}"})

    assert cleared_cookie(res)


def test_signing_out_everywhere_needs_the_access_token_not_the_cookie(
    client, test_user
):
    """The difference between this and /logout, and the whole reason it is a
    separate route. Holding the cookie is enough to end the session the cookie
    belongs to; ending everybody else's takes proof you are the person, which
    a browser that merely still has a cookie does not have.
    """
    sign_in(client, test_user)  # the client is holding a valid refresh cookie

    assert client.post("/auth/logout-all").status_code == 401


def test_it_does_not_touch_anybody_elses_sessions(
    client, test_user, test_user2, session
):
    other = client.post(
        "/login",
        data={"username": test_user2["email"], "password": test_user2["password"]},
    )
    assert other.status_code == 200

    token = create_access_token({"user_id": test_user["id"]})
    client.post("/auth/logout-all", headers={"Authorization": f"Bearer {token}"})

    session.expire_all()
    theirs = session.scalars(
        select(models.RefreshSession).where(
            models.RefreshSession.user_id == test_user2["id"],
            models.RefreshSession.revoked_at.is_(None),
        )
    ).all()
    assert len(theirs) == 1


def test_signing_out_everywhere_with_nothing_open_is_still_fine(
    authorized_client, test_user
):
    """Nobody has signed in on this account in this test. Asking to leave a
    room you are not in is not an error."""
    assert authorized_client.post("/auth/logout-all").status_code == 204


# ---------------------------------------------------------------------------
# DELETE /users/me — and the cascades that make it honest
# ---------------------------------------------------------------------------
def test_deleting_your_account_takes_your_posts_with_it(
    authorized_client, test_user, test_posts, session
):
    mine = [p for p in test_posts if p.user_id == test_user["id"]]
    assert len(mine) == 3

    res = authorized_client.delete("/users/me")

    assert res.status_code == 204
    session.expire_all()
    assert session.get(models.User, test_user["id"]) is None
    left = session.scalars(
        select(models.Post).where(models.Post.user_id == test_user["id"])
    ).all()
    assert left == []


def test_it_takes_the_comments_you_left_under_other_peoples_posts(
    authorized_client, test_user, test_posts, session
):
    """The cascade that is easiest to forget, because it points away from you:
    the comment belongs to somebody else's post and to you, and it is your
    leaving that has to remove it."""
    # Read the id now. The dependency override closes this session at the end
    # of every request, which detaches every object it loaded — so an attribute
    # touched after the first call raises rather than answering.
    theirs = next(p.id for p in test_posts if p.user_id != test_user["id"])
    res = authorized_client.post(
        f"/posts/{theirs}/comments", json={"content": "said in passing"}
    )
    assert res.status_code == 201

    authorized_client.delete("/users/me")

    session.expire_all()
    assert session.scalars(select(models.Comment)).all() == []
    # The post it was left under is somebody else's and stays exactly where it was.
    assert session.get(models.Post, theirs) is not None


def test_it_takes_your_votes_and_the_counts_go_down(
    authorized_client, test_user, test_posts, session
):
    theirs = next(p.id for p in test_posts if p.user_id != test_user["id"])
    cast = authorized_client.post("/vote/", json={"post_id": theirs, "dir": 1})
    assert cast.status_code == 201
    assert authorized_client.get(f"/posts/{theirs}").json()["votes"] == 1

    authorized_client.delete("/users/me")

    session.expire_all()
    assert session.scalars(select(models.Vote)).all() == []


def test_it_takes_the_replies_to_your_comments(
    authorized_client, test_user, test_user2, test_posts, session
):
    """Two cascades chained. The reply is somebody else's comment; it is
    attached to yours, and yours is attached to you. Deleting the account has
    to walk all the way down or the reply is left pointing at nothing.
    """
    post = test_posts[0].id
    top = authorized_client.post(
        f"/posts/{post}/comments", json={"content": "the opening line"}
    ).json()

    them = create_access_token({"user_id": test_user2["id"]})
    reply = authorized_client.post(
        f"/posts/{post}/comments",
        json={"content": "answering you", "parent_id": top["id"]},
        headers={"Authorization": f"Bearer {them}"},
    )
    assert reply.status_code == 201

    authorized_client.delete("/users/me")

    session.expire_all()
    assert session.scalars(select(models.Comment)).all() == []


def test_it_ends_every_session_you_had(authorized_client, test_user, session):
    sign_in(authorized_client, test_user)
    assert session.scalars(select(models.RefreshSession)).all() != []

    authorized_client.delete("/users/me")

    session.expire_all()
    assert session.scalars(select(models.RefreshSession)).all() == []


def test_deleting_clears_the_refresh_cookie(authorized_client, test_user):
    sign_in(authorized_client, test_user)

    assert cleared_cookie(authorized_client.delete("/users/me"))


def test_the_name_is_free_afterwards(authorized_client, test_user, client):
    authorized_client.delete("/users/me")

    res = client.post(
        "/users/",
        json={
            "username": test_user["username"],
            # Not a .test address: email-validator refuses the special-use
            # TLDs outright, so a 422 here would be about the address rather
            # than about the name being free.
            "email": "somebody-else@example.org",
            "password": "password1234",
        },
    )
    assert res.status_code == 201


def test_a_signed_out_caller_cannot_delete_an_account(client):
    assert client.delete("/users/me").status_code == 401


def test_the_token_stops_working_once_the_account_is_gone(authorized_client):
    """Not because anything revoked it — an access token is stateless and
    cannot be — but because resolving the id in it now finds nobody."""
    authorized_client.delete("/users/me")

    assert authorized_client.get("/users/me").status_code == 401
