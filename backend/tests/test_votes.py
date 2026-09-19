import pytest

from backend.app import models


@pytest.fixture
def test_vote(test_posts, session, test_user):
    new_vote = models.Vote(post_id=test_posts[3].id, user_id=test_user["id"])
    session.add(new_vote)
    session.commit()


def test_vote_on_post(authorized_client, test_posts):
    res = authorized_client.post("/vote/", json={"post_id": test_posts[3].id, "dir": 1})

    assert res.status_code == 201


def test_vote_twice_post(authorized_client, test_posts, test_vote):
    res = authorized_client.post("/vote/", json={"post_id": test_posts[3].id, "dir": 1})

    assert res.status_code == 409


def test_delete_vote(authorized_client, test_posts, test_vote):
    res = authorized_client.post("/vote/", json={"post_id": test_posts[3].id, "dir": 0})

    assert res.status_code == 201


def test_delete_vote_non_exist(authorized_client, test_posts):
    res = authorized_client.post("/vote/", json={"post_id": test_posts[3].id, "dir": 0})

    assert res.status_code == 404


def test_vote_post_non_exist(authorized_client, test_posts):
    res = authorized_client.post("/vote/", json={"post_id": 80000, "dir": 1})

    assert res.status_code == 404


def test_vote_unauthorized_user(client, test_posts):
    res = client.post("/vote/", json={"post_id": test_posts[3].id, "dir": 1})

    assert res.status_code == 401


# ── "have I voted on this?" ────────────────────────────────────────────────
#
# The API used to have no way of answering that, so the frontend kept a set of
# post ids in localStorage and guessed — which meant your own votes were
# invisible on a second device, invisible in a private window, and wrong after
# clearing site data. These pin down the answer it gives now.


def _by_id(page, post_id):
    return next(item for item in page["items"] if item["id"] == post_id)


def test_voted_is_false_for_a_reader_who_isnt_signed_in(client, test_posts, test_vote):
    """The post *has* a vote; the person asking simply isn't the one who cast
    it. False rather than absent — a client should never have to tell "no"
    apart from "not told"."""
    voted_on = test_posts[3].id

    feed = client.get("/posts/").json()
    assert _by_id(feed, voted_on)["votes"] == 1
    assert _by_id(feed, voted_on)["voted"] is False

    one = client.get(f"/posts/{voted_on}").json()
    assert one["votes"] == 1
    assert one["voted"] is False


def test_voted_is_true_for_the_person_who_voted(
    authorized_client, test_posts, test_vote
):
    voted_on = test_posts[3].id

    feed = authorized_client.get("/posts/").json()
    assert _by_id(feed, voted_on)["voted"] is True
    # and only on that one
    assert all(
        item["voted"] is False for item in feed["items"] if item["id"] != voted_on
    )

    assert authorized_client.get(f"/posts/{voted_on}").json()["voted"] is True


def test_somebody_elses_vote_is_not_yours(
    authorized_client, client, test_posts, test_user2, session
):
    """The count is the room's and the flag is yours: same row, two answers."""
    voted_on = test_posts[3].id
    session.add(models.Vote(post_id=voted_on, user_id=test_user2["id"]))
    session.commit()

    mine = _by_id(authorized_client.get("/posts/").json(), voted_on)
    assert mine["votes"] == 1
    assert mine["voted"] is False


def test_voting_and_unvoting_move_the_flag(authorized_client, test_posts):
    post_id = test_posts[3].id
    assert authorized_client.get(f"/posts/{post_id}").json()["voted"] is False

    authorized_client.post("/vote/", json={"post_id": post_id, "dir": 1})
    after = authorized_client.get(f"/posts/{post_id}").json()
    assert (after["voted"], after["votes"]) == (True, 1)

    authorized_client.post("/vote/", json={"post_id": post_id, "dir": 0})
    back = authorized_client.get(f"/posts/{post_id}").json()
    assert (back["voted"], back["votes"]) == (False, 0)


def test_a_post_with_no_votes_at_all_answers_false_not_null(
    authorized_client, test_posts
):
    """The aggregate path's edge: a post nobody has voted on comes back from
    the outer join as one NULL row, over which bool_or is NULL rather than
    false. Uncoalesced, this field would be None and the schema would refuse
    it."""
    feed = authorized_client.get("/posts/").json()
    assert feed["total"] > 0
    assert all(item["votes"] == 0 for item in feed["items"])
    assert all(item["voted"] is False for item in feed["items"])


def test_a_profile_carries_it_too(authorized_client, test_posts, test_user, session):
    """Same page shape, same rules — a profile is the feed with one author in
    it, and it would be a strange place for the answer to change.

    Its own vote rather than the `test_vote` fixture's: that one is on
    test_posts[3], which belongs to test_user2 and so is on nobody's profile
    but theirs.
    """
    # Read before the request. The client fixture closes the session when the
    # request finishes, and every model instance goes detached with it.
    own_post = test_posts[0].id
    session.add(models.Vote(post_id=own_post, user_id=test_user["id"]))
    session.commit()

    page = authorized_client.get(f"/users/{test_user['username']}/posts").json()
    assert _by_id(page, own_post)["voted"] is True
    assert all(
        item["voted"] is False for item in page["items"] if item["id"] != own_post
    )


def test_a_post_you_just_wrote_is_not_one_you_voted_for(authorized_client):
    res = authorized_client.post(
        "/posts/", json={"title": "fresh", "content": "brand new"}
    )
    assert res.status_code == 201
    assert res.json()["voted"] is False
    assert res.json()["votes"] == 0


def test_editing_a_post_does_not_lose_the_flag(
    authorized_client, test_posts, test_user, session
):
    """PUT and PATCH answer with a PostOut too, and the owner is a reader like
    anyone else — the field has to survive a round trip through them.

    On test_posts[0], which is the caller's own: the other fixtures vote on
    test_posts[3], and editing somebody else's post is a 403 long before any
    of this matters.
    """
    post_id = test_posts[0].id
    session.add(models.Vote(post_id=post_id, user_id=test_user["id"]))
    session.commit()

    patched = authorized_client.patch(f"/posts/{post_id}", json={"title": "edited"})
    assert patched.status_code == 200
    assert patched.json()["voted"] is True

    replaced = authorized_client.put(
        f"/posts/{post_id}", json={"title": "replaced", "content": "again"}
    )
    assert replaced.status_code == 200
    assert replaced.json()["voted"] is True
