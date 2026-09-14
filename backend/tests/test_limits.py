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
