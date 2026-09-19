"""Somebody addressed you.

The interesting half of a notification system is not that rows appear. It is
the four ways they appear when they shouldn't:

  · talking to yourself is not an event;
  · one comment must not produce two lines;
  · votes must not produce any, which is a design decision and not an oversight;
  · and a notification whose comment, actor or recipient has gone must go too,
    because a line saying "bea replied to you" pointing at nothing is worse
    than silence.

See app/models.py::Notification for the reasoning behind each.
"""

from datetime import datetime, timedelta, UTC

import pytest
from sqlalchemy import select

from backend.app import models
from backend.app.oauth2 import create_access_token


def as_user(client, user):
    """Speak as somebody else over the same client."""
    token = create_access_token({"user_id": user["id"]})
    return {"Authorization": f"Bearer {token}"}


def say(client, post_id, text, *, parent=None, headers=None):
    body = {"content": text}
    if parent is not None:
        body["parent_id"] = parent
    res = client.post(f"/posts/{post_id}/comments", json=body, headers=headers or {})
    assert res.status_code == 201, res.text
    return res.json()


def ids(test_posts):
    """The post ids, read while the objects are still attached.

    The `client` fixture's dependency override closes the session at the end of
    every request, which detaches everything it loaded — so `test_posts[0].id`
    works before the first call and raises after it. Reading them all up front
    is the difference between a test about notifications and a test about
    SQLAlchemy's identity map.
    """
    return [p.id for p in test_posts]


def mine(client):
    res = client.get("/notifications/")
    assert res.status_code == 200
    return res.json()


def unread_count(client) -> int:
    """The way the client actually asks: one row, and read the total."""
    res = client.get("/notifications/?unread=true&page_size=1")
    assert res.status_code == 200
    return res.json()["total"]


# ---------------------------------------------------------------------------
# what makes one
# ---------------------------------------------------------------------------
def test_a_comment_on_your_post_tells_you(authorized_client, test_user2, test_posts):
    """`authorized_client` is test_user, who owns the first three posts."""
    post = test_posts[0].id
    say(
        authorized_client,
        post,
        "I walked past it too",
        headers=as_user(authorized_client, test_user2),
    )

    page = mine(authorized_client)
    assert page["total"] == 1
    row = page["items"][0]
    assert row["kind"] == "comment"
    assert row["actor"]["username"] == test_user2["username"]
    assert row["post"]["id"] == post
    assert row["excerpt"] == "I walked past it too"
    assert row["read_at"] is None


def test_a_reply_tells_the_person_it_answers(
    authorized_client, test_user, test_user2, test_posts
):
    """The post belongs to test_user2, so the only person addressed here is the
    one being replied to — which is the distinction the two rules draw."""
    post = test_posts[3].id  # test_user2's
    opening = say(authorized_client, post, "The opening line")

    say(
        authorized_client,
        post,
        "Answering you",
        parent=opening["id"],
        headers=as_user(authorized_client, test_user2),
    )

    page = mine(authorized_client)
    assert page["total"] == 1
    assert page["items"][0]["kind"] == "reply"
    assert page["items"][0]["comment_id"] != opening["id"]


def test_talking_to_yourself_is_not_an_event(authorized_client, test_posts):
    post = test_posts[0].id  # your own
    opening = say(authorized_client, post, "A thought")
    say(authorized_client, post, "And another", parent=opening["id"])

    assert mine(authorized_client)["total"] == 0


def test_one_comment_makes_at_most_one(
    authorized_client, test_user, test_user2, test_posts, session
):
    """A reply on your own post notifies whoever was replied to, and not you as
    well. Everybody with a stake in a thread hearing about everything in it is
    how a notification list becomes a thing people turn off."""
    post = test_posts[0].id  # test_user's own post
    opening = say(
        authorized_client,
        post,
        "Said first",
        headers=as_user(authorized_client, test_user2),
    )
    # test_user now owns the post *and* is about to be replied to... no: the
    # opening comment is test_user2's, so replying to it addresses test_user2.
    say(authorized_client, post, "Answering that", parent=opening["id"])

    rows = session.scalars(select(models.Notification)).all()
    assert len(rows) == 2  # one for the comment, one for the reply
    assert {r.user_id for r in rows} == {test_user["id"], test_user2["id"]}
    # And each person heard about exactly one thing.
    assert len([r for r in rows if r.user_id == test_user["id"]]) == 1
    assert len([r for r in rows if r.user_id == test_user2["id"]]) == 1


