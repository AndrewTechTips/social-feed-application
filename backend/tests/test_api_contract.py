"""The edges of the contract.

Not the happy paths — those are covered elsewhere — but the promises that are
easy to break without noticing: that pagination refuses nonsense rather than
quietly clamping it, that a write which gets rejected changes nothing, that
``updated_at`` means what it says, and that a token with the right signature
but the wrong contents is still not a way in.
"""

import time

import jwt
import pytest
from sqlalchemy import select

from backend.app import models
from backend.app.config import settings


def token_with(claims: dict) -> str:
    return jwt.encode(claims, settings.secret_key, settings.algorithm)


# ---------------------------------------------------------------------------
# Tokens that are signed correctly and still say nothing useful
# ---------------------------------------------------------------------------
def test_a_token_with_no_user_id_is_rejected(client, test_posts):
    """Correct key, unexpired, and no idea who it belongs to. verify_access_token
    checks for the claim rather than assuming a valid signature implies one."""
    useless = token_with({"exp": time.time() + 3600})
    client.headers = {**client.headers, "Authorization": f"Bearer {useless}"}
    assert (
        client.post("/posts/", json={"title": "x", "content": "y"}).status_code == 401
    )


def test_a_token_with_no_user_id_is_anonymous_on_a_public_route(client, test_posts):
    """The same token on the feed must not 401 — the feed is public, and a
    caller with an unusable token is simply not signed in."""
    useless = token_with({"exp": time.time() + 3600})
    client.headers = {**client.headers, "Authorization": f"Bearer {useless}"}
    res = client.get("/posts/")
    assert res.status_code == 200
    assert res.json()["total"] == len(test_posts)


def test_an_expired_token_is_anonymous_on_a_public_route(client, test_posts, test_user):
    """get_current_user_optional swallows the expiry rather than raising: a
    session that ran out while someone was reading should show them the public
    feed, not an error."""
    expired = token_with({"user_id": test_user["id"], "exp": time.time() - 1})
    client.headers = {**client.headers, "Authorization": f"Bearer {expired}"}
    assert client.get("/posts/").status_code == 200


def test_a_token_for_a_deleted_user_is_anonymous_on_a_public_route(
    client, test_posts, test_user, session
):
    live = token_with({"user_id": test_user["id"], "exp": time.time() + 3600})
    session.delete(session.get(models.User, test_user["id"]))
    session.commit()

    client.headers = {**client.headers, "Authorization": f"Bearer {live}"}
    res = client.get("/posts/")
    assert res.status_code == 200
    # Their posts went with them; what's left is everyone else's.
    assert all(item["user_id"] != test_user["id"] for item in res.json()["items"])


def test_no_authorization_header_at_all(client, test_posts):
    assert (
        client.post("/posts/", json={"title": "x", "content": "y"}).status_code == 401
    )


# ---------------------------------------------------------------------------
# Pagination refuses nonsense instead of clamping it
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("page_size", [0, -1, 101, 10_000])
def test_page_size_out_of_range_is_a_422(client, test_posts, page_size):
    """Clamping silently would mean a client asking for 10,000 rows gets 100
    and never learns it was refused."""
    res = client.get("/posts/", params={"page_size": page_size})
    assert res.status_code == 422


@pytest.mark.parametrize("page", [0, -1])
def test_page_below_one_is_a_422(client, test_posts, page):
    assert client.get("/posts/", params={"page": page}).status_code == 422


@pytest.mark.parametrize("value", ["abc", "1.5", ""])
def test_a_page_that_is_not_a_number_is_a_422(client, test_posts, value):
    assert client.get("/posts/", params={"page": value}).status_code == 422


def test_a_page_past_the_end_is_empty_rather_than_an_error(client, test_posts):
    """Asking for page 99 of a 4-post feed isn't a mistake worth refusing —
    it's just the far end of a list, and the envelope already says so."""
    body = client.get("/posts/", params={"page": 99}).json()
    assert body["items"] == []
    assert body["has_next"] is False
    assert body["has_prev"] is True
    assert body["total"] == len(test_posts)


@pytest.mark.parametrize("page_size", [0, 101])
def test_comment_pagination_has_the_same_bounds(client, test_posts, page_size):
    res = client.get(
        f"/posts/{test_posts[0].id}/comments", params={"page_size": page_size}
    )
    assert res.status_code == 422


