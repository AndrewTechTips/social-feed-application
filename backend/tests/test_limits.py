"""The rate limits.

Every other test file runs with the limiter switched off — its state is an
in-process counter keyed by client address, so left on it would leak from one
test into the next and make the order matter. This file is the exception: it
turns the limiter back on and resets its storage around each test, which is
why the limits live here rather than alongside the endpoints they guard.
"""

import pytest

from backend.app.main import app
from backend.app.limiter import limiter


@pytest.fixture
def limited_client(client):
    """`client` with the limiter switched on and its counters empty."""
    limiter.reset()
    app.state.limiter.enabled = True
    yield client
    app.state.limiter.enabled = False
    limiter.reset()


def test_login_stops_after_five_attempts_a_minute(limited_client, test_user):
    """Five is the documented limit on /login — the one endpoint where an
    unlimited retry budget is a password-guessing budget."""
    bad = {"username": test_user["email"], "password": "wrong-password"}

    for attempt in range(5):
        res = limited_client.post("/login", data=bad)
        assert res.status_code == 401, f"attempt {attempt + 1} should still be allowed"

    res = limited_client.post("/login", data=bad)
    assert res.status_code == 429
    assert "Rate limit exceeded" in res.json()["detail"]


def test_the_limit_counts_attempts_not_failures(limited_client, test_user):
    """Correct credentials don't buy you a fresh budget — otherwise an attacker
    with one valid account could reset the counter at will."""
    good = {"username": test_user["email"], "password": test_user["password"]}

    for _ in range(5):
        assert limited_client.post("/login", data=good).status_code == 200

    assert limited_client.post("/login", data=good).status_code == 429


def test_signup_stops_after_ten_an_hour(limited_client):
    for i in range(10):
        res = limited_client.post(
            "/users/",
            json={
                "username": f"person{i}",
                "email": f"person{i}@example.com",
                "password": "password1234",
            },
        )
        assert res.status_code == 201, f"signup {i + 1} should still be allowed"

    res = limited_client.post(
        "/users/",
        json={
            "username": "onetoomany",
            "email": "one-too-many@example.com",
            "password": "password1234",
        },
    )
    assert res.status_code == 429


def test_a_429_is_json_not_an_html_error_page(limited_client, test_user):
    """The frontend reads `detail` off the body to show its "you're doing that
    a bit fast" line; slowapi's own default handler would hand back something
    else."""
    bad = {"username": test_user["email"], "password": "wrong-password"}
    for _ in range(6):
        res = limited_client.post("/login", data=bad)

    assert res.status_code == 429
    assert res.headers["content-type"].startswith("application/json")
    assert isinstance(res.json()["detail"], str)


def test_reading_the_feed_is_never_rate_limited(limited_client, test_posts):
    """The feed is the public front door and carries no limit by design."""
    for _ in range(20):
        assert limited_client.get("/posts/").status_code == 200


# — the writes ----------------------------------------------------------------
# Reads are never limited; the credential endpoints are tight because an
# unlimited retry budget there is a guessing budget; these bound the damage an
# automated client can do with a valid token. The numbers live in one place —
# app/limiter.py — so these read them from there rather than restating them,
# which means changing a limit doesn't silently leave a test asserting the old
# one.

import re

from backend.app import limiter as limits


def budget(rule: str) -> int:
    """`"30/hour"` → 30."""
    return int(re.match(r"\d+", rule).group())


def test_writing_posts_stops_at_the_limit(limited_client, token):
    limited_client.headers = {
        **limited_client.headers,
        "Authorization": f"Bearer {token}",
    }
    body = {"title": "again", "content": "and again"}

    for attempt in range(budget(limits.CREATE_POST)):
        res = limited_client.post("/posts/", json=body)
        assert res.status_code == 201, f"post {attempt + 1} should still be allowed"

    assert limited_client.post("/posts/", json=body).status_code == 429


def test_voting_stops_at_the_limit(limited_client, token, test_posts):
    """Voting is a keyboard action, so its limit is per *minute* and generous
    enough to clear a fast reader going down a page."""
    post_id = test_posts[0].id
    limited_client.headers = {
        **limited_client.headers,
        "Authorization": f"Bearer {token}",
    }

    # Toggling the same vote on and off is the cheapest way to spend a budget
    # without needing sixty posts, and it exercises both directions.
    for attempt in range(budget(limits.VOTE)):
        res = limited_client.post(
            "/vote/", json={"post_id": post_id, "dir": attempt % 2}
        )
        assert res.status_code in (201, 404), f"vote {attempt + 1} was refused"

    res = limited_client.post("/vote/", json={"post_id": post_id, "dir": 1})
    assert res.status_code == 429


def test_commenting_stops_at_the_limit(limited_client, token, test_posts):
    post_id = test_posts[0].id
    limited_client.headers = {
        **limited_client.headers,
        "Authorization": f"Bearer {token}",
    }

    for attempt in range(budget(limits.CREATE_COMMENT)):
        res = limited_client.post(
            f"/posts/{post_id}/comments", json={"content": f"number {attempt}"}
        )
        assert res.status_code == 201, f"comment {attempt + 1} should still be allowed"

    res = limited_client.post(
        f"/posts/{post_id}/comments", json={"content": "one more"}
    )
    assert res.status_code == 429


def test_saving_to_the_shelf_stops_at_the_limit(limited_client, token, test_posts):
    post_id = test_posts[0].id
    limited_client.headers = {
        **limited_client.headers,
        "Authorization": f"Bearer {token}",
    }

    for attempt in range(budget(limits.SHELVE)):
        res = limited_client.put(f"/posts/{post_id}/save")
        assert res.status_code == 204, f"save {attempt + 1} should still be allowed"

    assert limited_client.put(f"/posts/{post_id}/save").status_code == 429


def test_reading_your_shelf_is_never_rate_limited(limited_client, token):
    """Reads are free here for the same reason the feed's are."""
    limited_client.headers = {
        **limited_client.headers,
        "Authorization": f"Bearer {token}",
    }
    for _ in range(20):
        assert limited_client.get("/shelf").status_code == 200