def test_a_vote_makes_none(authorized_client, test_user2, test_posts, session):
    """Not an oversight. A vote is a number moving, and "three people upvoted
    you" is the mechanic this app's design deliberately refuses."""
    res = authorized_client.post(
        "/vote/",
        json={"post_id": test_posts[3].id, "dir": 1},
    )
    assert res.status_code == 201

    assert session.scalars(select(models.Notification)).all() == []


def test_a_failed_comment_leaves_no_notification(
    authorized_client, test_posts, session
):
    """The row is written in the same transaction as the comment it is about,
    so a comment that never happened cannot have told anybody about itself."""
    res = authorized_client.post(
        f"/posts/{test_posts[3].id}/comments", json={"content": "   "}
    )
    assert res.status_code == 422

    assert session.scalars(select(models.Notification)).all() == []


# ---------------------------------------------------------------------------
# reading them
# ---------------------------------------------------------------------------
def test_newest_first(authorized_client, test_user2, test_posts, session):
    post = ids(test_posts)[0]
    them = as_user(authorized_client, test_user2)
    say(authorized_client, post, "first", headers=them)
    say(authorized_client, post, "second", headers=them)
    say(authorized_client, post, "third", headers=them)
    # Fixture rows share one now(), so age them apart by hand.
    for offset, row in enumerate(session.scalars(select(models.Notification)).all()):
        row.created_at = datetime.now(UTC) - timedelta(minutes=10 - offset)
    session.commit()

    items = mine(authorized_client)["items"]
    assert [i["excerpt"] for i in items] == ["third", "second", "first"]


def test_a_long_comment_is_cut_on_a_word(authorized_client, test_user2, test_posts):
    words = " ".join(["something"] * 40)  # well past the 140-character cut
    say(
        authorized_client,
        test_posts[0].id,
        words,
        headers=as_user(authorized_client, test_user2),
    )

    excerpt = mine(authorized_client)["items"][0]["excerpt"]
    assert len(excerpt) <= 141  # the cut plus the ellipsis
    assert excerpt.endswith("…")
    # Cut between words, not through one.
    assert not excerpt[:-1].endswith("someth")


def test_you_only_ever_see_your_own(
    authorized_client, anonymous_client, test_user, test_user2, test_posts
):
    mine_id, theirs_id = ids(test_posts)[0], ids(test_posts)[3]
    say(
        authorized_client,
        mine_id,
        "for test_user",
        headers=as_user(authorized_client, test_user2),
    )
    say(authorized_client, theirs_id, "for test_user2")

    assert mine(authorized_client)["total"] == 1
    assert mine(authorized_client)["items"][0]["excerpt"] == "for test_user"

    theirs = anonymous_client.get(
        "/notifications/", headers=as_user(anonymous_client, test_user2)
    ).json()
    assert theirs["total"] == 1
    assert theirs["items"][0]["excerpt"] == "for test_user2"


def test_a_signed_out_caller_gets_nothing_at_all(client):
    assert client.get("/notifications/").status_code == 401
    assert client.post("/notifications/read").status_code == 401


# ---------------------------------------------------------------------------
# the count, and clearing it
# ---------------------------------------------------------------------------
def test_the_unread_count_is_the_envelopes_total(
    authorized_client, test_user2, test_posts
):
    """One row asked for, one number read off it — the same trick the "new
    posts" pill plays against /posts/?since=."""
    post = ids(test_posts)[0]
    them = as_user(authorized_client, test_user2)
    say(authorized_client, post, "one", headers=them)
    say(authorized_client, post, "two", headers=them)

    res = authorized_client.get("/notifications/?unread=true&page_size=1")
    body = res.json()
    assert body["total"] == 2
    assert len(body["items"]) == 1  # and it only carried one


def test_marking_them_read_clears_the_count(authorized_client, test_user2, test_posts):
    post = ids(test_posts)[0]
    them = as_user(authorized_client, test_user2)
    say(authorized_client, post, "one", headers=them)
    say(authorized_client, post, "two", headers=them)
    assert unread_count(authorized_client) == 2

    assert authorized_client.post("/notifications/read").status_code == 204

    assert unread_count(authorized_client) == 0
    # They are marked, not removed: the list is still there to read.
    page = mine(authorized_client)
    assert page["total"] == 2
    assert all(i["read_at"] is not None for i in page["items"])


