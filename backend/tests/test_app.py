"""App-level concerns: the headers every response carries, and liveness.

`/healthz` is asked for absolutely rather than relatively. The `client` fixture
is based at the API prefix so that every other test can write the path it is
actually testing, and the liveness probe is one of the two routes deliberately
left outside it — it is asked for by whatever is running the container, and it
has to keep answering across a version bump.
"""

HEALTHZ = "http://testserver/healthz"

import pytest


def test_healthz_is_open_and_cheap(client):
    res = client.get(HEALTHZ)
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "header, value",
    [
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
    ],
)
def test_security_headers_are_on_every_response(client, header, value):
    assert client.get(HEALTHZ).headers[header] == value
    assert client.get("/posts/").headers[header] == value


def test_security_headers_survive_an_error_response(client):
    res = client.get("/posts/999999")
    assert res.status_code == 404
    assert res.headers["X-Content-Type-Options"] == "nosniff"


def test_hsts_is_not_asserted_outside_production(client):
    """Sending HSTS from a development server pins localhost to https in the
    browser's cache for a year, which is a genuinely annoying thing to undo."""
    assert "Strict-Transport-Security" not in client.get(HEALTHZ).headers


def test_hsts_is_asserted_in_production(client, monkeypatch):
    from backend.app import main

    monkeypatch.setattr(main.settings, "environment", "production")
    res = client.get(HEALTHZ)
    assert res.headers["Strict-Transport-Security"] == (
        "max-age=31536000; includeSubDomains"
    )


# ---------------------------------------------------------------------------
# Where the API lives
# ---------------------------------------------------------------------------
# The prefix is derived from one constant, so a test that also reads that
# constant would pass no matter what it said. These write the paths out by
# hand: the point is what goes over the wire, not that two lines of Python
# agree with each other. See docs/adr/0009-a-version-in-the-path.md.
ROOT = "http://testserver"


def test_the_api_is_served_under_the_version(anonymous_client):
    assert anonymous_client.get(f"{ROOT}/api/v1/posts/").status_code == 200


def test_the_unversioned_path_is_not_served(anonymous_client):
    """A clean move, not an alias. If this ever answers 200, somebody has added
    a compatibility shim — which is a fine thing to add, and a thing ADR 0009
    says to amend the policy for rather than do quietly."""
    assert anonymous_client.get(f"{ROOT}/posts/").status_code == 404


def test_liveness_is_deliberately_outside_it(anonymous_client):
    """`/healthz` is asked for by whatever is running the container, not by a
    client of the API. A probe that moves with the API version breaks a
    deployment on the day that is least welcome."""
    assert anonymous_client.get(f"{ROOT}/healthz").status_code == 200
    assert anonymous_client.get(f"{ROOT}/api/v1/healthz").status_code == 404


def test_the_refresh_cookie_is_scoped_to_the_versioned_auth_path(client, test_user):
    """The cost ADR 0009 records. The cookie's Path moved with the prefix, and a
    browser only sends a cookie to the path it was issued for — so this is the
    line that decided every session issued beforehand would stop being sent."""
    res = client.post(
        "/login",
        data={"username": test_user["email"], "password": test_user["password"]},
    )
    assert res.status_code == 200
    cookie = next(
        v.decode()
        for k, v in res.headers.raw
        if k.decode().lower() == "set-cookie"
        and v.decode().startswith("commons_refresh")
    )
    assert "Path=/api/v1/auth" in cookie


def test_the_docs_authorize_button_points_at_the_right_login(anonymous_client):
    """`tokenUrl` is relative and resolved against the docs page, so it carries
    no leading slash. Get it wrong and everything works except the Authorize
    button in /docs, which is the kind of breakage nobody notices for a month."""
    spec = anonymous_client.get(f"{ROOT}/openapi.json").json()
    flows = spec["components"]["securitySchemes"]["OAuth2PasswordBearer"]["flows"]
    assert flows["password"]["tokenUrl"] == "api/v1/login"
