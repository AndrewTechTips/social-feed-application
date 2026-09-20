"""The shelf.

A set, not a log: the two things these tests care most about are that saving
twice is not an error and that the shelf comes back in the order things were
put on it, because those are the two places a "save for later" feature usually
goes wrong.
"""

import pytest

from backend.app import models


@pytest.fixture
def post_ids(test_posts):
    """The fixture posts' ids, read before any request runs.

    `test_posts` hands back ORM instances loaded in the session the `client`
    fixture then closes after each request, so touching `.id` on one of them
    later raises DetachedInstanceError. Every test here acts first and asserts
    afterwards, so it wants the numbers rather than the objects.
    """
    return [post.id for post in test_posts]


def save(client, post_id):
    return client.put(f"/posts/{post_id}/save")


def unsave(client, post_id):
    return client.delete(f"/posts/{post_id}/save")


# — saving --------------------------------------------------------------------


def test_saving_a_post_puts_it_on_your_shelf(authorized_client, post_ids):
    assert save(authorized_client, post_ids[0]).status_code == 204

    shelf = authorized_client.get("/shelf").json()
    assert shelf["total"] == 1
    assert shelf["items"][0]["id"] == post_ids[0]


def test_saving_twice_is_not_an_error(authorized_client, post_ids):
    """A shelf is a set. The second press asks for the state you're already in,
    and answering 409 would make the client treat one of its own errors as
    success — which is exactly the wart voting has."""
    assert save(authorized_client, post_ids[0]).status_code == 204
    assert save(authorized_client, post_ids[0]).status_code == 204

    assert authorized_client.get("/shelf").json()["total"] == 1


def test_unsaving_something_you_never_saved_is_not_an_error(
    authorized_client, post_ids
):
    assert unsave(authorized_client, post_ids[0]).status_code == 204
    assert authorized_client.get("/shelf").json()["total"] == 0


def test_unsaving_a_post_that_does_not_exist_is_still_204(authorized_client):
    """There is nothing here worth reporting as missing: the post not existing
    and you not having saved it end in the same place."""
    assert unsave(authorized_client, 999_999).status_code == 204


def test_saving_and_unsaving_round_trips(authorized_client, post_ids):
    save(authorized_client, post_ids[0])
    save(authorized_client, post_ids[1])
    unsave(authorized_client, post_ids[0])

    shelf = authorized_client.get("/shelf").json()
    assert [item["id"] for item in shelf["items"]] == [post_ids[1]]


# — who may --------------------------------------------------------------------


@pytest.mark.parametrize("method", ["put", "delete"])
def test_the_shelf_needs_a_token(client, post_ids, method):
    res = getattr(client, method)(f"/posts/{post_ids[0]}/save")
    assert res.status_code == 401


def test_reading_your_shelf_needs_a_token(client):
    assert client.get("/shelf").status_code == 401


def test_you_cannot_save_somebody_elses_draft(
    authorized_client, session, test_user2, test_posts
):
    """404, not 403 — the same answer reading it gives, so the shelf can't be
    used to confirm that a draft exists."""
    draft = models.Post(
        title="not yours",
        content="not yet",
        published=False,
        user_id=test_user2["id"],
    )
    session.add(draft)
    session.commit()
    session.refresh(draft)

    assert save(authorized_client, draft.id).status_code == 404


def test_you_can_save_your_own_draft(authorized_client, session, test_user):
    draft = models.Post(
        title="mine", content="not yet", published=False, user_id=test_user["id"]
    )
    session.add(draft)
    session.commit()
    session.refresh(draft)

    assert save(authorized_client, draft.id).status_code == 204
    assert authorized_client.get("/shelf").json()["total"] == 1


def test_a_post_unpublished_by_its_author_leaves_a_stranger_s_shelf(
    authorized_client, session, test_user2
):
    """Filtered on read rather than cleaned up on write, so nothing has to
    remember to run when somebody else changes their mind."""
    post = models.Post(title="theirs", content="here", user_id=test_user2["id"])
    session.add(post)
    session.commit()
    post_id = post.id

    save(authorized_client, post_id)
    assert authorized_client.get("/shelf").json()["total"] == 1

    session.get(models.Post, post_id).published = False
    session.commit()

    assert authorized_client.get("/shelf").json()["total"] == 0
    # The row is still there — nothing deleted it, it simply isn't visible.
    assert session.query(models.Save).count() == 1


