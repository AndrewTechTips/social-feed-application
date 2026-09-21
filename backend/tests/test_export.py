"""Taking your writing with you.

One endpoint, one document, and the interesting thing about it is what it
refuses to leave out. An export is a promise that this is *everything*, so
every test below is about a way the promise could quietly be broken: a draft
missing because the public endpoints hide drafts, a comment missing because it
was left somewhere else, somebody else's writing swept in because the filter
was on the wrong column.

The response codes are the least of it.
"""

from sqlalchemy import select

from backend.app import models


def test_export_needs_an_account(client):
    """It has your email in it, so it is nobody else's to fetch."""
    res = client.get("/users/me/export")
    assert res.status_code == 401


def test_export_is_your_account_and_your_writing(authorized_client, test_user):
    res = authorized_client.get("/users/me/export")
    assert res.status_code == 200

    body = res.json()
    assert body["account"]["id"] == test_user["id"]
    assert body["account"]["username"] == test_user["username"]
    # The email is not on the public profile shape, and an export of your data
    # that omitted the one identifier you actually signed up with would be an
    # odd sort of export.
    assert body["email"] == test_user["email"]
    assert body["exported_at"]
    assert isinstance(body["posts"], list)
    assert isinstance(body["comments"], list)


def test_export_has_your_posts_and_only_yours(authorized_client, test_user, test_posts):
    body = authorized_client.get("/users/me/export").json()

    mine = [p for p in test_posts if p.user_id == test_user["id"]]
    assert len(body["posts"]) == len(mine)
    assert {p["id"] for p in body["posts"]} == {p.id for p in mine}
    # Somebody else's post exists in this database and must not be in here.
    assert all(p["user_id"] == test_user["id"] for p in body["posts"])


def test_export_includes_your_drafts(authorized_client, own_draft):
    """The one omission most likely to matter.

    `/users/{username}/posts` hides unpublished posts from everybody but their
    author, which is right for a public list and would have been the reason an
    export composed out of it quietly lost the thing you had not finished.
    Asking as yourself makes the question disappear.
    """
    body = authorized_client.get("/users/me/export").json()

    ids = {p["id"] for p in body["posts"]}
    assert own_draft.id in ids
    exported = next(p for p in body["posts"] if p["id"] == own_draft.id)
    assert exported["published"] is False
    assert exported["content"] == "mine, and not finished"


def test_export_excludes_somebody_elses_draft(authorized_client, draft_post):
    body = authorized_client.get("/users/me/export").json()
    assert draft_post.id not in {p["id"] for p in body["posts"]}


def test_export_has_your_comments_wherever_you_left_them(
    authorized_client, session, test_user, test_user2, test_posts
):
    """Including the ones on other people's posts, which is the whole point.

    There is no public "comments by one person" endpoint, and this is the
    reason the export is its own request rather than something a client
    assembles: from the outside there is no way to find what you said under
    somebody else's post.
    """
    theirs = next(p for p in test_posts if p.user_id == test_user2["id"])
    mine = next(p for p in test_posts if p.user_id == test_user["id"])

    session.add_all(
        [
            models.Comment(
                content="said on my own post",
                post_id=mine.id,
                user_id=test_user["id"],
            ),
            models.Comment(
                content="said on somebody else's",
                post_id=theirs.id,
                user_id=test_user["id"],
            ),
            models.Comment(
                content="not mine at all",
                post_id=mine.id,
                user_id=test_user2["id"],
            ),
        ]
    )
    session.commit()

    body = authorized_client.get("/users/me/export").json()
    said = {c["content"] for c in body["comments"]}

    assert said == {"said on my own post", "said on somebody else's"}


def test_exported_comments_carry_the_post_they_were_left_on(
    authorized_client, session, test_user, test_posts
):
    """A comment exported as text plus an id is a line nobody can resolve once
    the file has left the app."""
    post = next(p for p in test_posts if p.user_id == test_user["id"])
    session.add(
        models.Comment(
            content="a thing I said", post_id=post.id, user_id=test_user["id"]
        )
    )
    session.commit()

    body = authorized_client.get("/users/me/export").json()
    comment = next(c for c in body["comments"] if c["content"] == "a thing I said")

    assert comment["post_id"] == post.id
    assert comment["post_title"] == post.title
    assert comment["parent_id"] is None


def test_exported_reply_says_what_it_answered(
    authorized_client, session, test_user, test_posts
):
    post = next(p for p in test_posts if p.user_id == test_user["id"])
    parent = models.Comment(
        content="the opening line", post_id=post.id, user_id=test_user["id"]
    )
    session.add(parent)
    session.commit()
    session.refresh(parent)

    session.add(
        models.Comment(
            content="answering myself",
            post_id=post.id,
            user_id=test_user["id"],
            parent_id=parent.id,
        )
    )
    session.commit()

    body = authorized_client.get("/users/me/export").json()
    reply = next(c for c in body["comments"] if c["content"] == "answering myself")
    assert reply["parent_id"] == parent.id


def test_export_of_a_new_account_is_empty_but_well_formed(authorized_client, test_user):
    """Nothing written yet is a state, not an error — and a file with two empty
    lists in it is still a file somebody can open."""
    body = authorized_client.get("/users/me/export").json()

    assert body["posts"] == []
    assert body["comments"] == []
    assert body["account"]["username"] == test_user["username"]


def test_export_is_not_paged(authorized_client, session, test_user):
    """An export arrives whole or it is not an export.

    Twenty-five posts against a default page size of ten: anything that had
    quietly grown a page boundary would hand back the first page and look
    complete.
    """
    session.add_all(
        [
            models.Post(title=f"post {n}", content="...", user_id=test_user["id"])
            for n in range(25)
        ]
    )
    session.commit()

    body = authorized_client.get("/users/me/export").json()
    assert len(body["posts"]) == 25
    # And no envelope — `page`, `pages` and `has_next` would each be a promise
    # that there is more somewhere.
    assert "page" not in body
    assert "has_next" not in body


def test_export_does_not_outlive_the_account(
    authorized_client, session, test_user, test_posts
):
    """Deleting the account takes the writing with it, so the export goes too.

    Not a feature of the export — a check that it is reading live rows rather
    than anything cached — and the 401 afterwards is the account being gone
    rather than the endpoint being fussy.
    """
    assert authorized_client.get("/users/me/export").json()["posts"]

    assert authorized_client.delete("/users/me").status_code == 204
    assert authorized_client.get("/users/me/export").status_code == 401

    left = session.scalars(
        select(models.Post).where(models.Post.user_id == test_user["id"])
    ).all()
    assert left == []