def test_marking_read_does_not_touch_anybody_elses(
    authorized_client, anonymous_client, test_user, test_user2, test_posts
):
    mine_id, theirs_id = ids(test_posts)[0], ids(test_posts)[3]
    say(
        authorized_client,
        mine_id,
        "for test_user",
        headers=as_user(authorized_client, test_user2),
    )
    say(authorized_client, theirs_id, "for test_user2")

    authorized_client.post("/notifications/read")

    theirs = anonymous_client.get(
        "/notifications/?unread=true&page_size=1",
        headers=as_user(anonymous_client, test_user2),
    ).json()
    assert theirs["total"] == 1


def test_marking_read_with_nothing_to_mark_is_fine(authorized_client):
    assert authorized_client.post("/notifications/read").status_code == 204


def test_something_new_after_reading_counts_again(
    authorized_client, test_user2, test_posts
):
    post = ids(test_posts)[0]
    them = as_user(authorized_client, test_user2)
    say(authorized_client, post, "one", headers=them)
    authorized_client.post("/notifications/read")
    assert unread_count(authorized_client) == 0

    say(authorized_client, post, "two", headers=them)

    assert unread_count(authorized_client) == 1


# ---------------------------------------------------------------------------
# and when the thing it is about goes
# ---------------------------------------------------------------------------
def test_deleting_the_comment_takes_the_notification(
    authorized_client, test_user2, test_posts, session
):
    """A line saying somebody replied, pointing at a comment that no longer
    exists, is worse than silence."""
    them = as_user(authorized_client, test_user2)
    said = say(authorized_client, test_posts[0].id, "said in passing", headers=them)
    assert mine(authorized_client)["total"] == 1

    assert (
        authorized_client.delete(f"/comments/{said['id']}", headers=them).status_code
        == 204
    )

    session.expire_all()
    assert mine(authorized_client)["total"] == 0


def test_deleting_the_post_takes_them(
    authorized_client, test_user2, test_posts, session
):
    post = test_posts[0].id
    say(authorized_client, post, "said", headers=as_user(authorized_client, test_user2))
    assert mine(authorized_client)["total"] == 1

    assert authorized_client.delete(f"/posts/{post}").status_code == 204

    session.expire_all()
    assert mine(authorized_client)["total"] == 0


def test_the_actor_leaving_takes_them(
    authorized_client, anonymous_client, test_user2, test_posts, session
):
    """ "Somebody replied to you" about an account that no longer exists is a
    dead end wearing a name."""
    say(
        authorized_client,
        test_posts[0].id,
        "said",
        headers=as_user(authorized_client, test_user2),
    )
    assert mine(authorized_client)["total"] == 1

    assert (
        anonymous_client.delete(
            "/users/me", headers=as_user(anonymous_client, test_user2)
        ).status_code
        == 204
    )

    session.expire_all()
    assert mine(authorized_client)["total"] == 0


def test_the_recipient_leaving_takes_them(
    authorized_client, test_user, test_user2, test_posts, session
):
    say(
        authorized_client,
        test_posts[0].id,
        "said",
        headers=as_user(authorized_client, test_user2),
    )

    assert authorized_client.delete("/users/me").status_code == 204

    session.expire_all()
    assert session.scalars(select(models.Notification)).all() == []


# ---------------------------------------------------------------------------
# paging
# ---------------------------------------------------------------------------
def test_it_pages_like_everything_else(authorized_client, test_user2, test_posts):
    post = ids(test_posts)[0]
    them = as_user(authorized_client, test_user2)
    for i in range(5):
        say(authorized_client, post, f"number {i}", headers=them)

    res = authorized_client.get("/notifications/?page=2&page_size=2").json()

    assert res["total"] == 5
    assert res["pages"] == 3
    assert res["page"] == 2
    assert res["has_next"] is True
    assert res["has_prev"] is True
    assert len(res["items"]) == 2


@pytest.mark.parametrize("query", ["?page=0", "?page_size=0", "?page_size=51"])
def test_bad_paging_is_a_422(authorized_client, query):
    assert authorized_client.get(f"/notifications/{query}").status_code == 422
