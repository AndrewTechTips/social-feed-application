from app import schemas


def test_get_all_post(authorized_client, test_posts):
    res = authorized_client.get("/posts/")

    posts = [schemas.PostOut.model_validate(post) for post in res.json()]

    assert res.status_code == 200
    assert len(res.json()) == len(test_posts)
    assert sorted(p.Post.id for p in posts) == sorted(p.id for p in test_posts)


def test_unauthorized_user_get_all_posts(client, test_posts):
    res = client.get("/posts/")
    assert res.status_code == 401


def test_unauthorized_user_get_one_posts(client, test_posts):
    res = client.get(f"/posts/{test_posts[0].id}")
    assert res.status_code == 401


def test_get_one_post_not_exist(authorized_client, test_posts):
    res = authorized_client.get("/posts/23123")
    assert res.status_code == 404


def test_get_one_post(authorized_client, test_posts):
    res = authorized_client.get(f"/posts/{test_posts[0].id}")
    post = schemas.PostOut(**res.json())

    assert post.Post.id == test_posts[0].id
    assert post.Post.content == test_posts[0].content
    assert post.Post.title == test_posts[0].title
