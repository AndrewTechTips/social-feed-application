"""Comments: writing them, reading them, deleting them, and what happens to
them when the thing they hang off goes away.

Three rules are worth stating up front, because most of what's below is one of
them being checked from a different angle:

  · anyone signed in may comment on any post they can see;
  · a comment belongs to whoever wrote it, and to nobody else — not even the
    author of the post it's on;
  · a post you can't see has no comments as far as you're concerned, and that
    includes not being able to add one.
"""

from datetime import datetime, timedelta, UTC

import pytest
from sqlalchemy import select

from backend.app import models, schemas


@pytest.fixture
def commented_post(test_posts, test_user, test_user2, session):
    """A published post belonging to `test_user`, with three comments on it
    written a minute apart so the order they come back in is a real assertion
    rather than an accident of how fast the inserts ran.

    Returned as plain dicts, not ORM rows: the `client` fixture closes the
    session at the end of every request, and anything still holding a mapped
    instance afterwards gets a DetachedInstanceError the moment it reads an
    attribute.
    """
    post_id = test_posts[0].id
    start = datetime.now(UTC) - timedelta(hours=1)
    rows = [
        models.Comment(
            post_id=post_id,
            user_id=author_id,
            content=content,
            created_at=start + timedelta(minutes=i),
        )
        for i, (author_id, content) in enumerate(
            [
                (test_user2["id"], "First, and a bit early."),
                (test_user["id"], "Replying to my own post, as one does."),
                (test_user2["id"], "Last word."),
            ]
        )
    ]
    session.add_all(rows)
    session.commit()
    said = [{"id": r.id, "user_id": r.user_id, "content": r.content} for r in rows]
    return post_id, said


# ---------------------------------------------------------------------------
# Writing one
# ---------------------------------------------------------------------------
def test_comment_on_your_own_post(authorized_client, test_posts, test_user):
    post_id = test_posts[0].id
    res = authorized_client.post(
        f"/posts/{post_id}/comments", json={"content": "Adding a footnote."}
    )
    assert res.status_code == 201

    comment = schemas.CommentOut(**res.json())
    assert comment.content == "Adding a footnote."
    assert comment.post_id == post_id
    assert comment.user_id == test_user["id"]
    assert comment.user.username == test_user["username"]


def test_comment_on_someone_elses_post(authorized_client, test_posts, test_user):
    """The interesting half: commenting is not an ownership-checked action.
    test_posts[3] belongs to the *other* user."""
    res = authorized_client.post(
        f"/posts/{test_posts[3].id}/comments", json={"content": "Nice one."}
    )
    assert res.status_code == 201
    assert res.json()["user_id"] == test_user["id"]


def test_a_comment_carries_its_author_but_never_their_email(
    authorized_client, test_posts
):
    res = authorized_client.post(
        f"/posts/{test_posts[0].id}/comments", json={"content": "Hello."}
    )
    assert "email" not in res.json()["user"]


def test_anonymous_cannot_comment(client, test_posts):
    res = client.post(f"/posts/{test_posts[0].id}/comments", json={"content": "Hi"})
    assert res.status_code == 401


def test_cannot_comment_on_a_post_that_does_not_exist(authorized_client):
    res = authorized_client.post("/posts/88888/comments", json={"content": "Hi"})
    assert res.status_code == 404


@pytest.mark.parametrize("content", ["", "   ", "\n\t "])
def test_a_comment_needs_something_in_it(authorized_client, test_posts, content):
    res = authorized_client.post(
        f"/posts/{test_posts[0].id}/comments", json={"content": content}
    )
    assert res.status_code == 422


def test_a_comment_has_a_ceiling(authorized_client, test_posts):
    res = authorized_client.post(
        f"/posts/{test_posts[0].id}/comments",
        json={"content": "x" * (schemas.COMMENT_MAX + 1)},
    )
    assert res.status_code == 422

    ok = authorized_client.post(
        f"/posts/{test_posts[0].id}/comments",
        json={"content": "x" * schemas.COMMENT_MAX},
    )
    assert ok.status_code == 201


