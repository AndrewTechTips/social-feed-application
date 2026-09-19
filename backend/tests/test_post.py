import pytest

from backend.app import schemas


# ---------------------------------------------------------------------------
# Reading the feed (now public)
# ---------------------------------------------------------------------------
def test_anonymous_can_get_all_posts(client, test_posts):
    res = client.get("/posts/")
    assert res.status_code == 200

    page = schemas.PostPage.model_validate(res.json())
    assert page.total == len(test_posts)
    assert len(page.items) == len(test_posts)
    assert {p.id for p in page.items} == {p.id for p in test_posts}


def test_authorized_user_get_all_posts(authorized_client, test_posts):
    res = authorized_client.get("/posts/")
    assert res.status_code == 200
    assert res.json()["total"] == len(test_posts)


def test_posts_pagination_metadata(client, test_posts):
    first = client.get("/posts/", params={"page": 1, "page_size": 2}).json()
    assert len(first["items"]) == 2
    assert first["total"] == len(test_posts)
    assert first["pages"] == 2
    assert first["has_next"] is True
    assert first["has_prev"] is False

    second = client.get("/posts/", params={"page": 2, "page_size": 2}).json()
    assert len(second["items"]) == 2
    assert second["has_next"] is False
    assert second["has_prev"] is True

    # the two pages must not overlap
    assert {i["id"] for i in first["items"]}.isdisjoint(
        i["id"] for i in second["items"]
    )


def test_anonymous_can_get_one_post(client, test_posts):
    res = client.get(f"/posts/{test_posts[0].id}")
    assert res.status_code == 200

    post = schemas.PostOut(**res.json())
    assert post.id == test_posts[0].id
    assert post.title == test_posts[0].title
    assert post.votes == 0
    assert post.user.id == test_posts[0].user_id


def test_get_one_post_not_exist(client, test_posts):
    res = client.get("/posts/88888")
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Creating
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "title, content, published",
    [
        ("awesome new title", "awesome new content", True),
        ("favorite pizza", "i love pepperoni", False),
        ("tallest skyscrapers", "wahoooya", True),
    ],
)
def test_create_post(authorized_client, test_user, title, content, published):
    res = authorized_client.post(
        "/posts/", json={"title": title, "content": content, "published": published}
    )
    assert res.status_code == 201

    created = schemas.PostOut(**res.json())
    assert created.title == title
    assert created.content == content
    assert created.published == published
    assert created.user_id == test_user["id"]
    assert created.votes == 0


def test_create_post_default_published_true(authorized_client):
    res = authorized_client.post(
        "/posts/", json={"title": "arbitrary title", "content": "Karaganda"}
    )
    assert res.status_code == 201
    assert schemas.PostOut(**res.json()).published is True


def test_unauthorized_user_create_posts(client):
    res = client.post("/posts/", json={"title": "x", "content": "y"})
    assert res.status_code == 401


# ---------------------------------------------------------------------------
# Deleting
# ---------------------------------------------------------------------------
def test_unauthorized_user_delete_post(client, test_posts):
    res = client.delete(f"/posts/{test_posts[0].id}")
    assert res.status_code == 401


def test_delete_post_success(authorized_client, test_posts):
    res = authorized_client.delete(f"/posts/{test_posts[0].id}")
    assert res.status_code == 204


def test_delete_post_non_exist(authorized_client, test_posts):
    res = authorized_client.delete("/posts/88888")
    assert res.status_code == 404


def test_delete_other_user_post(authorized_client, test_posts):
    res = authorized_client.delete(f"/posts/{test_posts[3].id}")
    assert res.status_code == 403


# ---------------------------------------------------------------------------
# Updating - PUT (full replace)
# ---------------------------------------------------------------------------
def test_update_post_put(authorized_client, test_posts):
    data = {"title": "updated title", "content": "updated content"}
    res = authorized_client.put(f"/posts/{test_posts[0].id}", json=data)
    assert res.status_code == 200

    updated = schemas.PostOut(**res.json())
    assert updated.title == data["title"]
    assert updated.content == data["content"]


def test_update_other_user_post(authorized_client, test_posts):
    res = authorized_client.put(
        f"/posts/{test_posts[3].id}", json={"title": "x", "content": "y"}
    )
    assert res.status_code == 403


def test_unauthorized_user_update_post(client, test_posts):
    res = client.put(f"/posts/{test_posts[0].id}", json={"title": "x", "content": "y"})
    assert res.status_code == 401