@pytest.mark.parametrize("page_size", [0, 101])
def test_profile_pagination_has_the_same_bounds(client, test_user, page_size):
    res = client.get(
        f"/users/{test_user['username']}/posts", params={"page_size": page_size}
    )
    assert res.status_code == 422


# ---------------------------------------------------------------------------
# updated_at means what it says
# ---------------------------------------------------------------------------
def test_a_new_post_has_not_been_edited(client, authorized_client):
    body = authorized_client.post(
        "/posts/", json={"title": "Fresh", "content": "Just written."}
    ).json()
    # The UI reads exactly this to decide whether to draw the "edited" tag.
    assert body["created_at"] == body["updated_at"]


def test_patch_moves_updated_at_and_leaves_created_at_alone(
    authorized_client, test_posts
):
    post_id = test_posts[0].id
    before = authorized_client.get(f"/posts/{post_id}").json()

    time.sleep(0.01)  # the column has microsecond resolution; this is plenty
    after = authorized_client.patch(
        f"/posts/{post_id}", json={"title": "Second thoughts"}
    ).json()

    assert after["created_at"] == before["created_at"]
    assert after["updated_at"] > before["updated_at"]


def test_put_moves_updated_at_too(authorized_client, test_posts):
    post_id = test_posts[0].id
    before = authorized_client.get(f"/posts/{post_id}").json()

    time.sleep(0.01)
    after = authorized_client.put(
        f"/posts/{post_id}", json={"title": "Replaced", "content": "Entirely."}
    ).json()

    assert after["updated_at"] > before["updated_at"]


def test_reading_a_post_does_not_touch_updated_at(client, test_posts):
    first = client.get(f"/posts/{test_posts[0].id}").json()
    second = client.get(f"/posts/{test_posts[0].id}").json()
    assert first["updated_at"] == second["updated_at"]


# ---------------------------------------------------------------------------
# A rejected write changes nothing
# ---------------------------------------------------------------------------
def test_a_403_patch_leaves_the_row_exactly_as_it_was(
    authorized_client, test_posts, session
):
    """test_posts[3] belongs to the other user. The 403 is the visible half;
    this is the half that matters — the attempt must not have landed."""
    victim = test_posts[3]
    post_id, before_title, before_updated = victim.id, victim.title, victim.updated_at

    res = authorized_client.patch(
        f"/posts/{post_id}", json={"title": "Vandalised", "published": False}
    )
    assert res.status_code == 403

    session.expire_all()
    row = session.scalar(select(models.Post).where(models.Post.id == post_id))
    assert row.title == before_title
    assert row.published is True
    assert row.updated_at == before_updated


def test_a_403_delete_leaves_the_row_where_it_was(
    authorized_client, test_posts, session
):
    post_id = test_posts[3].id
    assert authorized_client.delete(f"/posts/{post_id}").status_code == 403

    session.expire_all()
    assert (
        session.scalar(select(models.Post).where(models.Post.id == post_id)) is not None
    )


def test_a_422_create_writes_nothing(authorized_client, session):
    before = session.scalar(select(models.Post.id).order_by(models.Post.id.desc()))

    res = authorized_client.post("/posts/", json={"title": "no content field"})
    assert res.status_code == 422

    session.expire_all()
    after = session.scalar(select(models.Post.id).order_by(models.Post.id.desc()))
    assert after == before


def test_an_empty_patch_leaves_the_row_alone(authorized_client, test_posts, session):
    """A PATCH with nothing in it is a 400, and 400 has to mean nothing
    happened — including updated_at, which an unconditional commit would have
    moved."""
    post = test_posts[0]
    post_id, before_updated = post.id, post.updated_at

    assert authorized_client.patch(f"/posts/{post_id}", json={}).status_code == 400

    session.expire_all()
    row = session.scalar(select(models.Post).where(models.Post.id == post_id))
    assert row.updated_at == before_updated


def test_a_rejected_comment_writes_nothing(authorized_client, test_posts, session):
    before = session.scalar(
        select(models.Comment.id).order_by(models.Comment.id.desc())
    )

    res = authorized_client.post(
        f"/posts/{test_posts[0].id}/comments", json={"content": "   "}
    )
    assert res.status_code == 422

    session.expire_all()
    after = session.scalar(select(models.Comment.id).order_by(models.Comment.id.desc()))
    assert after == before
