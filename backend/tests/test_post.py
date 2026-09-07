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