def test_update_post_non_exist(authorized_client, test_posts):
    res = authorized_client.put("/posts/88888", json={"title": "x", "content": "y"})
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Updating - PATCH (partial)
# ---------------------------------------------------------------------------
def test_patch_post_partial(authorized_client, test_posts):
    original = test_posts[0]
    res = authorized_client.patch(
        f"/posts/{original.id}", json={"title": "patched title"}
    )
    assert res.status_code == 200

    patched = schemas.PostOut(**res.json())
    assert patched.title == "patched title"
    assert patched.content == original.content  # not sent -> unchanged


def test_patch_post_empty_body(authorized_client, test_posts):
    res = authorized_client.patch(f"/posts/{test_posts[0].id}", json={})
    assert res.status_code == 400


def test_patch_other_user_post(authorized_client, test_posts):
    res = authorized_client.patch(f"/posts/{test_posts[3].id}", json={"title": "nope"})
    assert res.status_code == 403


# ── holding the window still ───────────────────────────────────────────────
#
# `quote` on every anchor below, and it is not ceremony: a Postgres timestamp
# serialises with a `+03:00` offset, and a bare `+` in a query string decodes to
# a space. Unencoded, every one of these is a 422 about "unexpected extra
# characters". URLSearchParams gets this right on its own, which is why the app
# never trips on it and a hand-written curl does.
#
# Offset pagination counts from the top, so a post written between one page and
# the next pushes every later page down by one. ADR 0005 names that as a known
# cost and judged it not worth paying for — right up until something started
# inserting rows into a feed while it was being read. `as_of` is the amendment.


def test_as_of_keeps_a_post_written_mid_scroll_out_of_the_later_pages(
    authorized_client, test_posts
):
    from urllib.parse import quote

    first = authorized_client.get("/posts/?page=1&page_size=2").json()
    assert len(first["items"]) == 2
    anchor = first["items"][0]["created_at"]
    seen = [item["id"] for item in first["items"]]

    # Somebody posts while the reader is still on page one.
    authorized_client.post("/posts/", json={"title": "brand new", "content": "hello"})

    # Without the anchor, page two starts one row later than it should and the
    # last card of page one comes back a second time.
    drifted = authorized_client.get("/posts/?page=2&page_size=2").json()
    assert seen[-1] in [item["id"] for item in drifted["items"]]

    # With it, the reader walks the feed as it stood when they arrived.
    held = authorized_client.get(
        f"/posts/?page=2&page_size=2&as_of={quote(anchor)}"
    ).json()
    assert not set(seen) & {item["id"] for item in held["items"]}


def test_as_of_narrows_the_total_to_the_window_it_names(authorized_client, test_posts):
    from urllib.parse import quote

    before = authorized_client.get("/posts/").json()
    anchor = before["items"][0]["created_at"]
    was = before["total"]

    authorized_client.post("/posts/", json={"title": "after", "content": "the anchor"})
    assert authorized_client.get("/posts/").json()["total"] == was + 1

    held = authorized_client.get(f"/posts/?as_of={quote(anchor)}").json()
    assert held["total"] == was
    assert all(item["created_at"] <= anchor for item in held["items"])


def test_as_of_is_optional_and_a_bad_one_is_a_422(authorized_client, test_posts):
    assert authorized_client.get("/posts/").status_code == 200
    assert authorized_client.get("/posts/?as_of=").status_code == 422
    assert authorized_client.get("/posts/?as_of=lunchtime").status_code == 422


def test_as_of_leaves_the_visibility_rules_alone(
    anonymous_client, authorized_client, own_draft
):
    """It is a window in time, not a second access rule: a draft stays its
    author's whether or not one is asked for.

    `anonymous_client` rather than `client`: authorized_client signs `client`
    in by mutating its headers and hands the same object back, so asking for
    both gets you two names for one signed-in client — which is precisely the
    thing this test would then fail to notice.
    """
    from urllib.parse import quote

    mine = authorized_client.get("/posts/").json()
    anchor = mine["items"][0]["created_at"]

    held = authorized_client.get(f"/posts/?as_of={quote(anchor)}").json()
    assert own_draft.id in [item["id"] for item in held["items"]]

    theirs = anonymous_client.get(f"/posts/?as_of={quote(anchor)}").json()
    assert own_draft.id not in [item["id"] for item in theirs["items"]]