def test_surrounding_whitespace_is_trimmed(authorized_client, test_posts):
    res = authorized_client.post(
        f"/posts/{test_posts[0].id}/comments", json={"content": "  padded  \n"}
    )
    assert res.json()["content"] == "padded"


# ---------------------------------------------------------------------------
# Reading them
# ---------------------------------------------------------------------------
def test_anyone_can_read_the_comments_on_a_published_post(client, commented_post):
    post_id, said = commented_post
    res = client.get(f"/posts/{post_id}/comments")
    assert res.status_code == 200

    page = schemas.CommentPage.model_validate(res.json())
    assert page.total == len(said)
    assert [c.id for c in page.items] == [r["id"] for r in said]  # oldest first


def test_comments_are_scoped_to_their_post(
    authorized_client, commented_post, test_posts
):
    other = test_posts[1].id
    authorized_client.post(f"/posts/{other}/comments", json={"content": "Elsewhere."})

    body = authorized_client.get(f"/posts/{other}/comments").json()
    assert body["total"] == 1
    assert body["items"][0]["content"] == "Elsewhere."


def test_a_post_with_nothing_said_about_it(client, test_posts):
    body = client.get(f"/posts/{test_posts[0].id}/comments").json()
    assert body == {
        "items": [],
        "total": 0,
        "page": 1,
        "page_size": 20,
        "pages": 0,
        "has_next": False,
        "has_prev": False,
    }


def test_comment_pagination_metadata(client, commented_post):
    post_id, said = commented_post

    first = client.get(f"/posts/{post_id}/comments", params={"page_size": 2}).json()
    assert [c["id"] for c in first["items"]] == [said[0]["id"], said[1]["id"]]
    assert (first["total"], first["pages"]) == (3, 2)
    assert first["has_next"] is True
    assert first["has_prev"] is False

    second = client.get(
        f"/posts/{post_id}/comments", params={"page": 2, "page_size": 2}
    ).json()
    assert [c["id"] for c in second["items"]] == [said[2]["id"]]
    assert second["has_next"] is False
    assert second["has_prev"] is True


def test_comments_written_in_the_same_instant_keep_their_order(
    authorized_client, test_posts
):
    """`now()` in Postgres is the *transaction's* clock, so a handful of
    comments inserted together can share a created_at to the microsecond. The
    id breaks the tie, which is the only reason the query orders by both."""
    post_id = test_posts[0].id
    lines = [f"line {n}" for n in range(5)]
    for line in lines:
        authorized_client.post(f"/posts/{post_id}/comments", json={"content": line})

    body = authorized_client.get(f"/posts/{post_id}/comments").json()
    assert [c["content"] for c in body["items"]] == lines


def test_cannot_read_comments_on_a_post_that_does_not_exist(client):
    assert client.get("/posts/88888/comments").status_code == 404


# ---------------------------------------------------------------------------
# Drafts — comments inherit the post's visibility, whole
# ---------------------------------------------------------------------------
def test_nobody_can_read_the_comments_on_someone_elses_draft(
    client, authorized_client, draft_post
):
    # 404 rather than 403 for the same reason GET /posts/{id} says 404: a 403
    # would confirm there's a draft here to have opinions about.
    assert client.get(f"/posts/{draft_post.id}/comments").status_code == 404
    assert authorized_client.get(f"/posts/{draft_post.id}/comments").status_code == 404


def test_nobody_can_comment_on_someone_elses_draft(authorized_client, draft_post):
    res = authorized_client.post(
        f"/posts/{draft_post.id}/comments", json={"content": "Saw this, did you?"}
    )
    assert res.status_code == 404


def test_the_author_can_comment_on_their_own_draft(authorized_client, own_draft):
    draft_id = own_draft.id
    res = authorized_client.post(
        f"/posts/{draft_id}/comments", json={"content": "Note to self."}
    )
    assert res.status_code == 201
    assert authorized_client.get(f"/posts/{draft_id}/comments").json()["total"] == 1


