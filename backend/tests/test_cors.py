"""The CORS posture, now that there is a cookie behind it.

This file exists because `allow_credentials=True` changed what the origin list
is *for*. It used to be a courtesy — the API authenticated with a Bearer header,
which a browser never attaches on its own, so a permissive CORS config cost
nothing anyone could exploit. With a cookie in play the list is the boundary,
and the two failure modes are silent: a wildcard origin, and an origin that
crept onto the list because a test needed it.

Nothing here tests Starlette. It tests the configuration, which is the part
this repo owns and the part a refactor can quietly get wrong.
"""

from backend.app import main
from backend.app.oauth2 import CSRF_HEADER, REFRESH_COOKIE, REFRESH_COOKIE_PATH

ALLOWED = "http://localhost:5173"
STRANGER = "https://evil.example"


def preflight(client, origin: str, method: str = "POST", path: str = "/auth/refresh"):
    return client.options(
        path,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": f"content-type,{CSRF_HEADER.lower()}",
        },
    )


# ---------------------------------------------------------------------------
# Who is allowed to ask
# ---------------------------------------------------------------------------
def test_a_known_origin_is_allowed_with_credentials(client):
    res = preflight(client, ALLOWED)

    assert res.status_code == 200
    # Echoed, not wildcarded. With credentials on, a wildcard is not merely
    # lax — the fetch spec refuses it outright, so this is also what makes the
    # frontend work at all.
    assert res.headers["access-control-allow-origin"] == ALLOWED
    assert res.headers["access-control-allow-credentials"] == "true"
    assert CSRF_HEADER.lower() in res.headers["access-control-allow-headers"].lower()


def test_an_unknown_origin_is_not_allowed(client):
    res = preflight(client, STRANGER)
    assert "access-control-allow-origin" not in res.headers


def test_a_credentialed_response_never_carries_a_wildcard(client, test_user):
    """The one combination that would hand the session to anybody. Asserted on
    a real response rather than only on a preflight, because the header is sent
    on both and only one of them is usually looked at."""
    res = client.post(
        "/login",
        data={"username": test_user["email"], "password": test_user["password"]},
        headers={"Origin": ALLOWED},
    )
    assert res.headers["access-control-allow-origin"] == ALLOWED
    assert res.headers.get("access-control-allow-origin") != "*"


def test_the_origin_list_is_local_development_only(client):
    """A production origin appearing here would be the sort of thing nobody
    notices until it's a finding. There is no deployed frontend for this API;
    if that ever changes, this test is the place it has to be admitted."""
    for origin in main.origins:
        assert origin.startswith("http://localhost") or origin.startswith(
            "http://127.0.0.1"
        ), origin


def test_the_wildcard_is_not_in_the_list(client):
    assert "*" not in main.origins


# ---------------------------------------------------------------------------
# What the cookie is attached to
# ---------------------------------------------------------------------------
def test_the_refresh_cookie_is_never_sent_to_a_content_route(client, test_user):
    """The property that keeps this a bearer-header API with a cookie bolted
    on, rather than a cookie API. `Path=/auth` is what enforces it, and the
    cookie jar in the test client applies paths the same way a browser does —
    so this asserts the behaviour, not the flag.

    The path is read from oauth2 rather than written out: it moved once already,
    when the API gained its /api/v1 prefix, and a test holding its own copy of
    it would have gone on passing against a cookie the app no longer sets."""
    client.post(
        "/login",
        data={"username": test_user["email"], "password": test_user["password"]},
    )
    assert client.cookies.get(REFRESH_COOKIE, path=REFRESH_COOKIE_PATH)

    # A write without a Bearer token is a 401 even though the browser is
    # holding a live session, because the session is not something this route
    # can see. That is the whole point of the path scoping.
    assert (
        client.post("/posts/", json={"title": "x", "content": "y"}).status_code == 401
    )


def test_a_content_route_still_works_on_a_bearer_token_alone(
    authorized_client, test_user
):
    """And the flip side: nothing about the cookie work made the data plane
    depend on a cookie."""
    res = authorized_client.post("/posts/", json={"title": "x", "content": "y"})
    assert res.status_code == 201
