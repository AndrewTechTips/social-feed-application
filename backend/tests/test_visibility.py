"""Who can see an unpublished post.

`published` is an access rule, not a display hint. Before these tests the feed
filtered on the search term and nothing else, so every draft in the database —
anyone's — was readable by anyone, including callers with no token at all.
"""


# ---------------------------------------------------------------------------
# The feed
# ---------------------------------------------------------------------------
def test_anonymous_feed_hides_every_draft(client, test_posts, draft_post):
    res = client.get("/posts/")
    assert res.status_code == 200

    body = res.json()
    ids = {item["id"] for item in body["items"]}
    assert draft_post.id not in ids
    assert body["total"] == len(test_posts)
    assert all(item["published"] for item in body["items"])


def test_feed_hides_other_peoples_drafts(authorized_client, test_posts, draft_post):
    body = authorized_client.get("/posts/").json()
    assert draft_post.id not in {item["id"] for item in body["items"]}


def test_feed_shows_you_your_own_drafts(authorized_client, test_posts, own_draft):
    body = authorized_client.get("/posts/").json()
    assert own_draft.id in {item["id"] for item in body["items"]}
    assert body["total"] == len(test_posts) + 1


def test_your_own_drafts_are_yours_alone(client, test_posts, own_draft):
    """The same draft the author can see is invisible without their token."""
    body = client.get("/posts/").json()
    assert own_draft.id not in {item["id"] for item in body["items"]}


def test_draft_does_not_leak_through_search(client, draft_post):
    body = client.get("/posts/", params={"search": "quiet"}).json()
    assert body["total"] == 0
    assert body["items"] == []


def test_pagination_total_counts_only_visible_posts(client, test_posts, draft_post):
    """total drives the pager; counting invisible rows would produce an empty
    last page."""
    body = client.get("/posts/", params={"page": 1, "page_size": 2}).json()
    assert body["total"] == len(test_posts)
    assert body["pages"] == 2


# ---------------------------------------------------------------------------
# A single post
# ---------------------------------------------------------------------------
def test_anonymous_cannot_open_a_draft(client, draft_post):
    assert client.get(f"/posts/{draft_post.id}").status_code == 404


def test_other_user_cannot_open_a_draft(authorized_client, draft_post):
    # 404 rather than 403 on purpose: a 403 would confirm the post exists.
    assert authorized_client.get(f"/posts/{draft_post.id}").status_code == 404


def test_author_can_open_their_own_draft(authorized_client, own_draft):
    res = authorized_client.get(f"/posts/{own_draft.id}")
    assert res.status_code == 200
    assert res.json()["published"] is False


def test_a_junk_token_is_treated_as_anonymous_not_rejected(client, test_posts):
    """The feed is public, so a bad token must not turn a readable page into a
    401 — it just stops being a signed-in request."""
    client.headers = {**client.headers, "Authorization": "Bearer not-a-real-token"}
    res = client.get("/posts/")
    assert res.status_code == 200
    assert res.json()["total"] == len(test_posts)


# ---------------------------------------------------------------------------
# Voting
# ---------------------------------------------------------------------------
def test_cannot_vote_on_someone_elses_draft(authorized_client, draft_post):
    res = authorized_client.post("/vote/", json={"post_id": draft_post.id, "dir": 1})
    assert res.status_code == 404


def test_can_vote_on_your_own_draft(authorized_client, own_draft):
    res = authorized_client.post("/vote/", json={"post_id": own_draft.id, "dir": 1})
    assert res.status_code == 201


# ---------------------------------------------------------------------------
# Publishing state changes
# ---------------------------------------------------------------------------
def test_publishing_a_draft_puts_it_in_the_feed(
    authorized_client, anonymous_client, own_draft
):
    def visible_to_everyone():
        return {i["id"] for i in anonymous_client.get("/posts/").json()["items"]}

    assert own_draft.id not in visible_to_everyone()

    res = authorized_client.patch(f"/posts/{own_draft.id}", json={"published": True})
    assert res.status_code == 200

    assert own_draft.id in visible_to_everyone()


def test_unpublishing_takes_a_post_back_out_of_the_feed(
    authorized_client, anonymous_client, test_posts
):
    post_id = test_posts[0].id
    res = authorized_client.patch(f"/posts/{post_id}", json={"published": False})
    assert res.status_code == 200

    body = anonymous_client.get("/posts/").json()
    assert post_id not in {i["id"] for i in body["items"]}
    assert body["total"] == len(test_posts) - 1