def test_unpublishing_a_post_takes_its_comments_out_of_reach(
    authorized_client, anonymous_client, test_posts
):
    post_id = test_posts[0].id
    authorized_client.post(f"/posts/{post_id}/comments", json={"content": "Public."})
    assert anonymous_client.get(f"/posts/{post_id}/comments").status_code == 200

    authorized_client.patch(f"/posts/{post_id}", json={"published": False})
    assert anonymous_client.get(f"/posts/{post_id}/comments").status_code == 404


# ---------------------------------------------------------------------------
# Deleting one
# ---------------------------------------------------------------------------
def test_delete_your_own_comment(authorized_client, test_posts, session):
    created = authorized_client.post(
        f"/posts/{test_posts[0].id}/comments", json={"content": "On reflection, no."}
    ).json()

    assert authorized_client.delete(f"/comments/{created['id']}").status_code == 204
    assert (
        session.scalar(select(models.Comment).where(models.Comment.id == created["id"]))
        is None
    )


def test_cannot_delete_someone_elses_comment(
    authorized_client, test_posts, test_user2, session
):
    """Somebody else's comment, on somebody else's post — nothing about this
    is the caller's."""
    theirs = models.Comment(
        post_id=test_posts[3].id, user_id=test_user2["id"], content="Mine, thanks."
    )
    session.add(theirs)
    session.commit()
    comment_id = theirs.id

    assert authorized_client.delete(f"/comments/{comment_id}").status_code == 403


def test_the_post_author_cannot_delete_comments_on_their_post(
    authorized_client, commented_post, test_user2
):
    """The post is the caller's; the comment on it is not. Owning the room is
    not the same as owning what was said in it — see delete_comment."""
    _post_id, said = commented_post
    assert said[0]["user_id"] == test_user2["id"]

    assert authorized_client.delete(f"/comments/{said[0]['id']}").status_code == 403


def test_anonymous_cannot_delete_a_comment(client, commented_post):
    _post_id, said = commented_post
    assert client.delete(f"/comments/{said[0]['id']}").status_code == 401


def test_delete_a_comment_that_does_not_exist(authorized_client):
    assert authorized_client.delete("/comments/88888").status_code == 404


# ---------------------------------------------------------------------------
# Cascades — the half you only find out about by actually deleting something
# ---------------------------------------------------------------------------
def test_deleting_a_post_deletes_its_comments(
    authorized_client, commented_post, session
):
    post_id, said = commented_post
    ids = [r["id"] for r in said]

    assert authorized_client.delete(f"/posts/{post_id}").status_code == 204

    session.expire_all()
    left = session.scalars(
        select(models.Comment).where(models.Comment.id.in_(ids))
    ).all()
    assert left == []


def test_deleting_a_post_leaves_comments_on_other_posts_alone(
    authorized_client, commented_post, test_posts, session
):
    doomed, _said = commented_post
    survivor = authorized_client.post(
        f"/posts/{test_posts[1].id}/comments", json={"content": "Still here."}
    ).json()

    authorized_client.delete(f"/posts/{doomed}")

    session.expire_all()
    assert (
        session.scalar(
            select(models.Comment).where(models.Comment.id == survivor["id"])
        )
        is not None
    )


def test_deleting_a_user_deletes_their_comments(commented_post, test_user2, session):
    """There's no endpoint for this — accounts are removed by hand or by a data
    request — which is exactly why the rule lives in the schema rather than in
    a route that could forget to run it."""
    _post_id, said = commented_post
    theirs = [r["id"] for r in said if r["user_id"] == test_user2["id"]]
    mine = [r["id"] for r in said if r["user_id"] != test_user2["id"]]
    assert theirs and mine  # the fixture is doing what this test assumes

    session.delete(
        session.scalar(select(models.User).where(models.User.id == test_user2["id"]))
    )
    session.commit()
    session.expire_all()

    still_there = {c.id for c in session.scalars(select(models.Comment)).all()}
    assert still_there.isdisjoint(theirs)
    assert still_there.issuperset(mine)