def test_a_deleted_post_falls_off_the_shelf(authorized_client, post_ids, session):
    """By ON DELETE CASCADE at the database, so it holds whoever deletes."""
    save(authorized_client, post_ids[0])
    assert authorized_client.get("/shelf").json()["total"] == 1

    session.delete(session.get(models.Post, post_ids[0]))
    session.commit()

    assert authorized_client.get("/shelf").json()["total"] == 0


def test_a_deleted_account_takes_its_shelf_with_it(
    authorized_client, post_ids, session, test_user
):
    save(authorized_client, post_ids[0])
    assert session.query(models.Save).count() == 1

    session.delete(session.get(models.User, test_user["id"]))
    session.commit()

    assert session.query(models.Save).count() == 0


# — order and pagination -------------------------------------------------------


def test_the_shelf_is_ordered_by_when_you_saved_not_when_it_was_written(
    authorized_client, post_ids
):
    """The difference between a shelf and a feed: what you put there last is
    what you meant to read next."""
    save(authorized_client, post_ids[0])
    save(authorized_client, post_ids[2])
    save(authorized_client, post_ids[1])

    order = [item["id"] for item in authorized_client.get("/shelf").json()["items"]]
    assert order == [post_ids[1], post_ids[2], post_ids[0]]


def test_the_shelf_paginates_in_shelf_order(authorized_client, post_ids):
    """The page boundary has to be drawn in the order the screen shows, or page
    two is a different list from the bottom of page one."""
    for post_id in post_ids:
        save(authorized_client, post_id)

    newest_first = list(reversed(post_ids))

    first = authorized_client.get("/shelf", params={"page": 1, "page_size": 2}).json()
    second = authorized_client.get("/shelf", params={"page": 2, "page_size": 2}).json()

    assert [item["id"] for item in first["items"]] == newest_first[:2]
    assert [item["id"] for item in second["items"]] == newest_first[2:4]
    assert first["total"] == second["total"] == len(post_ids)
    assert first["has_next"] is True
    assert second["has_prev"] is True


def test_an_empty_shelf_is_an_empty_page_not_an_error(authorized_client):
    shelf = authorized_client.get("/shelf").json()
    assert shelf["items"] == []
    assert shelf["total"] == 0
    assert shelf["pages"] == 0
    assert shelf["has_next"] is False


# — the `saved` flag on a post -------------------------------------------------


def test_saved_is_false_for_an_anonymous_reader(client, test_posts):
    feed = client.get("/posts/").json()
    assert all(item["saved"] is False for item in feed["items"])


def test_saved_tells_the_feed_what_is_on_your_shelf(authorized_client, post_ids):
    save(authorized_client, post_ids[1])

    feed = authorized_client.get("/posts/").json()
    by_id = {item["id"]: item["saved"] for item in feed["items"]}

    assert by_id[post_ids[1]] is True
    assert by_id[post_ids[0]] is False


def test_saved_is_on_a_single_post_too(authorized_client, post_ids):
    post_id = post_ids[0]
    assert authorized_client.get(f"/posts/{post_id}").json()["saved"] is False

    save(authorized_client, post_id)
    assert authorized_client.get(f"/posts/{post_id}").json()["saved"] is True


def test_saved_is_about_the_pair_not_the_post(
    authorized_client, anonymous_client, post_ids, test_user2
):
    """One row answers differently for two people, which is why it can't be a
    column."""
    from backend.app.oauth2 import create_access_token

    save(authorized_client, post_ids[0])

    token = create_access_token({"user_id": test_user2["id"]})
    other = {"Authorization": f"Bearer {token}"}
    feed = anonymous_client.get("/posts/", headers=other).json()
    assert all(item["saved"] is False for item in feed["items"])


def test_a_brand_new_post_is_on_nobody_s_shelf(authorized_client):
    created = authorized_client.post(
        "/posts/", json={"title": "fresh", "content": "just written"}
    )
    assert created.status_code == 201
    assert created.json()["saved"] is False


def test_the_vote_count_survives_the_saved_join(
    authorized_client, test_posts, test_user2, session
):
    """A second join against the votes the feed already counts would multiply
    the rows; EXISTS is what keeps the tally honest."""
    post_id = test_posts[0].id
    session.add(models.Vote(user_id=test_user2["id"], post_id=post_id))
    session.commit()

    save(authorized_client, post_id)

    item = next(
        i
        for i in authorized_client.get("/posts/").json()["items"]
        if i["id"] == post_id
    )
    assert item["votes"] == 1
    assert item["saved"] is True
