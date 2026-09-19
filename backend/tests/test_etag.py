"""Conditional requests on the feed.

What is being pinned here is not "a header appears". It is the three ways a
validator can be wrong, each of which is worse than not having one:

  · it doesn't change when the answer changes — a reader is served a stale feed
    for ever and has no way to ask for a fresh one;
  · it is the same for two people who should see different answers — one
    reader's drafts reach another;
  · the 304 carries something it shouldn't, and a client waits for a body that
    is never sent.

See app/etag.py for what this saves, which is bytes and not database work.
"""

from backend.app import models


def etag_of(res) -> str:
    tag = res.headers["ETag"]
    assert tag.startswith('W/"'), "weak: nothing here promises byte-identical JSON"
    return tag


def test_the_feed_carries_a_validator(client, test_posts):
    res = client.get("/posts/")
    assert res.status_code == 200
    etag_of(res)


def test_handing_it_back_gets_a_304(client, test_posts):
    tag = etag_of(client.get("/posts/"))

    res = client.get("/posts/", headers={"If-None-Match": tag})

    assert res.status_code == 304
    assert res.content == b""
    # The validator comes back with the 304, or a client that keeps only what
    # the last response told it has nothing to ask with next time.
    assert res.headers["ETag"] == tag


def test_a_304_does_not_describe_a_body_it_is_not_sending(client, test_posts):
    """`Content-Length` describing bytes that never arrive is how a connection
    hangs. It has to be dropped rather than left over from the response the
    fingerprint was taken from."""
    tag = etag_of(client.get("/posts/"))

    res = client.get("/posts/", headers={"If-None-Match": tag})

    assert "content-length" not in {k.lower() for k in res.headers}


def test_it_changes_when_the_feed_does(client, test_posts, session, test_user):
    tag = etag_of(client.get("/posts/"))

    session.add(models.Post(title="new", content="arrived", user_id=test_user["id"]))
    session.commit()

    res = client.get("/posts/", headers={"If-None-Match": tag})
    assert res.status_code == 200
    assert res.headers["ETag"] != tag


def test_it_changes_when_a_post_is_edited(client, test_posts, session):
    """The case a naive validator gets wrong. Nothing was added or removed, so
    anything counting rows would answer "unchanged" and serve the old title for
    as long as the reader kept asking."""
    tag = etag_of(client.get("/posts/"))

    post = session.get(models.Post, test_posts[0].id)
    post.title = "thought better of it"
    session.commit()

    assert client.get("/posts/", headers={"If-None-Match": tag}).status_code == 200


def test_it_changes_when_a_vote_lands(client, authorized_client, test_posts, test_user):
    """Votes are not columns on the post — they are counted into the response —
    so a validator taken from the row would miss this entirely."""
    tag = etag_of(client.get("/posts/"))

    assert (
        authorized_client.post(
            "/vote/", json={"post_id": test_posts[0].id, "dir": 1}
        ).status_code
        == 201
    )

    assert client.get("/posts/", headers={"If-None-Match": tag}).status_code == 200


def test_two_readers_who_see_different_feeds_get_different_validators(
    authorized_client, anonymous_client, test_posts, own_draft
):
    """The feed is not the same answer for everyone: a draft is returned only to
    its author. So the author's validator must not match the visitor's, or a
    304 would tell the visitor that the feed they have is current when it is
    somebody else's.

    Note what this is *not* asserting. Two readers whose answers are
    byte-identical — nobody has voted, nobody has a draft — do share a
    validator, and that is correct: the fingerprint describes the response, and
    identical responses are interchangeable by definition. Insisting they
    differ would be insisting on a property nothing needs.
    """
    mine = etag_of(authorized_client.get("/posts/"))
    theirs = etag_of(anonymous_client.get("http://testserver/api/v1/posts/"))

    assert mine != theirs
    # And presenting one to the other is not a match: the visitor is told to
    # take the four published posts rather than being left holding five.
    res = anonymous_client.get(
        "http://testserver/api/v1/posts/", headers={"If-None-Match": mine}
    )
    assert res.status_code == 200
    assert res.json()["total"] == 4


def test_it_says_so_to_anything_caching_in_between(client, test_posts):
    """Without `Vary`, a shared cache is entitled to hand the answer it has to
    the next person who asks, whoever they are."""
    assert client.get("/posts/").headers["Vary"] == "Authorization"


def test_a_search_gets_its_own(client, test_posts):
    assert etag_of(client.get("/posts/")) != etag_of(client.get("/posts/?search=first"))


def test_a_star_matches_anything(client, test_posts):
    """`If-None-Match: *` is in the spec and costs one branch to honour. This
    app's own client never sends it; something else's might."""
    assert client.get("/posts/", headers={"If-None-Match": "*"}).status_code == 304


def test_one_of_several_offered_validators_is_enough(client, test_posts):
    tag = etag_of(client.get("/posts/"))

    res = client.get("/posts/", headers={"If-None-Match": f'W/"nonsense", {tag}'})

    assert res.status_code == 304


def test_a_stale_validator_is_simply_ignored(client, test_posts):
    res = client.get("/posts/", headers={"If-None-Match": 'W/"something-else"'})

    assert res.status_code == 200
    assert res.json()["total"] == 4


def test_a_write_is_never_answered_conditionally(authorized_client, test_posts):
    """Only GET. A conditional POST would be a very quiet way to drop
    somebody's post on the floor."""
    tag = etag_of(authorized_client.get("/posts/"))

    res = authorized_client.post(
        "/posts/",
        json={"title": "written anyway", "content": "and saved"},
        headers={"If-None-Match": tag},
    )

    assert res.status_code == 201


def test_a_404_is_not_fingerprinted(client):
    res = client.get("/posts/999999")

    assert res.status_code == 404
    assert "etag" not in {k.lower() for k in res.headers}


def test_the_security_headers_survive_a_304(client, test_posts):
    """The 304 is built by hand rather than returned from the handler, so it is
    the one response that could quietly lose them."""
    tag = etag_of(client.get("/posts/"))

    res = client.get("/posts/", headers={"If-None-Match": tag})

    assert res.status_code == 304
    assert res.headers["X-Content-Type-Options"] == "nosniff"
